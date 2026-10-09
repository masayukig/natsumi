// The connection to the natsumi server: GitHub login with PKCE, the token in the keyring, and the WSS session
// (docs/client-contract.md). It knows nothing about drawing; the extension hands it callbacks.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Secret from 'gi://Secret';

const SECRET = new Secret.Schema('io.github.masayukig.natsumi', Secret.SchemaFlags.NONE,
    {server: Secret.SchemaAttributeType.STRING});
// These carry no stream number (contract: "考えている 1 行", "セッションの延長").
const UNNUMBERED = new Set(['conversation.thinking', 'session.renewed']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Random bytes from the kernel, as base64url without padding (PKCE verifier and state). */
function randomToken(bytes) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    const data = stream.read_bytes(bytes, null).toArray();
    stream.close(null);
    return base64url(data);
}

function base64url(data) {
    return GLib.base64_encode(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 code challenge of an ASCII verifier. */
export function challengeOf(verifier) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    return base64url(Uint8Array.from(hex.match(/../g), h => parseInt(h, 16)));
}

/** The server origin as typed by the owner, or null when it is not one (https only; http only for loopback). */
export function parseOrigin(text) {
    let uri;
    try {
        uri = GLib.Uri.parse(text.trim(), GLib.UriFlags.NONE);
    } catch {
        return null;
    }
    const scheme = uri.get_scheme(), host = uri.get_host();
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (!host || !(scheme === 'https' || (scheme === 'http' && loopback))) return null;
    if (!['', '/'].includes(uri.get_path()) || uri.get_query() || uri.get_userinfo()) return null;
    const port = uri.get_port();
    return `${scheme}://${host.includes(':') ? `[${host}]` : host}${port > 0 ? `:${port}` : ''}`;
}

function promise(start) {
    return new Promise((resolve, reject) => start((source, result, finish) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    }));
}

export class Session {
    /**
     * @param {Gio.Settings} settings  `server-url` and `device-id`
     * @param {object} on  status(text, state), snapshot(payload), event(type, payload, envelope)
     */
    constructor(settings, on) {
        this._settings = settings;
        this._on = on;
        this._http = new Soup.Session({timeout: 30, user_agent: 'natsumi-gnome'});
        this._ws = null;
        this._token = null;
        this._position = null; // {epoch, streamId, seq} of the stream applied so far
        this._failures = 0;
        this._retry = 0;
        this._login = null; // {verifier, state} while the browser is out
        this._stopped = false;
        this._requests = 0;
    }

    get origin() {
        return parseOrigin(this._settings.get_string('server-url'));
    }

    async start() {
        if (!this.origin) {
            this._status('サーバーの URL が未設定です', 'no-server');
            return;
        }
        try {
            this._token = await promise(cb => Secret.password_lookup(SECRET, {server: this.origin}, null,
                (s, r) => cb(s, r, Secret.password_lookup_finish)));
        } catch (e) {
            console.warn('[natsumi] keyring lookup failed:', e.message);
            this._token = null;
        }
        if (this._token) this._connect();
        else this._status('ログインしていません', 'logged-out');
    }

    stop() {
        this._stopped = true;
        if (this._retry) GLib.source_remove(this._retry);
        this._retry = 0;
        this._ws?.close(Soup.WebsocketCloseCode.NORMAL, null);
        this._ws = null;
        this._http.abort();
    }

    // ---- login ----

    /** Opens the browser on the server's GitHub login. The callback comes back through `finishLogin`. */
    beginLogin() {
        const origin = this.origin;
        if (!origin) {
            this._status('サーバーの URL が未設定です', 'no-server');
            return;
        }
        this._login = {verifier: randomToken(48), state: randomToken(24)};
        const query = `code_challenge=${challengeOf(this._login.verifier)}&code_challenge_method=S256` +
            `&state=${this._login.state}`;
        Gio.AppInfo.launch_default_for_uri(`${origin}/auth/github/start?${query}`, null);
        this._status('ブラウザでログインしてください', 'logging-in');
    }

