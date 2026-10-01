import { createCipheriv, createECDH, createPrivateKey, createPublicKey, ECDH, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { EXPRESSIONS } from './loop-tools.ts';
import { isoAt } from './nightly.ts';
import { DEFAULT_SELF } from './prompts.ts';
import { pushAlert, type PushEvent } from './push.ts';
import { PUSH_TEXT_MAX_CHARS, pushPlaintext } from './push-crypto.ts';

/**
 * Web Push to the browsers that are away (ADR 0065): the alerts the iPhone gets (ADR 0029), encrypted to the browser's
 * subscription with aes128gcm (RFC 8291) and sent with a VAPID token (RFC 8292). Like APNs, it is written here with
 * node:crypto rather than taken as a dependency.
 */

/** The file in the state directory that holds the server's VAPID private key. */
export const VAPID_KEY_FILE = 'web-push-key.pem';
/** One record of rs 4096 holds this much: 4096 less the header (86), the tag (16) and the padding delimiter (1). */
export const WEB_PUSH_PLAINTEXT_MAX_BYTES = 3993;
/** How long a push service keeps a push for a browser that is offline. */
const TTL_SECONDS = 24 * 3600;
const RECORD_SIZE = 4096;
const CURVE = 'prime256v1';
const REQUEST_TIMEOUT_MS = 30_000;

export interface VapidKey { key: KeyObject; /** The public key as the browser takes it: uncompressed P-256, base64url. */ publicKey: string }

/** The VAPID key, made once on the first start and kept (0600); an unreadable one stops the start rather than silently replacing it. */
export async function loadVapidKey(file: string): Promise<VapidKey> {
  let key: KeyObject;
  try { key = createPrivateKey(await readFile(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('web push: the stored VAPID key cannot be used');
    key = generateKeyPairSync('ec', { namedCurve: CURVE }).privateKey;
    try {
      await writeFile(file, key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadVapidKey(file);
      throw new Error('web push: the VAPID key cannot be stored');
    }
  }
  const { x, y } = createPublicKey(key).export({ format: 'jwk' });
  return { key, publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(x!, 'base64url'), Buffer.from(y!, 'base64url')]).toString('base64url') };
}

/** The `Authorization` of a push (RFC 8292): an ES256 JWT for the push service's origin, valid 12 hours, and the public key. */
export function vapidAuthorization(input: { vapid: VapidKey; endpoint: string; subject: string; now: number }): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { aud: new URL(input.endpoint).origin, exp: Math.floor(input.now / 1000) + 12 * 3600, sub: input.subject };
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: input.vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${input.vapid.publicKey}`;
}

/**
 * The body of a push (RFC 8291): one aes128gcm record (RFC 8188) keyed by ECDH with a key pair made for this push alone
 * and the subscription's auth secret. The fixed key and salt are for the RFC's example only.
 */
export function encryptWebPush(input: { p256dh: Buffer; auth: Buffer; plaintext: Buffer; serverPrivateKey?: Buffer; salt?: Buffer }): Buffer {
  const server = createECDH(CURVE);
  if (input.serverPrivateKey) server.setPrivateKey(input.serverPrivateKey);
  else server.generateKeys();
  const serverPublicKey = server.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), input.p256dh, serverPublicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', server.computeSecret(input.p256dh), input.auth, keyInfo, 32));
  const salt = input.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([input.plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = serverPublicKey.length;
  return Buffer.concat([header, serverPublicKey, record]);
}

/** A browser's subscription (`PushSubscription.toJSON()`): an https endpoint, its P-256 key and its 16-byte auth secret. */
export interface WebSubscription { endpoint: string; p256dh: Buffer; auth: Buffer }
export interface WebPushTarget extends WebSubscription { deviceId: string }

/** The `subscription` of `push.register` from a browser, checked, or undefined. */
export function parseSubscription(value: unknown): WebSubscription | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') return undefined;
  const p256dh = base64url(keys?.p256dh);
  const auth = base64url(keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !auth || auth.length !== 16) return undefined;
  try { ECDH.convertKey(p256dh, CURVE); } catch { return undefined; }
  return { endpoint, p256dh, auth };
}

function base64url(value: unknown): Buffer | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) ? Buffer.from(value, 'base64url') : undefined;
}

/** Web Push subscriptions in `web_push_subscriptions`: one per device, and one device per endpoint. */
export class WebPushSubscriptions {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /** Records the device's subscription, replacing its previous one and taking the endpoint from any other device. */
  save(deviceId: string, subscription: WebSubscription): void {
    const now = isoAt(this.now());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint = ? AND device_id <> ?').run(subscription.endpoint, deviceId);
      this.db.prepare(`INSERT INTO web_push_subscriptions (device_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
          updated_at = excluded.updated_at`)
        .run(deviceId, subscription.endpoint, subscription.p256dh, subscription.auth, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Subscriptions that may be sent to, by the same rule as the iPhone's registrations (ADR 0029 4). */
  targets(allowedUserId: number): WebPushTarget[] {
    const rows = this.db.prepare(`SELECT w.device_id, w.endpoint, w.p256dh, w.auth FROM web_push_subscriptions w
      JOIN devices d ON d.device_id = w.device_id
      JOIN client_sessions s ON s.session_id = d.client_session_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ? AND s.github_user_id = ? AND d.github_user_id = ?
      ORDER BY w.device_id`).all(isoAt(this.now()), allowedUserId, allowedUserId) as
      { device_id: string; endpoint: string; p256dh: Uint8Array; auth: Uint8Array }[];
    return rows.map(row => ({ deviceId: row.device_id, endpoint: row.endpoint, p256dh: Buffer.from(row.p256dh), auth: Buffer.from(row.auth) }));
  }

  /** Drops the subscription if it still has this endpoint; a device that subscribed anew since keeps it. */
  remove(deviceId: string, endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM web_push_subscriptions WHERE device_id = ? AND endpoint = ?').run(deviceId, endpoint).changes) > 0;
  }
}

/** One push as it goes to the push service. */
export interface WebPushRequest { endpoint: string; headers: Record<string, string>; body: Buffer }

export interface WebPushNotifierOptions {
  loop: { subscribe(listener: (event: PushEvent) => void): () => void };
  approvals?: { subscribe(listener: (event: PushEvent) => void): () => void };
  subscriptions: WebPushSubscriptions;
  vapid: VapidKey;
  /** The VAPID `sub`: the public origin. */
  subject: string;
  allowedUserId: number;
  isConnected: (deviceId: string) => boolean;
  /** Fixed lines naming devices and statuses only: never the text or an endpoint. */
  log: (line: string) => void;
  now: () => number;
  /** The avatar's display name, the title of every notification (ADR 0057). natsumi's when left out. */
  name?: string;
  /** The public origin her faces are served from, `<origin>/avatar/<feeling>.png`, as for the iPhone. */
  iconOrigin?: string;
  /** Posts a push and resolves with the HTTP status. By default `fetch`; tests stand in for the push services. */
  send?: (request: WebPushRequest) => Promise<number>;
}

/**
 * Sends the iPhone's alerts (a reply, a notice, an approval waiting) to the browsers that subscribed and are not
 * connected (ADR 0065). Background pushes are not sent: a browser must show every push it gets. A push is sent once;
 * a 404 or 410 drops the subscription, anything else is logged.
 */
export class WebPushNotifier {
  private readonly options: WebPushNotifierOptions;
  private readonly name: string;
  private readonly send: (request: WebPushRequest) => Promise<number>;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeApprovals: () => void;
  private closed = false;

  constructor(options: WebPushNotifierOptions) {
    this.options = options;
    this.name = options.name ?? DEFAULT_SELF.name;
    this.send = options.send ?? post;
    const listener = (event: PushEvent) => {
      setImmediate(() => {
        if (this.closed) return;
        try { this.handle(event); } catch (error) {
          this.options.log(`web push: could not prepare a push for ${event.type} (${error instanceof Error ? error.name : 'error'})`);
        }
      });
    };
    this.unsubscribe = options.loop.subscribe(listener);
    this.unsubscribeApprovals = options.approvals?.subscribe(listener) ?? (() => {});
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeApprovals();
  }

  private handle({ type, payload }: PushEvent) {
    if (type === 'conversation.message') {
      if (payload.role !== 'natsumi' || typeof payload.kind !== 'string' || !pushAlert(payload.kind, this.name)) return;
      if (typeof payload.messageId !== 'string' || typeof payload.text !== 'string') return;
      const expression = typeof payload.expression === 'string' ? payload.expression : undefined;
      const feeling = EXPRESSIONS.find(known => known === expression) ?? 'neutral';
      const icon = this.options.iconOrigin === undefined ? undefined : `${this.options.iconOrigin}/avatar/${feeling}.png`;
      const imageCount = Array.isArray(payload.images) ? payload.images.length : 0;
      this.dispatch(webPushPayload(this.name, payload.messageId, { text: payload.text, expression, imageCount, icon }));
      return;
    }
    if (type === 'approval.pending') {
      const { approvalId, text, target } = payload as { approvalId?: unknown; text?: unknown; target?: { channel?: unknown } };
      if (typeof approvalId !== 'string' || typeof text !== 'string' || typeof target?.channel !== 'string') return;
      const heading = `${pushAlert('approval', this.name)!.body}（${target.channel}）`;
      this.dispatch(webPushPayload(this.name, approvalId, { text: `${heading}\n${text}` }));
    }
  }

  private dispatch(plaintext: Buffer) {
    for (const target of this.options.subscriptions.targets(this.options.allowedUserId)) {
      if (this.options.isConnected(target.deviceId)) continue;
      void this.deliver(target, plaintext).catch(() => { /* a store closed on the way out; nothing to tell */ });
    }
  }

  private async deliver(target: WebPushTarget, plaintext: Buffer): Promise<void> {
    let status: number;
    try {
      status = await this.send({
        endpoint: target.endpoint,
        headers: {
          authorization: vapidAuthorization({ vapid: this.options.vapid, endpoint: target.endpoint, subject: this.options.subject, now: this.options.now() }),
          'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(TTL_SECONDS), urgency: 'high',
        },
        body: encryptWebPush({ p256dh: target.p256dh, auth: target.auth, plaintext }),
      });
    } catch {
      this.options.log(`web push: no answer for ${target.deviceId}`);
      return;
    }
    if (this.closed) return;
    if (status === 404 || status === 410) {
      if (this.options.subscriptions.remove(target.deviceId, target.endpoint)) {
        this.options.log(`web push: removed the subscription of ${target.deviceId} (${status})`);
      }
      return;
    }
    if (status < 200 || status >= 300) this.options.log(`web push: a push to ${target.deviceId} was refused with ${status}`);
  }
}

/**
 * What the service worker shows: `{ title, tag, text, expression, icon }`, the line cut as for the iPhone and further
 * when it would not fit one record.
 */
export function webPushPayload(title: string, tag: string, line: Parameters<typeof pushPlaintext>[0]): Buffer {
  for (let maxChars = PUSH_TEXT_MAX_CHARS; ; maxChars = Math.floor(maxChars / 2)) {
    const payload = Buffer.from(JSON.stringify({ title, tag, ...JSON.parse(pushPlaintext(line, maxChars).toString('utf8')) }));
    if (payload.length <= WEB_PUSH_PLAINTEXT_MAX_BYTES || maxChars <= 1) return payload;
  }
}

async function post(request: WebPushRequest): Promise<number> {
  // A push service answers where it is asked; a redirect is never followed.
  const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: new Uint8Array(request.body), redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await response.body?.cancel();
  return response.status;
}
