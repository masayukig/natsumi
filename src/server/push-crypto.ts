import { createCipheriv, createDecipheriv, createECDH, ECDH, hkdfSync, randomBytes } from 'node:crypto';

/** HKDF info of version 1. A change to any step below is a new version, never a change to this one (ADR 0029). */
export const PUSH_INFO = 'natsumi-push-v1';
/** The text is cut to this many characters before it is encrypted, so the payload stays under APNs' limit. */
export const PUSH_TEXT_MAX_CHARS = 1000;

const CURVE = 'prime256v1';
const PUBLIC_KEY_BYTES = 65;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The encrypted part of a push, `e` in the payload. Every value is standard base64 with padding: `epk` the ephemeral
 * public key (X9.63 uncompressed), `nonce` 12 bytes, `ct` the AES-256-GCM ciphertext followed by its 16-byte tag.
 */
export interface SealedPush { v: 1; epk: string; nonce: string; ct: string }

/**
 * The line as the device shows it: `{ text, expression, icon }`, the text cut to `maxChars` characters with `…` at the
 * end. `icon` is the URL of her face for the line's feeling, which the extension fetches and attaches (ADR 0057); it is
 * never cut, and is left out when there is none.
 * A reply that shows images ends with how many, `（画像 2 枚）`, which is kept whole and not counted into the cut: the
 * alert is text alone, and the images are seen in the app (ADR 0045).
 */
export function pushPlaintext(
  line: { text: string; expression?: string; imageCount?: number; icon?: string }, maxChars = PUSH_TEXT_MAX_CHARS,
): Buffer {
  const mark = line.imageCount ? imageMark(line.imageCount) : '';
  const room = Math.max(1, maxChars - [...mark].length);
  const characters = [...line.text];
  const text = (characters.length <= room ? line.text : `${characters.slice(0, room - 1).join('')}…`) + mark;
  return Buffer.from(JSON.stringify({
    text,
    ...(line.expression === undefined ? {} : { expression: line.expression }),
    ...(line.icon === undefined ? {} : { icon: line.icon }),
  }));
}

/** What a pushed reply ends with when it shows images. */
function imageMark(count: number): string {
  return `（画像 ${count} 枚）`;
}

/**
 * Encrypts for one device with a key pair made for this push alone: ECDH with the device key, HKDF-SHA256
 * (salt = ephemeral public key ‖ device public key, info `natsumi-push-v1`, 32 bytes), then AES-256-GCM with
 * the messageId as AAD. The fixed key and nonce are for the shared test vector only.
 */
export function sealPush(input: {
  devicePublicKey: Buffer; messageId: string; plaintext: Buffer; ephemeralPrivateKey?: Buffer; nonce?: Buffer;
}): SealedPush {
  const ephemeral = createECDH(CURVE);
  if (input.ephemeralPrivateKey) ephemeral.setPrivateKey(input.ephemeralPrivateKey);
  else ephemeral.generateKeys();
  const epk = ephemeral.getPublicKey();
  const key = deriveKey(ephemeral.computeSecret(input.devicePublicKey), epk, input.devicePublicKey);
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(input.messageId, 'utf8'));
  const ct = Buffer.concat([cipher.update(input.plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, epk: epk.toString('base64'), nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

/** The device's side of `sealPush`. The server never holds a device key; this is for tests and the shared vector. */
export function openPush(input: { devicePrivateKey: Buffer; messageId: string; sealed: SealedPush }): Buffer {
  const device = createECDH(CURVE);
  device.setPrivateKey(input.devicePrivateKey);
  const epk = Buffer.from(input.sealed.epk, 'base64');
  const key = deriveKey(device.computeSecret(epk), epk, device.getPublicKey());
  const ct = Buffer.from(input.sealed.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.sealed.nonce, 'base64'), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(input.messageId, 'utf8'));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]);
}

/** A device public key from `push.register`: standard base64 of an uncompressed P-256 point on the curve, or undefined. */
export function decodePublicKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value === '' || !BASE64.test(value)) return undefined;
  const key = Buffer.from(value, 'base64');
  if (key.length !== PUBLIC_KEY_BYTES || key[0] !== 0x04) return undefined;
  try { ECDH.convertKey(key, CURVE); } catch { return undefined; }
  return key;
}

function deriveKey(sharedSecret: Buffer, ephemeralPublicKey: Buffer, devicePublicKey: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralPublicKey, devicePublicKey]);
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, PUSH_INFO, KEY_BYTES));
}
