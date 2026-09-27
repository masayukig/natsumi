import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';

/**
 * Fake model endpoints over real TLS, for proving that a model call made on the provider's own path leaves an isolated
 * run through the relay (ADR 0052). A throwaway CA signs one certificate for every name the tests use; the process
 * that calls trusts it through NODE_EXTRA_CA_CERTS. Every request is recorded; the answers are fixed.
 *
 * - `POST /v1/chat/completions`: an OpenAI-compatible endpoint, streaming one text reply
 * - `POST /backend-api/codex/responses`: the ChatGPT subscription's Codex endpoint, streaming one text reply
 */

export const FAKE_REPLY = 'FIXTURE-MODEL-REPLY';

export interface FakeEndpoint {
  port: number;
  /** The CA certificate to trust. */
  ca: string;
  requests: { path: string; host: string; authorization: string }[];
  close(): Promise<void>;
}

/** A CA and a certificate for `names`, made with openssl in `directory`. */
export function makeCertificates(directory: string, names: string[]): { ca: string; key: string; cert: string } {
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=natsumi-eval-test-ca');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${names[0]}`);
  writeFileSync(join(directory, 'san.ext'), `subjectAltName=${names.map(name => /^[\d.]+$/.test(name) ? `IP:${name}` : `DNS:${name}`).join(',')}\n`);
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.ext');
  return { ca: join(directory, 'ca.pem'), key: join(directory, 'server.key'), cert: join(directory, 'server.pem') };
}

export async function startFakeEndpoint(directory: string, names: string[]): Promise<FakeEndpoint> {
  const files = makeCertificates(directory, names);
  const requests: FakeEndpoint['requests'] = [];
  const server: Server = createServer({ key: readFileSync(files.key), cert: readFileSync(files.cert) }, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url ?? '', host: request.headers.host ?? '', authorization: request.headers.authorization ?? '' });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (request.url?.endsWith('/chat/completions')) {
        const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: FAKE_REPLY }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
        response.end('data: [DONE]\n\n');
        return;
      }
      if (request.url?.endsWith('/codex/responses')) {
        const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: FAKE_REPLY, annotations: [] }] };
        const responseBody = { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] as unknown[] };
        send({ type: 'response.created', response: responseBody });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: FAKE_REPLY });
        send({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: FAKE_REPLY });
        send({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { ...responseBody, status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 } } } });
        response.end();
        return;
      }
      response.end();
    });
  });
  // A WebSocket upgrade is refused, as a server without one would; the provider then streams over plain HTTPS.
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  return { port: (server.address() as { port: number }).port, ca: files.ca, requests,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
