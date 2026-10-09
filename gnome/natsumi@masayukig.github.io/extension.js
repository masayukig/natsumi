// natsumi on the GNOME desktop: the avatar stays on top of every window like the Mac app's stage (natsumi-deploy#8).
// Actors are made once in enable() and only shown or hidden afterwards; destroying a focused St.Entry left IBus/ATK
// holding a dead actor and crashed gnome-shell (2026-10-01).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Session} from './session.js';
import {fetchAvatar, animationFor, Frames} from './avatar.js';

const BUS_NAME = 'io.github.masayukig.Natsumi';
const BUS_PATH = '/io/github/masayukig/Natsumi';
const BUS_XML = `<node><interface name="${BUS_NAME}">
  <method name="OpenUri"><arg type="s" direction="in" name="uri"/></method>
</interface></node>`;
const BASE_W = 96, BASE_H = 104; // points at 100%, like the Mac app's CharacterScale
const COLUMN_W = 300;
const BALLOON_CHARS = 120, BALLOON_LINES = 5;
const CALM = 'idle'; // the resting animation is held on its first frame and played once in a while
const CALM_EVERY = [20, 30]; // seconds between plays of the resting animation
const MESSAGES_KEPT = 500;

function cut(text) {
    const lines = text.split('\n');
    let short = lines.slice(0, BALLOON_LINES).join('\n');
    if (short.length > BALLOON_CHARS) short = short.slice(0, BALLOON_CHARS);
    return short.length < text.length ? `${short}…` : text;
}

