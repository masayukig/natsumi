// gjs -m gnome/test.js — checks the parts that run outside the shell.
import GLib from 'gi://GLib';
import {challengeOf, parseOrigin} from './natsumi@masayukig.github.io/session.js';
import {loadAvatar, animationFor} from './natsumi@masayukig.github.io/avatar.js';

const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// RFC 7636 Appendix B.
eq(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'S256');

eq(parseOrigin('https://natsumi.example.com/'), 'https://natsumi.example.com', 'origin');
eq(parseOrigin(' https://natsumi.example.com:8443 '), 'https://natsumi.example.com:8443', 'origin with port');
eq(parseOrigin('http://localhost:3000'), 'http://localhost:3000', 'loopback http');
eq(parseOrigin('http://natsumi.example.com'), null, 'plain http');
eq(parseOrigin('https://natsumi.example.com/app'), null, 'path');
eq(parseOrigin('https://u:p@natsumi.example.com'), null, 'userinfo');
eq(parseOrigin('natsumi'), null, 'not a URL');

// A cache with only pet.json falls back to the Codex layout.
const dir = GLib.dir_make_tmp('natsumi-test-XXXXXX');
GLib.file_set_contents(`${dir}/pet.json`, JSON.stringify({displayName: 'いおり', spritesheetPath: 'spritesheet.webp'}));
const avatar = loadAvatar(dir, '0'.repeat(32));
eq(avatar.name, 'いおり', 'name');
eq(animationFor(avatar, 'thinking'), {row: 8, frames: 6}, 'thinking -> review');
eq(animationFor(avatar, 'angry'), {row: 0, frames: 6}, 'unknown -> idle');
// avatar.json animations replace the defaults together with the default expression table.
GLib.file_set_contents(`${dir}/avatar.json`, JSON.stringify({animations: {idle: {row: 2, frames: 3}}}));
eq(animationFor(loadAvatar(dir, '0'.repeat(32)), 'thinking'), {row: 2, frames: 3}, 'own animations');
eq(loadAvatar(dir, '0'.repeat(32)).sheet, `${dir}/spritesheet.webp`, 'sheet path');
GLib.file_set_contents(`${dir}/avatar.json`, JSON.stringify({spritesheet: '../x.webp'}));
eq(loadAvatar(dir, '0'.repeat(32)).sheet, null, 'escaping sheet');
print('ok');
