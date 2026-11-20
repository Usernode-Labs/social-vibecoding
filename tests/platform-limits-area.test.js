'use strict';
// The admin limits area at the top of the Notifications sheet
// (frontend/src/features/notifications/platform-limits.tsx), drawn from the
// rows services/platform-limits-view.js answers, in each state the mockup
// shows: fine, near, at, over, credit low and out, could not check, and
// several at once.
//
// Pinned here: the words each state says and the one action it offers (and
// where that goes); amber for near, red for at, over and out; that the card
// has no close, dismiss or swipe, so only a fix takes a row away; and that
// nobody but a full admin's page ever asks for the figures.
//
// Run with: node --test tests/platform-limits-area.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ENTRY = 'frontend/src/features/notifications/platform-limits.tsx';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', ENTRY), 'utf8');

const words = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const card = (rows) => words(renderComponent(ENTRY, 'PlatformLimitsCard', {
  payload: { rows, broken: rows.some((r) => ['over', 'at', 'out'].includes(r.state)), checkedAt: '2026-11-20T12:00:00Z' },
}));
const rowOf = (html, key) => {
  const start = html.indexOf(`data-limit-row="${key}"`);
  assert.ok(start >= 0, `a ${key} row`);
  const end = html.indexOf('</li>', start);
  return html.slice(start, end);
};

const APPS_NEAR = { key: 'apps', state: 'near', used: 262, cap: 300, left: 38, percent: 87 };
const APPS_AT = { key: 'apps', state: 'at', used: 300, cap: 300, left: 0, percent: 100 };
const APPS_OVER = { key: 'apps', state: 'over', used: 314, cap: 300, left: 0, percent: 100 };
const CREDIT_LOW = { key: 'openrouter_credit', state: 'near', balanceCents: 18400, warnCents: 50000, urgentCents: 20000, daysLeft: 2, urgent: true };
const CREDIT_OUT = { key: 'openrouter_credit', state: 'out', balanceCents: 0, since: null };
const CREDIT_UNKNOWN = { key: 'openrouter_credit', state: 'unknown', reason: 'no_answer', balanceCents: 41200 };
const SESSIONS_NEAR = { key: 'sessions', state: 'near', used: 164, cap: 180, left: 16, percent: 91 };
const DB_NEAR = { key: 'db_connections', state: 'near', used: 74, cap: 85, left: 11, percent: 87 };

test('all fine: the area draws nothing at all', () => {
  assert.equal(renderComponent(ENTRY, 'PlatformLimitsCard', { payload: { rows: [], broken: false } }), '');
  assert.equal(renderComponent(ENTRY, 'PlatformLimitsCard', { payload: null }), '');
});

test('near the app limit: amber, the figure in words, and Raise the limit', () => {
  const html = card([APPS_NEAR]);
  assert.match(html, /data-platform-limits=""/);
  assert.match(html, new RegExp(message('notifications:limits.heading')));
  const row = rowOf(html, 'apps');
  assert.match(row, /data-limit-tone="near"/);
  assert.match(row, /Near the limit/);
  assert.match(row, /Apps: 262 of 300/);
  assert.match(row, /New projects stop at 300 for everyone but full admins\. 38 left\./);
  assert.match(row, /text-amber-700/, 'amber for near');
  assert.doesNotMatch(row, /text-red-/);
  assert.match(row, /width:87%/, 'the meter shows how full it is');
  assert.match(row, /<a [^>]*href="#admin\/limits"[^>]*data-limit-action="raise"|<a [^>]*data-limit-action="raise"[^>]*href="#admin\/limits"/);
  assert.match(row, />Raise the limit</);
  assert.match(html, /Only full admins see this\. A row stays until its figure is back under its line\./);
});

test('at and over the app limit: red, and still one action to the fix', () => {
  const at = rowOf(card([APPS_AT]), 'apps');
  assert.match(at, /data-limit-tone="broken"/);
  assert.match(at, /At the limit/);
  assert.match(at, /Apps: 300 of 300/);
  assert.match(at, /New projects are refused for everyone but full admins\./);
  assert.match(at, /text-red-600/, 'red for at');
  assert.match(at, /bg-violet-600/, 'the fix is the filled action');
  const over = rowOf(card([APPS_OVER]), 'apps');
  assert.match(over, /Over the limit/);
  assert.match(over, /Apps: 314 of 300/);
  assert.match(over, /Only full admins can still make projects\. Everyone else is refused\./);
});

