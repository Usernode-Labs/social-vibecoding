// The saved build-flow preference (#1049), REMOVED (issue #4311).
//
// "Remember my choice" on the dev-chat flow picker, and the same dropdown in
// Settings, wrote ONE nullable column: users.dev_flow_preference. #4268
// removed every part of the classic dev chat that read the value to choose a
// venue — agent sessions pick where work runs in their own Build-with sheet —
// so a setting that does nothing but mislead goes, end to end: the Settings
// block, POST /api/me/dev-flow, the /api/auth/me echo and Global Chat's
// settings-inspector row. The COLUMN stays (nullable TEXT, CHECK intact) so
// restoring the previous build restores a working setting with its data; a
// later change may drop it.
//
// Layers, still in the shape tests/user-locale.test.js established for the
// sibling `locale` preference:
//   1. Behavioural: the routes with a stubbed pool — POST /api/me/dev-flow is
//      no longer mounted (an ordinary 404), and /api/auth/me keeps
//      externalFlowsAvailable but carries no devFlowPreference.
//   2. Source guards down the chain: no DEV_FLOWS export, no Settings
//      control, the three shell ids in RETIRED_IDS, the column and its
//      CHECK still in the schema, and Global Chat's authProjection.
//
// The two-way agreement between DevFlowSelect.FLOWS and the CHECK constraint
// is pinned in tests/dev-flow-select.test.js.
//
// Run with: node --test tests/dev-flow-preference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes. `storedFlow` is what the
// /api/auth/me user lookup reports back, so the round-trip can be exercised
// without a database.
const poolMod = require('../src/db/pool');
let calls = [];
let storedFlow = null;
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      return { rows: [{ dev_flow_preference: storedFlow }] };
    }
    return { rows: [] };
  },
});

const authMod = require('../src/routes/auth');
const { authRoutes } = authMod;
const { shellMarkup } = require('./lib/shell-markup');

// With OAuth credentials configured the hand-off is offerable; the
// no-credentials case gets its own server below.
const LINKED_CONFIG = {
  jwtSecret: 'test-secret',
  githubLinkClientId: 'client-id',
  githubLinkClientSecret: 'client-secret',
};

let server, base, bareServer, bareBase;
let user = null;

async function mount(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes(config));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return [s, `http://127.0.0.1:${s.address().port}`];
}

test.before(async () => {
  [server, base] = await mount(LINKED_CONFIG);
  // A deployment with no GitHub OAuth credentials at all. The env can also
  // supply them, so they are cleared for the duration of this file.
  delete process.env.GITHUB_LINK_CLIENT_ID;
  delete process.env.GITHUB_LINK_CLIENT_SECRET;
  [bareServer, bareBase] = await mount({ jwtSecret: 'test-secret' });
});
test.after(() => {
  // closeAllConnections first: undici keeps the sockets alive, and a bare
  // close() would wait for them and hang the runner.
  for (const s of [server, bareServer]) {
    if (!s) continue;
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    s.close();
  }
});

