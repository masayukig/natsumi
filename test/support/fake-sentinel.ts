import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';

/**
 * A stand-in for the sentinel's approvals socket (natsumi-sentinel `docs/approvals-api.md`, "承認を受け付ける口"): plain
 * HTTP/1.1 over a Unix socket, JSON in and out, the events as ndjson. It keeps its approvals, grants and records in
 * memory, answers as the real one does (a closed approval's answer is 409, an unknown body field is 400), and lets a test
 * push events, drop the streams, stop and start again.
 */

export interface FakeChoice { id: string; scope: 'once' | 'timed'; seconds: number; label: string }
/** The unit, handling and access offered for a destination grant (natsumi-sentinel `docs/destination-grants.md`). */
export interface FakeOptions { unit: { id: string; label: string }[]; handling: { id: string; label: string }[]; access: { id: string; label: string }[] }
export interface FakeApproval {
  id: string; kind: 'request' | 'beforehand' | 'destination'; state: 'open' | 'allowed' | 'denied' | 'expired'; source: string;
  created: string; expires: string; summary: string; items: Record<string, unknown>[]; choices: FakeChoice[]; requests: number;
  answered?: string; choice?: string; grants?: string[]; options?: FakeOptions;
  /** The options allowed with, their defaults filled in: only on an approval of a destination allowed. */
  chosen?: { unit: string; handling: string; access?: string };
}
export interface FakeGrant {
  id: string; approval?: string; source: string; scope: 'once' | 'timed'; created: string; expires?: string; summary: string;
  kind?: 'operation' | 'destination';
  destination?: string; operation?: string; target?: string; method?: string; path?: string;
  name?: string; unit?: 'name' | 'domain'; handling?: string; access?: string;
}
/** A name the sentinel refused for not being in its routing table, as its list of them gives it. */
export interface FakeRefusedName {
  source: string; name: string; domain?: string; inside: boolean; first: string; last: string; count: number; summary: string;
  choices: FakeChoice[]; options: FakeOptions;
}
export interface FakeRecord { id: number; time: string; kind: string; finished: boolean; [field: string]: unknown }

/** An open approval of a pull request's merge, as the sentinel would make it, with the fields a test overrides. */
export function fakeApproval(overrides: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: 'ap-0001', kind: 'request', state: 'open', source: 'penelope', created: '2026-01-01T00:00:00Z', expires: '2026-01-02T00:00:00Z',
    summary: 'github.example.test の pulls.merge（owner=example repo=widgets number=7）',
    items: [{
      destination: 'github.example.test', method: 'PUT', path: '/repos/example/widgets/pulls/7/merge', operation: 'pulls.merge',
      params: [{ name: 'owner', value: 'example' }, { name: 'repo', value: 'widgets' }, { name: 'number', value: '7' }],
      target: ['owner', 'repo'], targetText: 'owner=example repo=widgets',
      body: { text: '{"merge_method":"merge"}', size: 24, sha256: 'ab'.repeat(32) }, fingerprint: 'cd'.repeat(32), exact: true,
    }],
    choices: [
      { id: 'once', scope: 'once', seconds: 600, label: 'この要求を 1 回だけ' },
      { id: '1h', scope: 'timed', seconds: 3600, label: 'example/widgets の pulls.merge を 1 時間' },
    ],
    requests: 1,
    ...overrides,
  };
}

/** The options the sentinel offers for a name: this name only first, then each domain above it; inspect first; read first. */
export function fakeOptions(name = 'docs.example.test'): FakeOptions {
  const labels = name.split('.');
  const domains = labels.slice(1, -1).map((_, index) => labels.slice(index + 1).join('.'));
  return {
    unit: [{ id: 'name', label: `${name} だけ` },
      ...domains.map(domain => ({ id: `domain:${domain}`, label: `${domain} とその下のすべての名前が通る` }))],
    handling: [{ id: 'inspect', label: '開いて見る' }, { id: 'passthrough', label: '開かない。読み書きとも通る。中身は見ない' }],
    access: [{ id: 'read', label: '読みだけ。書きは聞く' }, { id: 'readwrite', label: '読み書き' }],
  };
}

