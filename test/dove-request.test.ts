import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDoveRequest } from '../src/server/dove-request.ts';

/**
 * What natsumi writes to the dove (ADR 0074): one JSON object in `message`, with `kind`, `to`, and the fields its kind
 * needs. A request out of shape is turned back before anything is judged or sent, with a sentence that names the field
 * and says what to fix.
 */

const MESSAGE = { file: '/sources/slack/work/dev/2026-09-25.jsonl', path: '.[12]' };
const CHANNEL = { file: '/sources/slack/work/dev' };
const json = (value: unknown) => JSON.stringify(value);

test('a post to a message: where it goes, the feeling and the text', () => {
  const parsed = parseDoveRequest(json({ kind: 'post', to: MESSAGE, face: 'happy', text: 'おつかれさまです。\n明日やります。' }));
  assert.deepEqual(parsed, { ok: true, request: { kind: 'post', to: MESSAGE, expression: 'happy', body: 'おつかれさまです。\n明日やります。' } });
});

test('a post to a channel, without a feeling, and the JSON may be wrapped in spaces and lines', () => {
  const parsed = parseDoveRequest(`\n  ${json({ kind: 'post', to: CHANNEL, text: 'おはようございます' })}\n`);
  assert.deepEqual(parsed, { ok: true, request: { kind: 'post', to: CHANNEL, body: 'おはようございます' } });
});

test('a reaction names the emoji, with or without colons, a skin tone or a custom one of any letters', () => {
  const emoji = (name: string) => {
    const parsed = parseDoveRequest(json({ kind: 'reaction', to: MESSAGE, emoji: name }));
    return parsed.ok ? parsed.request.body : parsed.text;
  };
  assert.deepEqual(parseDoveRequest(json({ kind: 'reaction', to: MESSAGE, emoji: ':+1:' })),
    { ok: true, request: { kind: 'reaction', to: MESSAGE, body: '+1' } });
  assert.equal(emoji(':thumbsup::skin-tone-2:'), 'thumbsup::skin-tone-2');
  assert.equal(emoji('thumbsup::skin-tone-2'), 'thumbsup::skin-tone-2');
  assert.equal(emoji(':了解:'), '了解');
  assert.equal(emoji('looks-good'), 'looks-good');
});

// ADR 0044: `images` names images under /work, in order; with images the text may be left out.
test('images are named in the order written, and the text becomes their comment', () => {
  const parsed = parseDoveRequest(json({ kind: 'post', to: CHANNEL, text: '描いたよ', images: ['/work/images/cat.png', '/work/images/dog.webp'] }));
  assert.deepEqual(parsed, { ok: true, request: { kind: 'post', to: CHANNEL, body: '描いたよ',
    images: ['/work/images/cat.png', '/work/images/dog.webp'] } });
});

test('with an image the text may be left out or empty, and an empty list of images is no images', () => {
  for (const request of [{ kind: 'post', to: CHANNEL, images: ['/work/cat.png'] }, { kind: 'post', to: CHANNEL, text: '', images: ['/work/cat.png'] }]) {
    assert.deepEqual(parseDoveRequest(json(request)), { ok: true, request: { kind: 'post', to: CHANNEL, body: '', images: ['/work/cat.png'] } });
  }
  assert.deepEqual(parseDoveRequest(json({ kind: 'post', to: CHANNEL, text: 'こんにちは', images: [] })),
    { ok: true, request: { kind: 'post', to: CHANNEL, body: 'こんにちは' } });
});

test('a request that is not JSON is turned back to the manual, and the old form with headings is named as gone', () => {
  for (const message of ['こんにちは', '{"kind": "post",', '']) {
    const parsed = parseDoveRequest(message);
    assert.equal(parsed.ok, false, message);
    assert.match((parsed as { text: string }).text, /^頼んでいません。/);
    assert.match((parsed as { text: string }).text, /JSON/);
    assert.match((parsed as { text: string }).text, /\/manual\/slack\.md/);
  }
  const old = parseDoveRequest('返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: 投稿\n---\nおつかれさまです。');
  assert.equal(old.ok, false);
  assert.match((old as { text: string }).text, /見出し/);
  assert.match((old as { text: string }).text, /\/manual\/slack\.md/);
});

