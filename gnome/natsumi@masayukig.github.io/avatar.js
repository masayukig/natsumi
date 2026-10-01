// The avatar the server hands out (contract: "アバター"): a verified copy in the cache, and the frames to draw.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

// The Codex pet layout, used for whatever avatar.json leaves out (same table as the Mac app's Avatar.swift).
const CODEX = {
    atlas: {columns: 8, rows: 9, cellWidth: 192, cellHeight: 208},
    framesPerSecond: 6,
    animations: {
        'idle': {row: 0, frames: 6}, 'running-right': {row: 1, frames: 8}, 'running-left': {row: 2, frames: 8},
        'waving': {row: 3, frames: 4}, 'jumping': {row: 4, frames: 5}, 'failed': {row: 5, frames: 8},
        'waiting': {row: 6, frames: 6}, 'running': {row: 7, frames: 6}, 'review': {row: 8, frames: 6},
    },
    expressions: {
        neutral: 'idle', sleepy: 'idle', thinking: 'review', happy: 'waving', laughing: 'jumping',
        surprised: 'jumping', worried: 'waiting', sad: 'failed',
    },
};
const decoder = new TextDecoder();

function safePath(path) {
    return typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.split('/').includes('..');
}

function sha256(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

/**
 * Fetches the listing and every file not already in the cache, checking size and sha256, and returns the avatar.
 * @param {import('./session.js').Session} session
 */
export async function fetchAvatar(session) {
    const listing = JSON.parse(decoder.decode((await session.getBytes('/v1/avatar')).toArray()));
    if (!/^[0-9a-f]{32}$/.test(listing.version ?? '') || !Array.isArray(listing.files))
        throw new Error('avatar listing is malformed');
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'natsumi-gnome', 'avatar', listing.version]);
    for (const file of listing.files) {
        if (!safePath(file.path)) throw new Error(`avatar path is not allowed: ${file.path}`);
        const local = Gio.File.new_for_path(GLib.build_filenamev([dir, file.path]));
        if (local.query_exists(null)) {
            const [, contents] = local.load_contents(null);
            if (contents.length === file.bytes && sha256(new GLib.Bytes(contents)) === file.sha256) continue;
        }
        const bytes = await session.getBytes(`/v1/avatar/${listing.version}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
        if (bytes.get_size() !== file.bytes || sha256(bytes) !== file.sha256)
            throw new Error(`avatar file does not match its listing: ${file.path}`);
        if (!local.get_parent().query_exists(null)) local.get_parent().make_directory_with_parents(null);
        local.replace_contents(bytes.toArray(), null, false, Gio.FileCreateFlags.NONE, null);
    }
    return loadAvatar(dir, listing.version);
}

/** Reads a cached copy. */
export function loadAvatar(dir, version) {
    const read = path => {
        try {
            const [, contents] = Gio.File.new_for_path(GLib.build_filenamev([dir, path])).load_contents(null);
            return JSON.parse(decoder.decode(contents));
        } catch {
            return {};
        }
    };
    const pet = read('pet.json'), manifest = read('avatar.json');
    const sheet = manifest.spritesheet ?? pet.spritesheetPath;
    // Animations given in avatar.json replace the defaults together with the default expression table.
    const own = manifest.animations !== undefined;
    return {
        version, dir,
        name: manifest.name ?? pet.displayName ?? 'natsumi',
        sheet: safePath(sheet) ? GLib.build_filenamev([dir, sheet]) : null,
        atlas: {...CODEX.atlas, ...manifest.atlas},
        framesPerSecond: manifest.framesPerSecond ?? CODEX.framesPerSecond,
        animations: own ? manifest.animations : CODEX.animations,
        expressions: own ? manifest.expressions ?? {} : {...CODEX.expressions, ...manifest.expressions},
        icons: Object.fromEntries(Object.entries(manifest.icons ?? {})
            .filter(([, p]) => safePath(p)).map(([e, p]) => [e, GLib.build_filenamev([dir, p])])),
    };
}

/** The animation an expression plays: its own, then neutral's, then idle, then the top row. */
export function animationFor(avatar, expression) {
    const a = avatar.animations;
    return a[avatar.expressions[expression]] ?? a[avatar.expressions.neutral] ?? a.idle ??
        Object.values(a).sort((x, y) => x.row - y.row)[0] ?? {row: 0, frames: 1};
}

/** Cuts frames out of the spritesheet once, and keeps them. */
export class Frames {
    constructor(avatar) {
        this._avatar = avatar;
        this._sheet = avatar.sheet ? GdkPixbuf.Pixbuf.new_from_file(avatar.sheet) : null;
        this._cache = new Map();
    }

    /** A standalone pixbuf for one cell, or null. */
    cell(row, column) {
        if (!this._sheet) return null;
        const key = `${row}:${column}`;
        if (!this._cache.has(key)) {
            const {cellWidth: w, cellHeight: h} = this._avatar.atlas;
            const x = column * w, y = row * h;
            const fits = x + w <= this._sheet.get_width() && y + h <= this._sheet.get_height();
            this._cache.set(key, fits ? this._sheet.new_subpixbuf(x, y, w, h).copy() : null);
        }
        return this._cache.get(key);
    }

    icon(expression) {
        const path = this._avatar.icons[expression] ?? this._avatar.icons.neutral;
        if (!path) return null;
        const key = `icon:${path}`;
        if (!this._cache.has(key)) {
            try {
                this._cache.set(key, GdkPixbuf.Pixbuf.new_from_file(path));
            } catch {
                this._cache.set(key, null);
            }
        }
        return this._cache.get(key);
    }
}