const DESTINATION_CHOICES: FakeChoice[] = [
  { id: '1d', scope: 'timed', seconds: 86400, label: '1 日' },
  { id: 'forever', scope: 'timed', seconds: 0, label: '期限なし' },
];

/** An open approval of a destination asked for beforehand, as the sentinel would make it. */
export function fakeDestinationApproval(overrides: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: 'ap-0101', kind: 'destination', state: 'open', source: 'penelope', created: '2026-01-01T00:00:00Z', expires: '2026-01-02T00:00:00Z',
    summary: 'penelope が docs.example.test を頼んだ（表に無い名前）',
    items: [{ destination: 'docs.example.test', facts: [{ name: 'inside', value: 'false' }, { name: 'registrableDomain', value: 'example.test' },
      { name: 'refusedCount', value: '3' }, { name: 'refusedLast', value: '2026-01-01T00:04:00Z' }] }],
    choices: DESTINATION_CHOICES, requests: 1, options: fakeOptions(), ...overrides,
  };
}

/** A name refused, as the sentinel's list of them gives it. */
export function fakeRefusedName(overrides: Partial<FakeRefusedName> = {}): FakeRefusedName {
  const name = overrides.name ?? 'docs.example.test';
  return {
    source: 'penelope', name, domain: name.split('.').slice(-2).join('.'), inside: false, first: '2026-01-01T00:00:00Z', last: '2026-01-01T00:04:00Z', count: 3,
    summary: `penelope が ${name} を 3 回引いて断られた`, choices: DESTINATION_CHOICES, options: fakeOptions(name), ...overrides,
  };
}

export class FakeSentinel {
  readonly socketPath: string;
  readonly approvals = new Map<string, FakeApproval>();
  readonly grants = new Map<string, FakeGrant>();
  records: FakeRecord[] = [];
  /** Every request as `METHOD path?query`, and the bodies of those that had one. */
  readonly requests: string[] = [];
  readonly bodies: unknown[] = [];
  /** A status to answer every request with but the events', for a ledger that cannot be read. */
  failWith: number | undefined;
  /**
   * Whether it speaks of destination grants (natsumi-sentinel ADR-0008): the list of refused names and the grant from
   * it, and `options` in an answer. Off, it is the version before them, which knows none of it.
   */
  destinations = false;
  refusedNames: FakeRefusedName[] = [];
  /** A status to answer the list of refused names with, for that list alone failing. */
  refusedNamesFailWith: number | undefined;
  private readonly streams = new Set<ServerResponse>();
  private server: Server | undefined;
  private grantCount = 0;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** How many event streams are open now. */
  get streamCount(): number { return this.streams.size; }

  async start(): Promise<this> {
    await rm(this.socketPath, { force: true });
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    return this;
  }

  /** Closes the socket and every stream on it: the sentinel stopped. */
  async stop(): Promise<void> {
    this.dropStreams();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(this.socketPath, { force: true });
  }

  /** Writes one event to every stream open now. */
  emit(event: Record<string, unknown>): void {
    for (const stream of this.streams) stream.write(`${JSON.stringify(event)}\n`);
  }