test.beforeEach(() => {
  calls = [];
  storedFlow = null;
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

// ── 1. The route is gone ─────────────────────────────────────────────────

test('POST /api/me/dev-flow is no longer mounted', async () => {
  const r = await fetch(`${base}/api/me/dev-flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow: 'codex' }),
  });
  assert.equal(r.status, 404, 'an ordinary not-found, the platform\'s answer to an unknown path');
  assert.equal(calls.find((c) => /UPDATE users SET dev_flow_preference/.test(c.sql)), undefined,
    'a stale cached shell\'s save must never write a row');
});

test('auth.js exports no DEV_FLOWS and reads no dev_flow_preference', () => {
  const authSrc = read('src/routes/auth.js');
  assert.equal(authMod.DEV_FLOWS, undefined,
    'the route allowlist is gone with the route');
  assert.doesNotMatch(authSrc, /dev_flow_preference/,
    'the /api/auth/me lookup selects the column no more');
  assert.doesNotMatch(authSrc, /devFlowPreference/,
    'and the response projection carries no devFlowPreference');
});

// ── 2. /api/auth/me ─────────────────────────────────────────────────────

test('/api/auth/me no longer echoes a saved preference', async () => {
  // A stored value keeps its column unread; the response must not carry
  // the field at all, whatever the lookup happens to read.
  storedFlow = 'claude-code';
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.ok(!('devFlowPreference' in j.user),
    'a field that controls nothing must not be reported');
});

test('/api/auth/me still says whether the hand-off is offerable at all', async () => {
  const linked = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(linked.user.externalFlowsAvailable, true,
    'with GitHub OAuth configured, Claude Code / Codex can be offered');

  const bare = await (await fetch(`${bareBase}/api/auth/me`)).json();
  assert.equal(bare.user.externalFlowsAvailable, false,
    'with no GitHub credentials there is nothing to guide anyone through');
  // Still a real boolean, not a missing key the client would read as
  // undefined and render inconsistently.
  assert.equal(typeof bare.user.externalFlowsAvailable, 'boolean');
});

// ── 3. Chain source guards ──────────────────────────────────────────────

test('schema keeps the nullable column and its constraint', () => {
  // No migration: restoring the previous build restores a working setting
  // with its data. The comment above the column says it is retained but
  // no longer written or read.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT/);
  assert.match(schema, /users_dev_flow_preference_chk/,
    'the constraint stays so a direct DB write can never park an unrenderable value here');
  assert.match(schema, /CHECK \(dev_flow_preference IS NULL/,
    'NULL must stay legal — it was the "ask me every time" default');
  assert.match(schema, /RETAINED but no longer written or read/,
    'the column\'s comment says what this change did to it');
});

test('Settings no longer offers the preference as a dropdown', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(js, /_renderDevFlowSection|_saveDevFlow\b/,
    'the render and save are gone whole, behind a control that no longer renders');
  assert.doesNotMatch(js, /\/api\/me\/dev-flow/,
    'no dead fetch');
  assert.doesNotMatch(js, /devFlowPreference/,
    'the state, the read off /api/auth/me and the mirror onto App.user are gone');
  assert.match(js, /externalFlowsAvailable/,
    'the offerable-at-all flag stays — Global Chat and the CLI page still read it');

  const pane = read('frontend/src/features/settings/sections/connectors.tsx');
  assert.doesNotMatch(pane, /dev-flow-pref-section|settings-dev-flow|data-settings-section="build-venue"/,
    'the block is gone from the Connectors & CLI page');
  assert.match(pane, /data-settings-section="connectors"/,
    'and the connectors it shared the page with are untouched');
  assert.doesNotMatch(shellMarkup(), /id="settings-dev-flow"/,
    'so the dropdown is NOT in the prerendered document');
  const index = read('frontend/src/features/settings/sections/index.tsx');
  assert.doesNotMatch(index, /BuildVenueSection/,
    'the section is not imported or rendered');
  const settings = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(settings, /key: 'build-venue'/,
    'and there is no row in the Settings sections list to deep-link to');
});

test('the three shell ids are retired with a reason', () => {
  const inventory = read('tests/shell-id-inventory.test.js');
  for (const id of ['dev-flow-pref-section', 'settings-dev-flow', 'settings-dev-flow-status']) {
    assert.match(inventory, new RegExp(`'${id}':`),
      `${id} is a line in RETIRED_IDS, not silently dropped`);
  }
  assert.match(inventory, /#4311/, 'and the reason names this change');
});

test('the dev chat no longer saves a global default', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /_saveDevFlowPreference/,
    'the best-effort save of the default is deleted, not kept as an empty gesture');
  assert.doesNotMatch(devChat, /\/api\/me\/dev-flow/,
    'and nothing in the venue sheet or the launchpad calls the removed route');
  // The sheet's real job — tying the session to its venue — stays.
  assert.match(devChat, /_persistBuildVenue/,
    'the per-session venue write is untouched');
  assert.doesNotMatch(devChat, /dev_flow_preference/,
    'the comment that named a saved dev_flow_preference as a way back is gone');
  // The gates this used to check — no PR, still active, nothing typed —
  // existed to keep a walkthrough summoned by a standing PREFERENCE from
  // landing on work already under way. With that door closed (#1353) the
  // walkthrough has one cause left: the venue this session is in, which is
  // a deliberate act and outranks those states by design (#1281).
  const fnStart = devChat.indexOf('_devFlowTarget() {');
  assert.ok(fnStart !== -1, '_devFlowTarget must exist');
  const fn = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fn, /DevChat\._currentVenueId\(\)/, 'the venue is the whole question');
  assert.match(fn, /'web-codex'/);
  assert.match(fn, /'web-claude-code'/);
  assert.doesNotMatch(fn, /devFlowPreference|pr_number|status !== 'active'|role === 'user'/,
    'no second input to fall out of step with the header');
});

test('Global Chat keeps externalFlowsAvailable without devFlowPreference', () => {
  const caps = read('src/services/global-chat/classic-capabilities.js');
  // Scope to the authProjection fields block — the SOURCES map also has a
  // 'build-venue' entry, which stays.
  const block = caps.match(/const fields = \{[\s\S]*?\}\[group\] \|\| \[\];/);
  assert.ok(block, 'the authProjection fields block exists');
  const group = block[0].match(/'build-venue': \[([^\]]*)\]/);
  assert.ok(group, 'the build-venue group still exists');
  assert.match(group[1], /externalFlowsAvailable/,
    'the inspector still says whether hand-offs are possible in this deployment');
  assert.doesNotMatch(group[1], /devFlowPreference/,
    'the saved-preference row is gone from the auth projection');

  const inventory = read('src/services/global-chat/classic-inventory.generated.json');
  assert.ok(!inventory.includes('/api/me/dev-flow'),
    'the route entry is gone from the generated inventory');
  assert.ok(!inventory.includes('#settings/build-venue'),
    'and the Settings section entry with it');
  assert.match(inventory, /\/api\/apps\/:slug\/dev-flow\/status/,
    'the per-app dev-flow route, which this change does not touch, stays');
});

test('the "+" menu asks nothing about venue', () => {
  // "Propose with Claude Code or Codex" sat one row under "Propose a
  // change" and meant the same thing, so the menu made the venue a fork in
  // the road before the work existed — and could only name two of six.
  const appView = read('public/js/app-view.js');
  assert.ok(!appView.includes('data-plus="proposal-external"'),
    'the second propose row is gone');
  assert.ok(!/createProposal\(\{ pickFlow: true \}\)/.test(appView),
    'and nothing re-opens a picker that no longer exists');
  // The one surviving programmatic entry is the out-of-credits card's, and
  // it stays: that user has been refused here, so a venue IS decided for
  // them.
  assert.match(appView, /createProposal\(\{ flow \}\)/,
    'the out-of-credits hand-off still opens its walkthrough directly');
});