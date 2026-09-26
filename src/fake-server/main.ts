/**
 * A stand-in for the natsumi server, for looking at a client without GitHub, a model or real memory.
 *
 *   npm run fake-server -- [--port 8787] [--reply-delay 5] [--short] [--approval-delay 8] [--switch-delay 2]
 *
 * It listens on http://localhost only (clients allow plain http for loopback), skips GitHub by redirecting
 * `/auth/github/start` straight to `natsumi://oauth/callback`, hands out a session to anyone, and speaks enough of
 * docs/client-contract.md for the conversation: a snapshot for every `session.sync`, reads, notice checks, and a
 * reply to each message after a line of thinking. It also keeps Slack posts waiting for the owner's approval: two at
 * the start, one more arriving `--approval-delay` seconds after the first sync (0 for none), and `approval.decide`
 * answered the way the contract says. The post to a channel carries two images, served at `/v1/images/<imageId>` to
 * the fake token (the faces of the avatar stand in for pictures she drew). The conversation holds a reply showing two
 * images the same way, and a message that asks for a picture (`絵` or `画像`) is answered with one. It lists three
 * model routes (ADR 0046) — `local` in use, `plus` ready and `spare` not — and `model.use` moves to the chosen one
 * `--switch-delay` seconds after accepting it, the way the server moves between turns. Logging out puts the
 * approvals and the routes back as they were at the start. Everything it says is fictional and kept in memory only.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeServerOptions {
  /** 0 picks a free port. */
  port: number;
  /** Before her reply to a message. */
  replyDelayMs: number;
  /** Her first reply in one line instead of several paragraphs. */
  short: boolean;
  /** After the first sync, before one more approval arrives; 0 for none. */
  approvalDelayMs: number;
  /** Between taking an approval or an edit and saying it was sent. */
  sendDelayMs: number;
  /** Between accepting `model.use` and moving to the route chosen. */
  switchDelayMs: number;
  /** Whether to print the requests and commands it receives. */
  log: boolean;
}

export interface FakeServer {
  port: number;
  close(): Promise<void>;
}

interface Message {
  messageId: string;
  role: 'owner' | 'natsumi';
  kind: 'message' | 'reply' | 'notice';
  text: string;
  createdAt: string;
  eventId?: string;
  replyTo?: string;
  about?: string[];
  expression?: string;
  images?: ShownImage[];
}

interface ShownImage { imageId: string; mimeType: string; bytes: number; width?: number; height?: number }

interface Issue {
  name: string;
  label: string;
  score: number;
  flagged?: true;
}

type Placement = 'thread' | 'channel';

interface Approval {
  approvalId: string;
  revision: number;
  kind: 'slack-post';
  createdAt: string;
  expiresAt: string;
  target: { channel: string; placement: Placement; replyTo?: { speaker: string; at: string; text: string } };
  text: string;
  expression?: string;
  images?: { imageId: string; mimeType: string; bytes: number }[];
  reason: {
    verdict: 'owner' | 'no-verdict' | 'rewrite-limit';
    issues: Issue[];
    placement?: { probabilities: { thread: number; channel: number } };
  };
  history: { text: string; issues: Issue[] }[];
}

type Outcome = 'approved' | 'edited' | 'rejected' | 'expired';

interface RouteView { name: string; provider: string; model: string; ready: boolean }

/** The routes as the config would list them, with made-up models; `spare` has no key to read. */
const ROUTES: RouteView[] = [
  { name: 'local', provider: 'natsumi-compatible', model: 'example-model', ready: true },
  { name: 'plus', provider: 'openai-codex', model: 'example-plus-model', ready: true },
  { name: 'spare', provider: 'natsumi-spare', model: 'example-spare-model', ready: false },
];