    /** Called with `natsumi://oauth/callback?...` from the URL handler. */
    async finishLogin(uri) {
        const login = this._login;
        let params;
        try {
            params = GLib.Uri.parse_params(GLib.Uri.parse(uri, GLib.UriFlags.NONE).get_query() ?? '', -1, '&',
                GLib.UriParamsFlags.NONE);
        } catch {
            return;
        }
        // A callback this extension did not start is ignored, whoever sent it.
        if (!login || params.state !== login.state) return;
        this._login = null;
        if (!params.code) {
            this._status(`ログインできませんでした（${params.error ?? '不明'}）`, 'logged-out');
            return;
        }
        try {
            const {status, body} = await this._post('/auth/session', {code: params.code, codeVerifier: login.verifier});
            if (status !== 200 || !body?.token) throw new Error(`HTTP ${status} ${body?.error ?? ''}`);
            await promise(cb => Secret.password_store(SECRET, {server: this.origin}, Secret.COLLECTION_DEFAULT,
                `natsumi (${this.origin})`, body.token, null, (s, r) => cb(s, r, Secret.password_store_finish)));
            this._token = body.token;
            this._connect();
        } catch (e) {
            this._status(`ログインできませんでした（${e.message}）`, 'logged-out');
        }
    }

    async logout() {
        const token = this._token;
        this._forget();
        if (token) await this._post('/auth/logout', null, token).catch(() => {});
        this._status('ログアウトしました', 'logged-out');
    }

    _forget() {
        this._token = null;
        this._position = null;
        if (this._retry) GLib.source_remove(this._retry);
        this._retry = 0;
        this._ws?.close(Soup.WebsocketCloseCode.NORMAL, null);
        this._ws = null;
        Secret.password_clear(SECRET, {server: this.origin ?? ''}, null, (_s, r) => {
            try {
                Secret.password_clear_finish(r);
            } catch (e) {
                console.warn('[natsumi] keyring clear failed:', e.message);
            }
        });
    }

    // ---- commands ----

    /** Sends a command; returns its requestId, or null when not connected. */
    send(type, payload) {
        if (this._ws?.get_state() !== Soup.WebsocketState.OPEN) return null;
        const requestId = `gnome-${Date.now()}-${++this._requests}`;
        const deviceId = this._settings.get_string('device-id');
        this._ws.send_text(JSON.stringify({v: 1, requestId, ...(deviceId ? {deviceId} : {}), type, payload}));
        return requestId;
    }

    // ---- connection ----