test('credit low: the amount, the line, the days, and Add credit on OpenRouter', () => {
  const row = rowOf(card([CREDIT_LOW]), 'openrouter_credit');
  assert.match(row, /Running low/);
  assert.match(row, /OpenRouter credit: \$184 left/);
  assert.match(row, /Under \$200\. At this week's spend that lasts about 2 days\. At \$0 the bot stops planning and building\./);
  assert.match(row, /href="https:\/\/openrouter\.ai\/settings\/credits"/);
  assert.match(row, /target="_blank"/);
  assert.match(row, /rel="noopener noreferrer"/);
  assert.match(row, /class="sr-only">\(opens in a new tab\)</);
  assert.doesNotMatch(row, /width:/, 'credit has no meter');
});

test('credit out: red, and what is paused', () => {
  const row = rowOf(card([CREDIT_OUT]), 'openrouter_credit');
  assert.match(row, /data-limit-tone="broken"/);
  assert.match(row, /Out of credit/);
  assert.match(row, /OpenRouter credit: out/);
  assert.match(row, /The bot's plans and builds are paused, and pick up again once there is credit\./);
  assert.match(row, />Add credit</);
});

test("couldn't check: grey, the last figure, and Check again", () => {
  const row = rowOf(card([CREDIT_UNKNOWN]), 'openrouter_credit');
  assert.match(row, /data-limit-tone="unknown"/);
  assert.match(row, /Couldn't check/);
  assert.match(row, /The last read got no answer from OpenRouter\. The last figure was \$412\./);
  assert.match(row, /<button type="button"[^>]*data-limit-action="check"/);
  assert.match(row, /Check again/);
  assert.doesNotMatch(row, /text-red-|text-amber-/);
});

test('several at once: every row, in the order the server ranked them', () => {
  const html = card([CREDIT_OUT, APPS_AT, SESSIONS_NEAR, DB_NEAR]);
  const order = [...html.matchAll(/data-limit-row="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['openrouter_credit', 'apps', 'sessions', 'db_connections']);
  assert.match(rowOf(html, 'sessions'), /Sessions: 164 of 180/);
  assert.match(rowOf(html, 'sessions'), /At 180, new sessions pause idle ones, then are refused\./);
  assert.match(rowOf(html, 'db_connections'), /Database connections: 74 of 85/);
  assert.match(rowOf(html, 'db_connections'), /href="#admin\/status"/);
  assert.match(rowOf(html, 'db_connections'), /See connections/);
});

test('#6901 hook: a count of people turned away is said when it arrives', () => {
  const row = rowOf(card([{ ...APPS_AT, turnedAway: 3 }]), 'apps');
  assert.match(row, /New projects are refused for everyone but full admins\. 3 people were turned away\./);
  assert.doesNotMatch(rowOf(card([APPS_AT]), 'apps'), /turned away/, 'nothing until it is counted');
});

test('there is no close, dismiss or swipe: only a fix takes a row away', () => {
  const html = card([CREDIT_OUT, APPS_AT, SESSIONS_NEAR, CREDIT_UNKNOWN]);
  assert.doesNotMatch(html, new RegExp(message('core:common.close')), 'no close');
  assert.doesNotMatch(html, /dismiss|Dismiss|data-notif-swipe|aria-label="Close/i);
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /onDismiss|dismiss|swipe|snooze|localStorage|sessionStorage|onTouchStart|onPointerDown/i,
    'no way to put the card away, and no memory of having done so');
  const actions = [...html.matchAll(/data-limit-action="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['credit', 'raise', 'raise', 'check'], 'one action a row, each to where it is fixed');
});

test('only a full admin page asks for the figures', async () => {
  const mod = loadTsx(ENTRY);
  const calls = [];
  const realWindow = globalThis.window;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ rows: [APPS_AT, { key: 'nope', state: 'at' }], broken: true }) };
  };
  try {
    for (const user of [null, { isAdmin: false, canAdminWrite: false }, { isAdmin: true, canAdminWrite: false }]) {
      globalThis.window = { App: { user } };
      await mod.refreshPlatformLimits();
    }
    assert.deepEqual(calls, [], 'signed out, a member, a view-only admin: never asked');
    globalThis.window = { App: { user: { isAdmin: true, canAdminWrite: true } } };
    await mod.refreshPlatformLimits();
    assert.deepEqual(calls, ['/api/admin/platform-limits']);
  } finally {
    globalThis.window = realWindow;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(mod.normalizeLimits({ rows: [APPS_AT, { key: 'nope', state: 'at' }, { key: 'apps', state: 'odd' }] }).rows, [APPS_AT],
    'a row this view cannot draw is left out');
});

test('both islands render nothing until their figures arrive', () => {
  assert.equal(renderComponent(ENTRY, 'PlatformLimitsDot', {}), '', 'the bell dot');
  assert.equal(renderComponent(ENTRY, 'PlatformLimitsArea', { open: true }), '', 'the sheet card');
  assert.match(SOURCE, /useSyncExternalStore\(subscribe, \(\) => snapshot, \(\) => null\)/,
    'the server snapshot is empty, so the prerendered shell is unchanged');
});