for (const [name, request, pattern] of [
  ['an array', [], /オブジェクト/],
  ['a string', 'post', /オブジェクト/],
  ['an unknown field', { kind: 'post', to: CHANNEL, text: 'こんにちは', channel: 'work/#dev' }, /「channel」.*kind・to・face・text・emoji・images/],
  ['no kind', { to: CHANNEL, text: 'こんにちは' }, /kind.*post.*reaction/],
  ['an unknown kind', { kind: '投稿', to: CHANNEL, text: 'こんにちは' }, /kind.*「投稿」.*post.*reaction/],
  ['no to', { kind: 'post', text: 'こんにちは' }, /to/],
  ['a to that is a string', { kind: 'post', to: 'work/#dev 2026-09-25 14:32:05 山田', text: 'こんにちは' }, /to.*file/],
  ['a to with no file', { kind: 'post', to: { path: '.[12]' }, text: 'こんにちは' }, /to\.file/],
  ['a to with a file that is not a string', { kind: 'post', to: { file: 12 }, text: 'こんにちは' }, /to\.file/],
  ['a to with an unknown field', { kind: 'post', to: { ...MESSAGE, at: '14:32:05' }, text: 'こんにちは' }, /to.*「at」/],
  ['a path not in the form of a line', { kind: 'post', to: { file: MESSAGE.file, path: '12' }, text: 'こんにちは' }, /to\.path.*\.\[12\]/],
  ['a path of a range', { kind: 'post', to: { file: MESSAGE.file, path: '.[8:13]' }, text: 'こんにちは' }, /to\.path/],
  ['an unknown feeling', { kind: 'post', to: CHANNEL, face: 'angry', text: 'こんにちは' }, /face.*「angry」.*neutral/],
  ['a text that is not a string', { kind: 'post', to: CHANNEL, text: ['こんにちは'] }, /text/],
  ['a post with neither text nor images', { kind: 'post', to: CHANNEL }, /text/],
  ['a post with blank text and no images', { kind: 'post', to: CHANNEL, text: '  \n' }, /text/],
  ['a post with an emoji', { kind: 'post', to: MESSAGE, text: 'こんにちは', emoji: '+1' }, /emoji.*reaction/],
  ['images that are not a list', { kind: 'post', to: CHANNEL, images: '/work/cat.png' }, /images/],
  ['an image with no path', { kind: 'post', to: CHANNEL, images: [''] }, /images/],
  ['an image on a relative path', { kind: 'post', to: CHANNEL, images: ['images/cat.png'] }, /\/work\//],
  ['a reaction with no emoji', { kind: 'reaction', to: MESSAGE }, /emoji/],
  ['a reaction with two emoji', { kind: 'reaction', to: MESSAGE, emoji: '+1 eyes' }, /emoji.*1 つ/],
  ['a reaction with two emoji side by side', { kind: 'reaction', to: MESSAGE, emoji: ':+1::eyes:' }, /emoji.*1 つ/],
  ['a reaction with text', { kind: 'reaction', to: MESSAGE, emoji: '+1', text: 'いいね' }, /リアクション.*text/],
  ['a reaction with images', { kind: 'reaction', to: MESSAGE, emoji: '+1', images: ['/work/cat.png'] }, /リアクション.*images/],
  ['a reaction with a feeling', { kind: 'reaction', to: MESSAGE, emoji: '+1', face: 'happy' }, /リアクション.*face/],
  ['a reaction to a channel', { kind: 'reaction', to: CHANNEL, emoji: '+1' }, /発言.*path/],
] as const) {
  test(`${name} is turned back with what to fix`, () => {
    const parsed = parseDoveRequest(json(request));
    assert.equal(parsed.ok, false);
    assert.match((parsed as { text: string }).text, pattern);
    assert.match((parsed as { text: string }).text, /^頼んでいません。/);
  });
}
