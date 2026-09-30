import assert from 'node:assert/strict';
import test from 'node:test';
import {
  messagePage, page, refusedPage, renderStatus, signedInPage, signedOutPage, statusPage, type DashboardStatus,
} from '../src/server/dashboard-view.ts';
import { html } from '../src/server/html.ts';

const HOSTILE = '<img src=x onerror=alert(1)>';

function status(overrides: Partial<DashboardStatus['loop']> = {}, server: DashboardStatus['server'] = {
  healthy: true, reason: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T03:00:00.000Z',
}): DashboardStatus {
  return {
    timeZone: 'Asia/Tokyo', server,
    loop: {
      unavailable: null,
      routes: { defaultRoute: 'subscription', current: 'subscription', chosen: 'own',
        routes: [{ name: 'subscription', provider: 'openai-codex', model: 'gpt-5.5', ready: true },
          { name: 'own', provider: 'openai-compatible', model: 'fixture-model', ready: false }] },
      fold: 'on',
      context: { tokens: 41_250, measuredAt: '2026-01-01T02:59:00.000Z', compactionThreshold: 60_000 },
      lastCompactionAt: '2025-12-31T20:00:00.000Z',
      turn: { turnId: 'turn-running-1', startedAt: '2026-01-01T02:58:30.000Z', eventKinds: 'mac_message+slack_mention', phase: 'turn' },
      queueLength: 2,
      ...overrides,
    },
  };
}

test('the state section shows every field, with times in the configured time zone', () => {
  const text = renderStatus(status()).text;
  assert.match(text, /動いている/);
  assert.match(text, /2026-01-01 12:00:00/, 'the heartbeat, in Asia/Tokyo');
  assert.match(text, /subscription/);
  assert.match(text, /own/);
  assert.match(text, /次のターンから own/, 'a route chosen and not in use yet is told apart');
  assert.match(text, /準備ができていない/, 'a candidate that is not ready says so');
  assert.match(text, /畳み込み[\s\S]*on/);
  assert.match(text, /41,250/);
  assert.match(text, /60,000/);
  assert.match(text, /69%/);
  assert.match(text, /2026-01-01 05:00:00/, 'the last compaction');
  assert.match(text, /2026-01-01 11:58:30/, 'when the running turn started');
  assert.match(text, /mac_message\+slack_mention/);
  assert.match(text, /キュー[\s\S]*2/);
});

test('a stale heartbeat, a loop that cannot talk and an idle loop are shown as such', () => {
  const text = renderStatus(status({ unavailable: 'pi-unavailable', turn: null, lastCompactionAt: null,
    context: { tokens: null, measuredAt: null, compactionThreshold: 60_000 },
    routes: { defaultRoute: 'subscription', current: null, chosen: 'subscription', routes: [] } },
  { healthy: false, reason: 'heartbeat stale', updatedAt: '2026-01-01T00:00:00.000Z' })).text;
  assert.match(text, /応答がない/);
  assert.match(text, /heartbeat stale/);
  assert.match(text, /pi-unavailable/);
  assert.match(text, /実行中のターン[\s\S]*なし/);
  assert.match(text, /最後の compaction[\s\S]*まだない/);
  assert.match(text, /文脈[\s\S]*まだ測っていない/);
});

test('the memo and the compaction after a turn are shown as its phases', () => {
  assert.match(renderStatus(status({ turn: { turnId: 'turn-running-1', startedAt: '2026-01-01T00:00:00.000Z', eventKinds: 'ping', phase: 'memo' } })).text, /一行メモ/);
  assert.match(renderStatus(status({ turn: { turnId: 'turn-running-1', startedAt: '2026-01-01T00:00:00.000Z', eventKinds: 'ping', phase: 'compaction' } })).text, /compaction 中/);
});

test('names that came from settings are escaped like everything else', () => {
  const text = renderStatus(status({
    routes: { defaultRoute: HOSTILE, current: HOSTILE, chosen: HOSTILE, routes: [{ name: HOSTILE, provider: HOSTILE, model: HOSTILE, ready: true }] },
    turn: { turnId: 'turn-running-1', startedAt: '2026-01-01T00:00:00.000Z', eventKinds: HOSTILE, phase: 'turn' },
  })).text;
  assert.ok(!text.includes('<img'));
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the running turn links to its detail', () => {
  const text = renderStatus(status()).text;
  assert.match(text, /<a href="\/dashboard\/turns\/turn-running-1">/);
});

test('the frame of every page is headed by the avatar’s ID, in the header and the title', () => {
  const text = page('ターン', html`<p>本文</p>`, { signedIn: true, current: 'ターン', avatarId: 'hana' }).text;
  assert.match(text, /<h1>hana<\/h1>/);
  assert.match(text, /<title>ターン — hana<\/title>/);
  assert.doesNotMatch(text, /natsumi<\/(h1|title)>/);
  assert.match(signedInPage('/dashboard', 'hana').text, /<title>ログインしました — hana<\/title>/);
  assert.match(signedOutPage('hana').text, /<h1>hana<\/h1>/);
  assert.match(refusedPage('access_denied', 'hana').text, /<h1>hana<\/h1>/);
  assert.match(messagePage('見つかりません', true, 'hana').text, /<title>見つかりません — hana<\/title>/);
  assert.match(statusPage(status(), 'hana').text, /<h1>hana<\/h1>/);
});

test('without an avatar the frame is headed by the default avatar’s ID', () => {
  assert.match(page('ターン', html``).text, /<h1>natsumi<\/h1>/);
  assert.match(signedInPage().text, /<title>ログインしました — natsumi<\/title>/);
});
