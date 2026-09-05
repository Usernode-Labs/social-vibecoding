// Tests for the platform-level user language preference (issue #757).
//
// Three layers:
//   1. Behavioural: POST /api/me/locale mounted with a stubbed pool —
//      valid tags persist, casing is normalized (pt-br → pt-BR), null/""
//      clears, malformed/oversized input is a 400, unauthenticated is a
//      401 — and /api/auth/me round-trips the value from req.user.
//   2. Source guards on the iframe-token mint (server.js): the SELECT
//      includes the locale column and the signed payload gains a
//      `locale` claim ADDITIVELY — existing claims, secret and expiry
//      pinned unchanged.
//   3. Source guards across the rest of the chain: schema column, auth
//      middleware SELECT/mapping, Settings markup + wiring, and the
//      shell's __usernode_locale handling (the bridge side is pinned in
//      tests/usernode-bridge.test.js).
//
// Run with: node --test tests/user-locale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes: record UPDATE calls, return
// empty rows for the incidental /api/auth/me lookups (BYOK key, app count).
const poolMod = require('../src/db/pool');
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [] };
  },
});

const { authRoutes } = require('../src/routes/auth');
const { shellMarkup } = require('./lib/shell-markup');

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test.beforeEach(() => {
  calls = [];
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body) => fetch(`${base}/api/me/locale`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const localeUpdate = () => calls.find((c) => /UPDATE users SET locale/.test(c.sql));

// ── 1. POST /api/me/locale behaviour ────────────────────────────────────

test('401 when not authenticated', async () => {
  user = null;
  const r = await post({ locale: 'id' });
  assert.equal(r.status, 401);
});

test('accepts a plain language tag and persists it', async () => {
  const r = await post({ locale: 'id' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { ok: true, locale: 'id' });
  const upd = localeUpdate();
  assert.ok(upd, 'must run the UPDATE');
  assert.deepEqual(upd.params, ['id', 42]);
});

test('normalizes casing: language lowercase, 2-letter region uppercase', async () => {
  for (const [input, expected] of [
    ['pt-br', 'pt-BR'],
    ['EN', 'en'],
    ['ZH-cn', 'zh-CN'],
    ['de-DE', 'de-DE'],
  ]) {
    calls = [];
    const r = await post({ locale: input });
    assert.equal(r.status, 200, `expected 200 for ${input}`);
    const j = await r.json();
    assert.equal(j.locale, expected, `${input} should normalize to ${expected}`);
    assert.equal(localeUpdate().params[0], expected);
  }
});

test('longer subtags (script, variants) pass through un-cased', async () => {
  const r = await post({ locale: 'zh-Hant-TW' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.locale, 'zh-Hant-TW');
});

test('null, empty string, and whitespace clear the preference', async () => {
  for (const cleared of [null, '', '   ']) {
    calls = [];
    const r = await post({ locale: cleared });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, locale: null });
    assert.deepEqual(localeUpdate().params, [null, 42]);
  }
});

test('missing body clears too (locale undefined)', async () => {
  const r = await post({});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.locale, null);
});

test('rejects malformed and oversized tags with 400, no UPDATE', async () => {
  for (const bad of [
    'not a locale!',
    'x',              // 1-char language subtag
    'en_US',          // underscore, not hyphen
    '-en',
    'en-',
    'a'.repeat(36),   // over the 35-char cap
    'en-' + 'a'.repeat(9), // 9-char subtag
    123,
    { lang: 'en' },
    true,
  ]) {
    calls = [];
    const r = await post({ locale: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(localeUpdate(), undefined, 'must not touch the DB on invalid input');
  }
});

test('/api/auth/me round-trips the locale from req.user', async () => {
  user.locale = 'pt-BR';
  const r = await fetch(`${base}/api/auth/me`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.locale, 'pt-BR');
});

test('/api/auth/me reports null when unset', async () => {
  const r = await fetch(`${base}/api/auth/me`);
  const j = await r.json();
  assert.equal(j.user.locale, null);
});

// ── 2. Iframe-token mint source guards (server.js — guarded code) ───────

test('iframe-token mint selects the locale column alongside the pubkey', () => {
  const src = read('server.js');
  assert.match(src, /SELECT usernode_pubkey, locale FROM users WHERE id = \$1/);
});

test('iframe-token payload gains the locale claim additively', () => {
  const src = read('server.js');
  const mintStart = src.indexOf("app.get('/api/iframe-token'");
  assert.ok(mintStart !== -1, 'mint route must exist');
  const signAt = src.indexOf('signAppIdentityToken', mintStart);
  assert.notStrictEqual(signAt, -1, 'mint must delegate to platform-jwt');
  const mint = src.slice(mintStart, src.indexOf('});', signAt) + 3);
  // New claim present…
  assert.match(mint, /locale: userLocale/);
  // …and every pre-existing claim unchanged across the RSA cutover.
  assert.match(mint, /id: req\.user\.id/);
  assert.match(mint, /username: req\.user\.username/);
  assert.match(mint, /usernode_pubkey: usernodePubkey/);
  // The signing key and the TTL moved into services/platform-jwt.js when
  // the shared config.jwtSecret was retired; the route now names the app
  // it is minting for instead, which is what scopes the audience.
  assert.match(mint, /appId: appRow\.id/);
  assert.ok(!/config\.jwtSecret/.test(src),
    'the retired shared secret must have no reader left in server.js');
  const pj = read('src/services/platform-jwt.js');
  assert.match(pj, /IFRAME_TTL = '1h'/, 'the 1h iframe TTL is preserved');
});

// ── 3. Chain source guards ──────────────────────────────────────────────

test('schema adds the nullable locale column', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR\(35\)/);
});

test('auth middleware selects the column and maps req.user.locale', () => {
  const mw = read('src/middleware/auth.js');
  // Both user-row lookups (cookie-session join + staging by-id) carry it.
  assert.match(mw, /u\.locale/, 'session SELECT must include the column');
  // has_platform_access rides the same by-id lookup since the onboarding
  // flow alignment (platform-access gate).
  // The columns between ai_progress_estimate and locale are not this test's
  // business — #1281 added session_bridge_enabled there. What matters is
  // that locale is still selected by the by-id lookup and still arrives
  // beside has_platform_access, so the pattern spans whatever sits between.
  assert.match(mw, /ai_progress_estimate,[\w\s,]*locale, has_platform_access FROM users WHERE id = \$1/);
  assert.match(mw, /locale: rows\[0\]\.locale \|\| null/);
  assert.match(mw, /locale: userRow\.locale \|\| null/);
});

test('/api/auth/me payload exposes locale', () => {
  const src = read('src/routes/auth.js');
  assert.match(src, /locale: req\.user\.locale \?\? null/);
});

test('Settings markup has the Language section', () => {
  const html = shellMarkup();
  assert.match(html, /id="settings-locale"/);
  assert.match(html, /id="settings-locale-status"/);
  assert.match(html, /Auto: use device language/);
});

test('settings.js wires the picker to POST /api/me/locale and the live push', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /_renderLanguageSection/);
  assert.match(js, /_saveLocale/);
  assert.match(js, /\/api\/me\/locale/);
  assert.match(js, /notifyLocaleChanged/);
});