  /** Ends every stream, as a sentinel that restarted would. */
  dropStreams(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  /** Adds an open approval and tells the streams of it, as one made by a request asked. */
  create(approval: FakeApproval, tell = true): void {
    this.approvals.set(approval.id, approval);
    if (tell) this.emit({ type: 'approval.created', approval });
  }

  /** Closes an approval as the sentinel would, and tells the streams of it. */
  close(id: string, state: 'allowed' | 'denied' | 'expired', choice?: string, tell = true, options?: Record<string, string>): FakeApproval {
    const approval = this.approvals.get(id)!;
    approval.state = state;
    if (state !== 'expired') approval.answered = '2026-01-01T00:05:00Z';
    if (state === 'allowed' && choice && approval.kind === 'destination') {
      approval.choice = choice;
      const picked = approval.choices.find(candidate => candidate.id === choice)!;
      approval.grants = approval.items.map(item => this.destinationGrant(approval.source, String(item.destination), picked, options ?? {}, id).id);
      const handling = options?.handling ?? 'inspect';
      approval.chosen = { unit: options?.unit ?? 'name', handling, ...(handling === 'passthrough' ? {} : { access: options?.access ?? 'read' }) };
    } else if (state === 'allowed' && choice) {
      approval.choice = choice;
      const picked = approval.choices.find(candidate => candidate.id === choice)!;
      const grant: FakeGrant = {
        id: `gr-${String(++this.grantCount).padStart(4, '0')}`, ...(this.destinations ? { kind: 'operation' as const } : {}), approval: id, source: approval.source, scope: picked.scope,
        created: '2026-01-01T00:05:00Z', ...(picked.scope === 'timed' && picked.seconds > 0 ? { expires: '2026-01-01T01:05:00Z' } : {}),
        summary: picked.label, destination: String(approval.items[0]!.destination), operation: String(approval.items[0]!.operation),
        target: String(approval.items[0]!.targetText),
      };
      this.grants.set(grant.id, grant);
      approval.grants = [grant.id];
    }
    if (tell) this.emit({ type: 'approval.closed', approval });
    return approval;
  }

  /** A destination grant, as the sentinel puts one in its ledger: the defaults where an option is left out. */
  private destinationGrant(source: string, name: string, picked: FakeChoice, options: Record<string, string>, approval?: string): FakeGrant {
    const unit = options.unit ?? 'name';
    const handling = options.handling ?? 'inspect';
    const access = handling === 'passthrough' ? undefined : options.access ?? 'read';
    const granted = unit === 'name' ? name : unit.slice('domain:'.length);
    const grant: FakeGrant = {
      id: `gr-${String(++this.grantCount).padStart(4, '0')}`, kind: 'destination', ...(approval ? { approval } : {}), source, scope: 'timed',
      created: '2026-01-01T00:05:00Z', ...(picked.seconds > 0 ? { expires: '2026-01-02T00:05:00Z' } : {}),
      summary: `${granted}（${unit === 'name' ? 'この名前だけ' : 'ドメインの下すべて'}、${handling}${access ? `、${access}` : ''}）を ${picked.label}`,
      name: granted, unit: unit === 'name' ? 'name' : 'domain', handling, ...(access ? { access } : {}),
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** The options of an answer or a grant, checked against those offered; the words of a refusal, or undefined. */
  private static badOptions(value: unknown, offered: FakeOptions | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!offered) return 'options: only an approval of a destination takes them';
    if (typeof value !== 'object' || value === null) return 'options: not an object';
    for (const [key, id] of Object.entries(value)) {
      const list = offered[key as keyof FakeOptions] as { id: string }[] | undefined;
      if (!list) return `options: json: unknown field "${key}"`;
      if (!list.some(option => option.id === id)) return `options.${key}: not one of the options offered`;
    }
    return undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://sentinel');
    const method = request.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    let text = '';
    for await (const chunk of request) text += chunk;
    const json = (status: number, value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length }).end(body);
    };
    const error = (status: number, message: string) => json(status, { error: message });
    if (method === 'GET' && url.pathname === '/v1/events') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      response.write(`${JSON.stringify({ type: 'hello' })}\n`);
      this.streams.add(response);
      response.on('close', () => { this.streams.delete(response); });
      return;
    }
    if (this.failWith !== undefined) return error(this.failWith, 'the ledger could not be read');
    if (method === 'GET' && url.pathname === '/v1/approvals') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = [...this.approvals.values()].filter(approval => state === 'all' || approval.state === state);
      return json(200, { approvals: state === 'open' ? list : list.reverse() });
    }
    const approval = /^\/v1\/approvals\/([^/]+)(\/answer)?$/.exec(url.pathname);
    if (approval) {
      const found = this.approvals.get(decodeURIComponent(approval[1]!));
      if (method === 'GET' && !approval[2]) return found ? json(200, found) : error(404, 'no such approval');
      if (method === 'POST' && approval[2]) {
        let body: Record<string, unknown>;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { return error(400, 'the body is not JSON'); }
        this.bodies.push(body);
        const fields = this.destinations ? ['answer', 'choice', 'options'] : ['answer', 'choice'];
        if (Object.keys(body).some(key => !fields.includes(key))) return error(400, 'json: unknown field');
        if (body.answer !== 'allow' && body.answer !== 'deny') return error(400, 'answer is allow or deny');
        if (body.answer === 'allow' && !body.choice) return error(400, "choice: allowing takes one of the approval's choices");
        if (!found) return error(404, 'no such approval');
        if (found.state !== 'open') return error(409, `${found.id} is already ${found.state}`);
        if (body.answer === 'allow' && !found.choices.some(choice => choice.id === body.choice)) return error(400, 'not one of the choices');
        const bad = FakeSentinel.badOptions(body.options, found.kind === 'destination' ? found.options : undefined);
        if (bad) return error(400, bad);
        return json(200, this.close(found.id, body.answer === 'allow' ? 'allowed' : 'denied', body.choice as string | undefined, true,
          body.options as Record<string, string> | undefined));
      }
      return error(405, 'method');
    }
    if (this.destinations && method === 'GET' && url.pathname === '/v1/refused-names') {
      if (this.refusedNamesFailWith !== undefined) return error(this.refusedNamesFailWith, 'the names could not be read');
      const source = url.searchParams.get('source');
      return json(200, { names: this.refusedNames.filter(name => !source || name.source === source) });
    }
    if (this.destinations && method === 'POST' && url.pathname === '/v1/refused-names/grant') {
      let body: Record<string, unknown>;
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { return error(400, 'the body is not JSON'); }
      this.bodies.push(body);
      if (Object.keys(body).some(key => !['source', 'name', 'choice', 'options'].includes(key))) return error(400, 'json: unknown field');
      const found = this.refusedNames.find(name => name.source === body.source && name.name === body.name);
      if (!found) return error(404, `${String(body.name)} is not in the list of ${String(body.source)}`);
      const picked = found.choices.find(choice => choice.id === body.choice);
      if (!picked) return error(400, 'choice: not one of the choices');
      const bad = FakeSentinel.badOptions(body.options, found.options);
      if (bad) return error(400, bad);
      this.refusedNames = this.refusedNames.filter(name => name !== found);
      return json(201, { grant: this.destinationGrant(found.source, found.name, picked, (body.options ?? {}) as Record<string, string>) });
    }
    if (method === 'GET' && url.pathname === '/v1/grants') return json(200, { grants: [...this.grants.values()] });
    const grant = /^\/v1\/grants\/([^/]+)$/.exec(url.pathname);
    if (method === 'DELETE' && grant) {
      const found = this.grants.get(decodeURIComponent(grant[1]!));
      if (!found) return error(404, 'no such grant');
      this.grants.delete(found.id);
      return json(200, { revoked: found });
    }
    if (method === 'GET' && url.pathname === '/v1/records') {
      const before = Number(url.searchParams.get('before') ?? 0);
      const asked = Number(url.searchParams.get('limit') ?? 0);
      const limit = asked > 0 && asked <= 1000 ? asked : 100;
      const list = [...this.records].sort((a, b) => b.id - a.id).filter(record => before === 0 || record.id < before);
      const page = list.slice(0, limit);
      return json(200, { records: page, ...(list.length > limit ? { next: page.at(-1)!.id } : {}) });
    }
    const record = /^\/v1\/records\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && record) {
      const found = this.records.find(candidate => String(candidate.id) === record[1]);
      return found ? json(200, found) : error(404, 'no such record');
    }
    error(404, 'not found');
  }
}