interface ClientEnvelope {
  requestId: string;
  type: string;
  payload: Record<string, unknown>;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const fromNow = (days: number) => new Date(Date.now() + days * 24 * 3600_000).toISOString();
const longReply = [
  'おはよう。昨日は iPhone 版の画面を考えていたところで止まってたよ。',
  'ログインと会話の画面はだいたい形になってて、残りは設定と、キーボードが出たときの見え方。メインの吹き出しは、Mac と違って最新のセリフを全部読めるようにしたいって話だった。',
  '長いときは吹き出しの中だけがスクロールして、キャラクターと入力欄は動かない。お知らせも吹き出しと同じ幅にそろえる。',
  '履歴への入り口は右上のボタンに一本化して、吹き出しからは外す。',
  '今日はこの3つを直してから、ログインと会話の画面を詰める？',
].join('\n\n');

const promise: Issue = { name: 'promise-for-owner', label: '本人に代わる約束・期限', score: 0.82, flagged: true };

/** The images the approvals show, by ID: two of the avatar's faces, read once. */
const IMAGES = new Map(['happy', 'laughing'].map(face => [`image-fake-${face}`,
  readFileSync(new URL(`../../assets/avatar/${face}.png`, import.meta.url))]));
const listed = (imageId: string) => ({ imageId, mimeType: 'image/png', bytes: IMAGES.get(imageId)!.length });
/** A line's images also say their size, read from the PNG header (ADR 0045). */
const sized = (imageId: string): ShownImage => {
  const data = IMAGES.get(imageId)!;
  return { ...listed(imageId), width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

/** The approvals waiting at the start: a reply in a thread sent back twice before, and a post to a channel. */
function startingApprovals(): Approval[] {
  return [
    {
      approvalId: 'approval-review', revision: 1, kind: 'slack-post', createdAt: ago(30), expiresAt: fromNow(7),
      target: {
        channel: 'work/#dev', placement: 'thread',
        replyTo: { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー、何時からなら大丈夫そう？' },
      },
      text: '明日は 10 時からなら大丈夫です。資料は今日中に共有しておきますね。', expression: 'happy',
      reason: {
        verdict: 'rewrite-limit',
        issues: [promise, { name: 'not-in-thread', label: 'スレッドに無い情報', score: 0.12 }, { name: 'false-claim', label: '事実と違う説明', score: 0.05 }],
        placement: { probabilities: { thread: 0.8, channel: 0.2 } },
      },
      history: [
        { text: '明日なら何時でも大丈夫です！', issues: [{ ...promise, score: 0.91 }] },
        { text: '明日の午前なら空いています。資料もすぐ出せます。', issues: [{ ...promise, score: 0.77 }] },
      ],
    },
    {
      approvalId: 'approval-lunch', revision: 1, kind: 'slack-post', createdAt: ago(3), expiresAt: fromNow(7),
      target: { channel: 'work/#random', placement: 'channel' },
      text: '今日のお昼は新しくできたカレー屋さんが空いてるみたいです。',
      images: [listed('image-fake-happy'), listed('image-fake-laughing')],
      reason: { verdict: 'no-verdict', issues: [] }, history: [],
    },
  ];
}

/** The approval that arrives after the first sync: a direct message the judge handed to the owner. */
function laterApproval(): Approval {
  return {
    approvalId: 'approval-dm', revision: 1, kind: 'slack-post', createdAt: new Date().toISOString(), expiresAt: fromNow(7),
    target: {
      channel: 'work/@佐藤', placement: 'thread',
      replyTo: { speaker: '佐藤', at: '2026-09-26 09:05:12', text: '来週の件、先方に日程を伝えてもいいですか？' },
    },
    text: 'はい、来週の水曜で先方に伝えてください。', expression: 'neutral',
    reason: {
      verdict: 'owner',
      issues: [{ ...promise, score: 0.64 }, { name: 'not-in-thread', label: 'スレッドに無い情報', score: 0.58, flagged: true }],
      placement: { probabilities: { thread: 0.55, channel: 0.45 } },
    },
    history: [],
  };
}

export function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const epoch = `epoch-${Date.now()}`;
  const streamId = 'stream-fake';
  const messages: Message[] = [
    { messageId: 'm1', role: 'owner', kind: 'message', text: 'おはよう', createdAt: ago(10), eventId: 'e1' },
    { messageId: 'n1', role: 'natsumi', kind: 'notice', text: '10 時から定例があります\n資料は共有フォルダにあります', createdAt: ago(8), about: ['e0'], expression: 'neutral' },
    { messageId: 'n2', role: 'natsumi', kind: 'notice', text: '明日は祝日です', createdAt: ago(7), about: ['e0'], expression: 'happy' },
    { messageId: 'r1', role: 'natsumi', kind: 'reply', text: options.short ? 'おはよう。今日は何から始める？' : longReply, createdAt: ago(5), eventId: 'e1', replyTo: 'm1', expression: 'happy' },
    { messageId: 'r2', role: 'natsumi', kind: 'reply', text: '昨日描いた絵も見てね。', createdAt: ago(4), expression: 'laughing',
      images: [sized('image-fake-happy'), sized('image-fake-laughing')] },
  ];
  let unacknowledged = ['n1', 'n2'];
  let readThrough: string | null = null;
  let expression = 'happy';
  let seq = 0;
  let sent = 0;
  let approvals = startingApprovals();
  /** How each approval closed, so that a decision on a closed one is answered with it (the contract's idempotence). */
  let closed = new Map<string, Outcome>();
  let laterScheduled = false;
  let currentRoute = 'local';
  let chosenRoute = 'local';
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const log = (...args: unknown[]) => { if (options.log) console.log(...args); };

  function later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  }

  /** Every connection shares the one stream, the way one device would see it. */
  function broadcast(type: string, payload: unknown, requestId?: string, moment = false): void {
    // A line of thinking is of the moment: it carries the number the stream is already at (ADR 0017).
    if (!moment) seq += 1;
    const text = JSON.stringify({ v: 1, epoch, streamId, seq, type, payload, ...(requestId ? { requestId } : {}) });
    for (const socket of sockets) socket.send(text);
  }

  /** Like the real server, every use moves the session's end thirty days out (ADR 0030). */
  function sessionEnd(): string {
    return new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  }

  function routeStatus() {
    return { defaultRoute: 'local', current: currentRoute, chosen: chosenRoute, routes: ROUTES };
  }

  function unreadReplies(): number {
    const read = readThrough === null ? -1 : messages.findIndex((m) => m.messageId === readThrough);
    return messages.slice(read + 1).filter((m) => m.kind === 'reply').length;
  }

  function answer(envelope: ClientEnvelope): void {
    const { requestId, payload } = envelope;
    switch (envelope.type) {
      case 'session.sync':
        broadcast('session.snapshot', {
          deviceId: 'device-fake', messages, pendingEvents: [], avatar: { expression },
          readThroughMessageId: readThrough, unreadReplyCount: unreadReplies(), unacknowledgedNotificationIds: unacknowledged,
          pendingApprovals: approvals, modelRoutes: routeStatus(), sessionExpiresAt: sessionEnd(),
        }, requestId);
        if (!laterScheduled && options.approvalDelayMs > 0) {
          laterScheduled = true;
          later(options.approvalDelayMs, () => {
            const approval = laterApproval();
            approvals.push(approval);
            broadcast('approval.pending', approval);
          });
        }
        return;
      case 'conversation.read':
        readThrough = String(payload.throughMessageId);
        broadcast('command.accepted', { readThroughMessageId: readThrough, unreadReplyCount: unreadReplies() }, requestId);
        return;
      case 'notification.ack':
        unacknowledged = unacknowledged.filter((id) => id !== payload.notificationId);
        broadcast('command.accepted', { notificationId: payload.notificationId }, requestId);
        return;
      case 'conversation.send':
        converse(String(payload.text), requestId);
        return;
      case 'push.register':
        // Nothing is sent from here: the simulator's pushes are not the server's to make.
        broadcast('command.accepted', { environment: payload.environment }, requestId);
        return;
      case 'approval.decide':
        decide(payload, requestId);
        return;
      case 'model.list':
        broadcast('command.accepted', routeStatus(), requestId);
        return;
      case 'model.use':
        useRoute(payload.route, requestId);
        return;
      default:
        broadcast('command.rejected', { code: 'unsupported' }, requestId);
    }
  }

  /** `approval.decide` as the contract has it: one decision each, for the revision the owner saw. */
  function decide(payload: Record<string, unknown>, requestId: string): void {
    const { approvalId, revision, decision, text, placement } = payload;
    const reject = (code: string) => broadcast('command.rejected', { code }, requestId);
    if (typeof approvalId !== 'string' || typeof revision !== 'number' || !Number.isInteger(revision)) return reject('invalid-request');
    if (decision !== 'approve' && decision !== 'edit' && decision !== 'reject') return reject('invalid-request');
    if (decision === 'edit' && (typeof text !== 'string' || text.trim() === '')) return reject('invalid-request');
    if (placement !== undefined && placement !== 'thread' && placement !== 'channel') return reject('invalid-request');

    const already = closed.get(approvalId);
    if (already) {
      // A decision on a closed approval changes nothing and is answered with how it closed.
      broadcast('command.accepted', { approvalId, revision, state: already }, requestId);
      return;
    }
    const approval = approvals.find((a) => a.approvalId === approvalId);
    if (!approval) return reject('invalid-request');
    if (approval.revision !== revision) return reject('stale-revision');

    const state: Outcome = decision === 'approve' ? 'approved' : decision === 'edit' ? 'edited' : 'rejected';
    approvals = approvals.filter((a) => a !== approval);
    closed.set(approvalId, state);
    broadcast('command.accepted', { approvalId, revision, state }, requestId);
    const resolved = { approvalId, revision, state };
    if (state === 'rejected') {
      broadcast('approval.resolved', { ...resolved, resolvedAt: new Date().toISOString() });
      return;
    }
    const sentText = state === 'edited' ? String(text) : approval.text;
    later(options.sendDelayMs, () => broadcast('approval.resolved', {
      ...resolved, resolvedAt: new Date().toISOString(), delivery: 'sent', sentText,
    }));
  }

  /** `model.use` as the contract has it: the choice is taken at once, and the move follows between turns. */
  function useRoute(name: unknown, requestId: string): void {
    const reject = (code: string) => broadcast('command.rejected', { code }, requestId);
    if (typeof name !== 'string' || name === '') return reject('invalid-request');
    const route = ROUTES.find((r) => r.name === name);
    if (!route) return reject('unknown-route');
    if (!route.ready) return reject('route-unavailable');
    chosenRoute = name;
    broadcast('command.accepted', { chosen: chosenRoute, current: currentRoute }, requestId);
    if (currentRoute === chosenRoute) return;
    later(options.switchDelayMs, () => {
      if (currentRoute === chosenRoute) return;
      currentRoute = chosenRoute;
      broadcast('model.routes', routeStatus());
    });
  }

  function converse(text: string, requestId: string): void {
    sent += 1;
    const messageId = `m${100 + sent}`;
    const eventId = `e${100 + sent}`;
    const own: Message = { messageId, role: 'owner', kind: 'message', text, createdAt: new Date().toISOString(), eventId };
    messages.push(own);
    broadcast('conversation.message', own);
    broadcast('command.accepted', { messageId, eventId, state: 'processing' }, requestId);
    expression = 'thinking';
    broadcast('avatar.expression', { expression });
    later(options.replyDelayMs / 3, () => broadcast('conversation.thinking', { line: 'メモを読み返してる' }, undefined, true));
    later(options.replyDelayMs, () => {
      const reply: Message = {
        messageId: `r${100 + sent}`, role: 'natsumi', kind: 'reply', text: `「${text}」だね。わかった。`,
        createdAt: new Date().toISOString(), eventId, replyTo: messageId, expression: 'laughing',
        ...(/絵|画像/.test(text) ? { images: [sized('image-fake-happy')] } : {}),
      };
      messages.push(reply);
      broadcast('conversation.message', reply);
      expression = 'laughing';
      broadcast('avatar.expression', { expression });
      broadcast('conversation.event.completed', { eventId, messageId, status: 'replied' });
    });
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    log(request.method, url.pathname);
    if (url.pathname === '/auth/github/start') {
      const state = encodeURIComponent(url.searchParams.get('state') ?? '');
      response.writeHead(302, { Location: `natsumi://oauth/callback?code=fake-code&state=${state}` }).end();
    } else if (url.pathname === '/auth/session' && request.method === 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: 'fake-token', expiresAt: sessionEnd() }));
    } else if (url.pathname.startsWith('/v1/images/') && request.method === 'GET') {
      const image = IMAGES.get(url.pathname.slice('/v1/images/'.length));
      if (request.headers.authorization !== 'Bearer fake-token') {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      } else if (!image) {
        response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }));
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length }).end(image);
      }
    } else if (url.pathname === '/auth/logout' && request.method === 'POST') {
      // The next login finds the approvals as they were at the start, so a walkthrough can be run again.
      approvals = startingApprovals();
      closed = new Map();
      laterScheduled = false;
      currentRoute = 'local';
      chosenRoute = 'local';
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });

  new WebSocketServer({ server, path: '/v1/ws' }).on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const envelope = JSON.parse(data.toString()) as ClientEnvelope;
      log('<-', envelope.type, JSON.stringify(envelope.payload));
      answer(envelope);
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port, 'localhost', () => resolve({
      port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((done) => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.terminate();
        server.close(() => done());
      }),
    }));
  });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '8787' },
    'reply-delay': { type: 'string', default: '5' },
    short: { type: 'boolean', default: false },
    'approval-delay': { type: 'string', default: '8' },
    'switch-delay': { type: 'string', default: '2' },
  } });
  const server = await startFakeServer({
    port: Number(values.port), replyDelayMs: Number(values['reply-delay']) * 1000, short: values.short,
    approvalDelayMs: Number(values['approval-delay']) * 1000, sendDelayMs: 1000,
    switchDelayMs: Number(values['switch-delay']) * 1000, log: true,
  });
  console.log(`fake natsumi server on http://localhost:${server.port}`);
}