test('the Settings picker is gated on an already-saved locale (#1556)', () => {
  // The platform shell is English-only, so a "Language" row in Preferences
  // reads as a UI language switch and does nothing visible. The value only
  // ever reached APPS, so the picker is no longer offered by default — but
  // it stays reachable for the accounts that already have one saved, and
  // every read path above this line is untouched.
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /\{ key: 'language', label: 'Language', group: 'Preferences', gate: 'settings-language-section' \}/,
    'the registry entry names the gate node, which _visibleSections() reads back');
  const start = js.indexOf('    _renderLanguageSection() {');
  assert.ok(start > -1, '_renderLanguageSection exists');
  const fn = js.slice(start, start + 1200);
  assert.match(fn, /getElementById\('settings-language-section'\)/);
  assert.match(fn, /if \(!value\) \{[^}]*classList\.add\('hidden'\);[^}]*return;/,
    'no saved locale -> hidden, so the section drops out of the menu');
  assert.match(fn, /classList\.remove\('hidden'\)/,
    'a saved locale -> shown, so nobody is stranded with an unchangeable preference');
  // The pane ships hidden in the markup; the render fn is the only reveal.
  assert.match(shellMarkup(), /id="settings-language-section" class="hidden"/);
});

test('shell answers the __usernode_locale family and pushes changes', () => {
  const shell = read('public/js/app-view.js');
  assert.match(shell, /handleLocaleBridgeMessage/);
  assert.match(shell, /__usernode_locale/);
  assert.match(shell, /notifyLocaleChanged/);
  // Source gate: only the shell-owned iframes are answered.
  const fnStart = shell.indexOf('handleLocaleBridgeMessage(e)');
  const fn = shell.slice(fnStart, fnStart + 1500);
  assert.match(fn, /app-iframe/);
  assert.match(fn, /staging-iframe/);
});