export default class NatsumiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._model = {messages: [], cursor: null, unread: 0, notices: [], expression: 'neutral', thinking: '', pending: false,
            avatarVersion: null};
        this._avatar = null;
        this._frames = null;
        this._contents = new Map();
        this._expanded = false;
        this._modal = null;
        this._signals = [];
        this._lastActive = GLib.get_monotonic_time();
        this._faded = false;

        this._buildPet();
        this._buildColumn();
        this._buildEntry();
        this._buildIndicator();
        this._place();

        Main.wm.addKeybinding('talk', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._talk());

        // The URL handler (natsumi-url-handler.desktop) hands natsumi://oauth/callback here.
        this._dbus = Gio.DBusExportedObject.wrapJSObject(BUS_XML, {OpenUri: uri => this._session?.finishLogin(uri)});
        this._dbus.export(Gio.DBus.session, BUS_PATH);
        this._busName = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);

        for (const key of ['scale', 'face-icons'])
            this._signals.push(this._settings.connect(`changed::${key}`, () => this._resize()));
        this._signals.push(this._settings.connect('changed::server-url', () => this._startSession()));
        this._signals.push(this._settings.connect('changed::hidden', () => this._applyHidden()));
        this._applyHidden();

        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 / 6, () => this._tick());
        this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => this._watchPointer());
        this._startSession();
    }

    disable() {
        if (this._startup) Main.layoutManager.disconnect(this._startup);
        for (const id of this._signals) this._settings.disconnect(id);
        for (const id of [this._timer, this._poll]) if (id) GLib.source_remove(id);
        this._session?.stop();
        this._session = null;
        Main.wm.removeKeybinding('talk');
        this._dbus.unexport();
        Gio.bus_unown_name(this._busName);
        this._closeEntry();
        this._indicator.destroy();
        for (const actor of [this._entry, this._column, this._pet]) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._entry = this._column = this._pet = this._indicator = null;
        this._contents.clear();
        this._frames = null;
        this._settings = null;
    }

    // ---- session ----

    _startSession() {
        this._session?.stop();
        this._session = new Session(this._settings, {
            status: (text, state) => this._onStatus(text, state),
            snapshot: payload => this._onSnapshot(payload),
            event: (type, payload) => {
                this._poke();
                this._onEvent(type, payload);
            },
        });
        this._session.start();
        // The avatar needs no login, so she shows up before the owner logs in.
        if (this._session.origin) this._loadAvatar();
    }

    _onStatus(text, state) {
        this._statusItem.label.text = text;
        this._loginItem.visible = ['logged-out', 'logging-in'].includes(state);
        this._logoutItem.visible = !['logged-out', 'logging-in', 'no-server'].includes(state);
        this._dot.visible = state !== 'online';
        if (state === 'online' && !this._avatar) this._loadAvatar();
    }

    _onSnapshot(p) {
        const m = this._model;
        m.messages = p.messages ?? [];
        m.cursor = p.readThroughMessageId ?? null;
        m.unread = p.unreadReplyCount ?? 0;
        m.notices = p.unacknowledgedNotificationIds ?? [];
        m.expression = p.avatar?.expression ?? 'neutral';
        m.thinking = '';
        m.pending = (p.pendingEvents ?? []).length > 0;
        if (p.avatarVersion && p.avatarVersion !== m.avatarVersion) {
            m.avatarVersion = p.avatarVersion;
            this._loadAvatar();
        }
        this._refresh();
    }

    _onEvent(type, p) {
        const m = this._model;
        switch (type) {
        case 'conversation.message':
            m.messages.push(p);
            if (m.messages.length > MESSAGES_KEPT) m.messages.shift();
            if (p.kind === 'reply') {
                m.unread += 1;
                this._expanded = false;
            }
            if (p.kind === 'notice') m.notices.push(p.messageId);
            // The owner's message, from any device, is a turn she has yet to finish.
            if (p.role === 'owner') m.pending = true;
            break;
        case 'conversation.read':
            m.cursor = p.readThroughMessageId;
            m.unread = p.unreadReplyCount;
            break;
        case 'notification.acked':
            m.notices = m.notices.filter(id => id !== p.notificationId);
            break;
        case 'avatar.expression':
            m.expression = p.expression;
            break;
        case 'conversation.thinking':
            m.thinking = p.line ?? '';
            break;
        case 'conversation.event.completed':
            m.thinking = '';
            m.pending = false;
            break;
        case 'service.unavailable':
            this._statusItem.label.text = `natsumi は休んでいます（${p.code}）`;
            if (p.avatarVersion && p.avatarVersion !== m.avatarVersion) {
                m.avatarVersion = p.avatarVersion;
                this._loadAvatar();
            }
            break;
        case 'command.rejected':
            this._statusItem.label.text = `送れませんでした（${p.code}）`;
            break;
        default:
            return;
        }
        this._refresh();
    }

    async _loadAvatar() {
        const session = this._session;
        if (this._loadingAvatar === session) return;
        this._loadingAvatar = session;
        try {
            const avatar = await fetchAvatar(session);
            if (session !== this._session) return;
            this._avatar = avatar;
            this._frames = new Frames(avatar);
            this._contents.clear();
            this._indicator.accessible_name = avatar.name;
            this._entry.hint_text = `${avatar.name}に話しかける（Enter で送る / Esc で閉じる）`;
            this._resize();
        } catch (e) {
            console.warn('[natsumi] avatar:', e.message);
        } finally {
            if (this._loadingAvatar === session) this._loadingAvatar = null;
        }
    }

    // ---- what the model shows ----

    /** The newest reply after the read cursor, or null. */
    _unreadReply() {
        const m = this._model;
        if (m.unread === 0) return null;
        const at = m.cursor ? m.messages.findIndex(x => x.messageId === m.cursor) : -1;
        const after = m.messages.slice(at + 1);
        return after.filter(x => x.kind === 'reply').at(-1) ?? null;
    }

    _refresh() {
        const m = this._model;
        const reply = this._unreadReply();
        this._replyLabel.text = reply ? (this._expanded ? reply.text : cut(reply.text)) : '';
        this._replyLabel.visible = !!reply;
        this._countLabel.text = m.unread > 1 ? `未読 ${m.unread} 件` : '';
        this._closeButton.visible = !!reply;
        // Her line of thinking when the server sends one; otherwise just that she is on it.
        const thinking = m.thinking || (m.pending ? '考え中…' : '');
        this._thinkingLabel.text = thinking;
        this._thinkingLabel.visible = thinking !== '';
        this._balloon.visible = !!reply || thinking !== '';

        // The newest two notices get their own card; older ones are counted.
        const shown = m.notices.slice(-2);
        this._noticeCards.forEach((card, i) => {
            const id = shown[i];
            card.visible = id !== undefined;
            if (!card.visible) return;
            card._id = id;
            const text = m.messages.find(x => x.messageId === id)?.text ?? '（前のお知らせ）';
            card._label.text = cut(text);
        });
        const older = m.notices.length - shown.length;
        this._olderLabel.text = `前の知らせが ${older} 件`;
        this._olderLabel.visible = older > 0;
        this._layoutColumn();
    }

    // ---- actors ----

    _buildPet() {
        this._pet = new St.Widget({reactive: true, track_hover: true, layout_manager: new Clutter.BinLayout()});
        this._art = new St.Widget({x_expand: true, y_expand: true});
        this._art.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        this._dot = new St.Widget({width: 10, height: 10, x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START, style: 'background-color: #999; border-radius: 5px;'});
        this._pet.add_child(this._art);
        this._pet.add_child(this._dot);
        Main.layoutManager.addTopChrome(this._pet);
        this._pet.connect('enter-event', () => {
            this._poke();
            return Clutter.EVENT_PROPAGATE;
        });

        let down = null, grab = null, moved = false;
        this._pet.connect('button-press-event', (_a, e) => {
            if (e.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            down = e.get_coords();
            moved = false;
            grab = global.stage.grab(this._pet);
            return Clutter.EVENT_STOP;
        });
        this._pet.connect('motion-event', (_a, e) => {
            if (!down) return Clutter.EVENT_PROPAGATE;
            const [x, y] = e.get_coords();
            if (moved || Math.abs(x - down[0]) + Math.abs(y - down[1]) > 3) {
                moved = true;
                const [px, py] = this._pet.get_position();
                this._movePet(px + x - down[0], py + y - down[1]);
                down = [x, y];
            }
            return Clutter.EVENT_STOP;
        });
        this._pet.connect('button-release-event', () => {
            grab?.dismiss();
            grab = null;
            if (down && !moved) this._talk();
            if (moved) this._savePosition();
            down = null;
            return Clutter.EVENT_STOP;
        });
        this._dragging = () => down !== null;
    }

    _buildColumn() {
        this._column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width: COLUMN_W, reactive: true});
        this._column.connect('enter-event', () => {
            this._poke();
            return Clutter.EVENT_PROPAGATE;
        });
        this._noticeCards = [0, 1].map(() => {
            const card = new St.BoxLayout({style: 'background-color: #fff3b0; color: #222; border-radius: 10px;' +
                ' padding: 6px 8px; margin-bottom: 6px;', visible: false});
            card._label = new St.Label({x_expand: true});
            card._label.clutter_text.line_wrap = true;
            const close = new St.Button({label: '×', style: 'color: #555; padding: 0 4px;', can_focus: false});
            close.connect('clicked', () => this._session?.send('notification.ack', {notificationId: card._id}));
            card.add_child(card._label);
            card.add_child(close);
            this._column.add_child(card);
            return card;
        });
        this._olderLabel = new St.Label({visible: false, style: 'background-color: #fff3b0; color: #555;' +
            ' border-radius: 10px; padding: 4px 8px; margin-bottom: 6px; font-size: 90%;'});
        this._column.add_child(this._olderLabel);

        this._balloon = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true, visible: false,
            style: 'background-color: white; color: #222; border-radius: 14px; padding: 8px 10px;'});
        const head = new St.BoxLayout();
        this._countLabel = new St.Label({x_expand: true, style: 'color: #888; font-size: 85%;'});
        this._closeButton = new St.Button({label: '×', style: 'color: #555; padding: 0 4px;', can_focus: false});
        this._closeButton.connect('clicked', () => {
            const reply = this._unreadReply();
            if (reply) this._session?.send('conversation.read', {throughMessageId: reply.messageId});
        });
        head.add_child(this._countLabel);
        head.add_child(this._closeButton);
        this._replyLabel = new St.Label();
        this._replyLabel.clutter_text.line_wrap = true;
        this._thinkingLabel = new St.Label({style: 'color: #888; font-style: italic;'});
        this._thinkingLabel.clutter_text.line_wrap = true;
        this._balloon.add_child(head);
        this._balloon.add_child(this._replyLabel);
        this._balloon.add_child(this._thinkingLabel);
        // A click on the text shows all of it, and again folds it.
        this._balloon.connect('button-release-event', () => {
            this._expanded = !this._expanded;
            this._refresh();
            return Clutter.EVENT_STOP;
        });
        this._column.add_child(this._balloon);
        Main.layoutManager.addTopChrome(this._column);
    }

    _buildEntry() {
        this._entry = new St.Entry({width: COLUMN_W, visible: false, hint_text: '話しかける（Enter で送る / Esc で閉じる）',
            style: 'background-color: white; color: black; padding: 8px; border-radius: 10px;'});
        Main.layoutManager.addTopChrome(this._entry);
        this._entry.clutter_text.connect('activate', () => {
            const text = this._entry.get_text().trim();
            if (text !== '' && this._session?.send('conversation.send', {text}) === null) {
                // A hint does not show over typed text, so say it where it is seen, and keep the text.
                Main.notify('natsumi', `つながっていないので送れません（${this._statusItem.label.text}）`);
                this._session?.reconnect();
                return;
            }
            this._closeEntry();
        });
        this._entry.clutter_text.connect('key-press-event', (_a, e) => {
            if (e.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
            this._closeEntry();
            return Clutter.EVENT_STOP;
        });
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, 'natsumi', false);
        this._indicator.add_child(new St.Icon({icon_name: 'face-smile-symbolic', style_class: 'system-status-icon'}));
        const menu = this._indicator.menu;
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this._statusItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('話しかける', () => this._talk());
        this._shownItem = new PopupMenu.PopupSwitchMenuItem('ペットを出す', !this._settings.get_boolean('hidden'));
        this._shownItem.connect('toggled', (_i, state) => this._settings.set_boolean('hidden', !state));
        menu.addMenuItem(this._shownItem);
        menu.addAction('返事をすべて既読にする', () => {
            const last = this._model.messages.at(-1);
            if (last) this._session?.send('conversation.read', {throughMessageId: last.messageId});
        });
        menu.addAction('知らせをすべて確認する', () => {
            for (const id of this._model.notices) this._session?.send('notification.ack', {notificationId: id});
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._loginItem = menu.addAction('GitHub でログイン', () => this._session?.beginLogin());
        menu.addAction('つなぎ直す', () => this._session?.reconnect());
        menu.addAction('設定…', () => this.openPreferences());
        this._logoutItem = menu.addAction('ログアウト', () => this._session?.logout());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    // ---- placement ----

    _workArea() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }

    _size() {
        const scale = this._settings.get_int('scale') / 100;
        return this._settings.get_boolean('face-icons') ? [BASE_W * scale, BASE_W * scale] : [BASE_W * scale, BASE_H * scale];
    }

    _place() {
        // The work area is empty until the shell has started.
        if (Main.layoutManager._startingUp) {
            this._startup = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startup);
                this._startup = 0;
                this._place();
            });
            return;
        }
        const [w, h] = this._size();
        this._pet.set_size(w, h);
        const wa = this._workArea();
        const x = this._settings.get_int('pet-x'), y = this._settings.get_int('pet-y');
        if (x < 0 || y < 0) this._movePet(wa.x + wa.width - w - 160, wa.y + wa.height - h - 40);
        else this._movePet(x, y);
    }

    _resize() {
        const [w, h] = this._size();
        this._pet.set_size(w, h);
        this._contents.clear();
        this._shown = null;
        const [x, y] = this._pet.get_position();
        this._movePet(x, y);
    }

    _movePet(x, y) {
        const wa = this._workArea();
        const [w, h] = this._pet.get_size();
        this._pet.set_position(Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - w)),
            Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h)));
        this._layoutColumn();
    }

    _savePosition() {
        const [x, y] = this._pet.get_position();
        this._settings.set_int('pet-x', x);
        this._settings.set_int('pet-y', y);
    }

    /** The column (notices, then the balloon) sits on the pet's center line, above her, or below when there is no room. */
    _layoutColumn() {
        if (!this._column) return;
        const wa = this._workArea();
        const [px, py] = this._pet.get_position();
        const [pw, ph] = this._pet.get_size();
        const [, height] = this._column.get_preferred_height(COLUMN_W);
        const x = Math.min(Math.max(px + pw / 2 - COLUMN_W / 2, wa.x), wa.x + wa.width - COLUMN_W);
        const above = py - height - 6;
        this._column.set_position(Math.round(x), Math.round(above >= wa.y ? above : py + ph + 6));
        this._column.visible = !this._settings.get_boolean('hidden') && (this._balloon.visible || this._olderLabel.visible ||
            this._noticeCards.some(c => c.visible));
    }

    // ---- drawing ----

    _tick() {
        this._fade();
        if (!this._frames) return GLib.SOURCE_CONTINUE;
        const expression = this._model.expression;
        let key, pixbuf;
        if (this._settings.get_boolean('face-icons')) {
            key = `icon:${expression}`;
            pixbuf = () => this._frames.icon(expression);
        } else {
            const avatar = this._avatar;
            const animation = animationFor(avatar, expression);
            const calm = animation === avatar.animations[CALM] || animation === animationFor(avatar, 'neutral');
            const now = GLib.get_monotonic_time() / 1e6;
            let column;
            if (calm) {
                // Held still, played once every 20-30 s.
                if (this._calmFrame === undefined && now >= (this._nextCalm ?? 0)) this._calmFrame = 0;
                column = this._calmFrame ?? 0;
                if (this._calmFrame !== undefined && ++this._calmFrame >= animation.frames) {
                    this._calmFrame = undefined;
                    this._nextCalm = now + CALM_EVERY[0] + Math.random() * (CALM_EVERY[1] - CALM_EVERY[0]);
                }
            } else {
                this._calmFrame = undefined;
                this._nextCalm = now + CALM_EVERY[0];
                const fps = this._avatar.framesPerSecond;
                column = Math.floor(now * fps) % animation.frames;
            }
            key = `${animation.row}:${column}`;
            pixbuf = () => this._frames.cell(animation.row, column);
        }
        if (key !== this._shown) {
            this._shown = key;
            this._art.set_content(this._content(key, pixbuf));
        }
        return GLib.SOURCE_CONTINUE;
    }

    _content(key, pixbuf) {
        if (!this._contents.has(key)) {
            const p = pixbuf();
            let content = null;
            if (p) {
                content = St.ImageContent.new_with_preferred_size(p.get_width(), p.get_height());
                const context = global.stage.context.get_backend().get_cogl_context();
                content.set_bytes(context, p.read_pixel_bytes(),
                    p.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                    p.get_width(), p.get_height(), p.get_rowstride());
            }
            this._contents.set(key, content);
        }
        return this._contents.get(key);
    }

    /** Off by default: she runs from a pointer that lingers near her. */
    _watchPointer() {
        if (!this._settings.get_boolean('flee') || this._dragging() || this._modal)
            return GLib.SOURCE_CONTINUE;
        const [px, py] = global.get_pointer();
        const [x, y] = this._pet.get_position();
        const [w, h] = this._pet.get_size();
        const dx = x + w / 2 - px, dy = y + h / 2 - py, d = Math.hypot(dx, dy) || 1;
        this._near = d < w * 1.1 ? (this._near ?? 0) + 1 : 0;
        if (this._near > 10) this._movePet(x + dx / d * 12, y + dy / d * 12);
        else if (this._near === 0 && this._fled) this._savePosition();
        this._fled = this._near > 10;
        return GLib.SOURCE_CONTINUE;
    }

    _applyHidden() {
        const hidden = this._settings.get_boolean('hidden');
        this._pet.visible = !hidden;
        this._shownItem.setToggleState(!hidden);
        this._layoutColumn();
    }

    // ---- fading ----

    _poke() {
        this._lastActive = GLib.get_monotonic_time();
        this._fade();
    }

    /** After fade-seconds without a pointer on her, a reply or a word to her, she goes see-through. */
    _fade() {
        const seconds = this._settings.get_int('fade-seconds');
        const faded = seconds > 0 && !this._modal && !this._pet.hover &&
            GLib.get_monotonic_time() - this._lastActive > seconds * 1e6;
        if (faded === this._faded) return;
        this._faded = faded;
        const opacity = faded ? Math.round(this._settings.get_int('fade-opacity') * 255 / 100) : 255;
        for (const actor of [this._pet, this._column]) actor.ease({opacity, duration: faded ? 1000 : 200});
    }

    // ---- talking ----

    _talk() {
        if (this._modal) return;
        // Talking to her brings her back, or the reply would go nowhere.
        this._settings.set_boolean('hidden', false);
        this._poke();
        // Not online (the grey dot): start over now, so the line is likely to go by the time it is typed.
        if (this._dot.visible) this._session?.reconnect();
        const [px, py] = this._pet.get_position();
        const [pw] = this._pet.get_size();
        const wa = this._workArea();
        const x = Math.min(Math.max(px + pw / 2 - COLUMN_W / 2, wa.x), wa.x + wa.width - COLUMN_W);
        this._entry.set_position(Math.round(x), Math.max(wa.y, py - 52));
        this._column.hide();
        this._entry.show();
        this._modal = Main.pushModal(this._entry, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
    }

    _closeEntry() {
        if (!this._modal) return;
        global.stage.set_key_focus(null);
        Main.popModal(this._modal);
        this._modal = null;
        this._entry.set_text('');
        this._entry.hide();
        this._layoutColumn();
    }
}