    _connect() {
        if (this._stopped || !this._token) return;
        this._status('接続しています', 'connecting');
        const url = `${this.origin.replace(/^http/, 'ws')}/v1/ws`;
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${this._token}`);
        this._http.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            let ws;
            try {
                ws = session.websocket_connect_finish(result);
            } catch (e) {
                if (message.get_status() === 401) this._relogin();
                else this._later(`つながりません（${e.message}）`);
                return;
            }
            if (this._stopped) {
                ws.close(Soup.WebsocketCloseCode.NORMAL, null);
                return;
            }
            this._open(ws);
        });
    }

    _open(ws) {
        this._ws = ws;
        // Snapshots carry up to 500 messages; Soup's default limit is 128 KiB.
        ws.max_incoming_payload_size = 16 * 1024 * 1024;
        ws.keepalive_interval = 20; // proxies drop idle sockets after about 60 s (same as the Mac app)
        if ('keepalive_pong_timeout' in ws) ws.keepalive_pong_timeout = 10;
        ws.connect('message', (_ws, type, bytes) => {
            if (type !== Soup.WebsocketDataType.TEXT) return;
            let envelope;
            try {
                envelope = JSON.parse(decoder.decode(bytes.toArray()));
            } catch {
                return;
            }
            this._receive(envelope);
        });
        ws.connect('closed', () => {
            if (this._ws !== ws) return;
            this._ws = null;
            const code = ws.get_close_code();
            if (code === 1008) this._relogin();
            else if (code === 4001) this._status('別の場所で同じ端末がつながりました', 'stopped');
            else if (code === 1002 || code === 1007) this._status(`サーバーと話が合いません（${code}）`, 'stopped');
            else this._later('切れました');
        });
        const resume = this._position ? {...this._position} : null;
        this.send('session.sync', {resume});
    }

    _receive(envelope) {
        const {type, payload = {}} = envelope;
        const numbered = !UNNUMBERED.has(type) && typeof envelope.seq === 'number';
        if (type === 'session.snapshot') {
            this._position = {epoch: envelope.epoch, streamId: envelope.streamId, seq: envelope.seq};
            this._synced(payload.deviceId);
            this._on.snapshot(payload);
            return;
        }
        if (numbered && this._position) {
            const p = this._position;
            if (envelope.epoch !== p.epoch || envelope.streamId !== p.streamId) return;
            if (envelope.seq <= p.seq) return; // already applied
            if (envelope.seq !== p.seq + 1) { // a gap: start over from a snapshot
                this._position = null;
                this.send('session.sync', {resume: null});
                return;
            }
            p.seq = envelope.seq;
        } else if (UNNUMBERED.has(type) && this._position &&
            (envelope.epoch !== this._position.epoch || envelope.streamId !== this._position.streamId)) {
            return;
        }
        if (type === 'command.accepted' && payload.mode === 'resume') this._synced(payload.deviceId);
        if (type === 'command.rejected' && ['sync-required', 'device-mismatch'].includes(payload.code)) {
            this._position = null;
            this._settings.set_string('device-id', '');
            this._ws?.close(Soup.WebsocketCloseCode.NORMAL, null);
            return;
        }
        if (type === 'service.unavailable' && payload.deviceId) this._synced(payload.deviceId);
        this._on.event(type, payload, envelope);
    }

    _synced(deviceId) {
        if (deviceId && deviceId !== this._settings.get_string('device-id'))
            this._settings.set_string('device-id', deviceId);
        this._failures = 0;
        this._status('つながっています', 'online');
    }

    _relogin() {
        this._forget();
        this._status('ログインし直してください', 'logged-out');
    }

    _later(why) {
        if (this._stopped) return;
        const seconds = Math.min(30, 2 ** this._failures++);
        this._status(`${why}。${seconds} 秒後につなぎ直します`, 'offline');
        if (this._retry) GLib.source_remove(this._retry);
        this._retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retry = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Reconnects now (after the machine wakes up, or from the menu). */
    reconnect() {
        if (this._ws) return;
        // With auto-login the keyring is still locked when the shell starts, so the token may be there by now.
        if (!this._token) {
            this.start();
            return;
        }
        if (this._retry) GLib.source_remove(this._retry);
        this._retry = 0;
        this._failures = 0;
        this._connect();
    }

    // ---- http ----

    async _post(path, json, token = null) {
        const message = Soup.Message.new('POST', `${this.origin}${path}`);
        if (token) message.request_headers.append('Authorization', `Bearer ${token}`);
        if (json) message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(json))));
        const bytes = await promise(cb => this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
            (s, r) => cb(s, r, res => s.send_and_read_finish(res))));
        const text = decoder.decode(bytes.toArray());
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {}
        return {status: message.get_status(), body};
    }

    /** GET returning bytes (avatar files need no login). */
    async getBytes(path) {
        const message = Soup.Message.new('GET', `${this.origin}${path}`);
        const bytes = await promise(cb => this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
            (s, r) => cb(s, r, res => s.send_and_read_finish(res))));
        if (message.get_status() !== 200) throw new Error(`HTTP ${message.get_status()} ${path}`);
        return bytes;
    }

    _status(text, state) {
        this._state = state;
        this._on.status(text, state);
    }

    get state() {
        return this._state;
    }
}
