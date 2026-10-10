// The saved build-flow preference (#1049), and its removal (#4311).
//
// "Remember my choice" on the dev-chat flow picker, and later a dropdown in
// Settings, wrote ONE nullable column: users.dev_flow_preference. #1353
// stopped anything acting on it (a hand-off is a choice made about THIS
// session, recorded on chat_sessions.build_venue), and #4268 retired the
// rest of the classic chat, so a setting that did nothing was misleading
// people. #4311 removed it end to end: the Settings row, POST
// /api/me/dev-flow and the venue sheet's write to it, and the /api/auth/me
// field. The COLUMN stays, so a rollback to a build that still reads it
// finds it where it left it.
//
// Three layers:
//   1. Behavioural: the route is gone, and /api/auth/me no longer reports
//      the value even when the column holds one; it still reports whether
//      the external flows are offerable, which the venue list reads.
//   2. The column and its CHECK stay in the schema (rollback safety).
//   3. Source guards: no client surface reads or writes the preference.
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

const { authRoutes } = require('../src/routes/auth');
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

// ── 1. The route and the field are gone ─────────────────────────────────

test('POST /api/me/dev-flow is no longer mounted, and writes nothing', async () => {
  const r = await fetch(`${base}/api/me/dev-flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow: 'codex' }),
  });
  assert.equal(r.status, 404);
  assert.equal(calls.find((c) => /dev_flow_preference/.test(c.sql)), undefined,
    'no query touches the column');
});

test('/api/auth/me no longer reports the preference, even when the column holds one', async () => {
  storedFlow = 'claude-code';
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.ok(j.user, 'the endpoint still answers');
  assert.equal(Object.hasOwn(j.user, 'devFlowPreference'), false);
  const lookup = calls.find((c) => /FROM users u/.test(c.sql));
  assert.ok(lookup, 'the users lookup still runs');
  assert.doesNotMatch(lookup.sql, /dev_flow_preference/, 'and no longer reads the column');
});

test('/api/auth/me says whether the hand-off is offerable at all', async () => {
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

// ── 2. The column stays ─────────────────────────────────────────────────

test('the column and its CHECK stay in the schema, so a rollback is safe', () => {
  // Removing the setting is not dropping the data: a build from before
  // #4311 still selects the column in /api/auth/me and writes it from
  // Settings, and schema.sql is applied on every boot. Drop it, if at all,
  // in a later migration once no deployable build reads it.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT/);
  assert.match(schema, /users_dev_flow_preference_chk/);
  assert.match(schema, /CHECK \(dev_flow_preference IS NULL/);
  assert.match(schema, /DROP CONSTRAINT IF EXISTS users_dev_flow_preference_chk/);
});

// ── 3. No client surface reads or writes it ─────────────────────────────

test('Settings no longer offers the preference', () => {
  const js = read('frontend/src/features/settings/settings.js');
  const facade = read('frontend/src/features/settings/facade.js');
  const pane = read('frontend/src/features/settings/sections/connectors.tsx');
  const sections = read('frontend/src/features/settings/sections/index.tsx');
  for (const [name, src] of [['settings.js', js], ['facade.js', facade]]) {
    assert.doesNotMatch(src, /devFlowPreference|_renderDevFlowSection|_saveDevFlow|\/api\/me\/dev-flow/,
      `${name} carries nothing of the removed setting`);
  }
  assert.doesNotMatch(js, /key: 'build-venue'/, 'and it is no longer a row in the Settings menu');
  assert.doesNotMatch(pane, /BuildVenueSection|settings-dev-flow|dev-flow-pref-section/);
  assert.doesNotMatch(sections, /BuildVenueSection/);
  const html = shellMarkup();
  assert.ok(!html.includes('id="settings-dev-flow"'), 'the dropdown is not in the shell');
  assert.ok(!html.includes('data-settings-section="build-venue"'), 'nor is its part');
});

test('the venue sheet and the launchpad toggle no longer save a default', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /_saveDevFlowPreference|\/api\/me\/dev-flow|devFlowPreference/);
});

test('the dev chat asks nothing at creation, and assumes nothing either', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /forcePicker/,
    'nothing re-asks at creation time — the venue dropdown is the door now');
  // #1353: and nothing ANSWERS for the user either. The saved default used
  // to turn any untouched session into a web hand-off before a word was
  // typed — while the venue derivation, which never read the preference,
  // went on telling the header and the sheet that the session was
  // On-Platform. One preference, two screens, and the only way back was per
  // tab. A hand-off is a choice made about THIS session now, through the
  // dropdown, and recorded on it (chat_sessions.build_venue).
  const target = devChat.match(/_devFlowTarget\(\) \{[\s\S]*?\n  \},/);
  assert.ok(target, '_devFlowTarget must exist');
  assert.doesNotMatch(target[0], /devFlowPreference/,
    'the walkthrough is not summoned by a standing preference');
  const venue = devChat.match(/_currentVenueId\(\) \{[\s\S]*?\n  \},/);
  assert.ok(venue, '_currentVenueId must exist');
  assert.doesNotMatch(venue[0], /devFlowPreference/,
    'nor does the venue the whole session paints from claim one');
});

test('the walkthrough appears exactly where the session says it is handed over', () => {
  // The gates this used to check — no PR, still active, nothing typed —
  // existed to keep a walkthrough summoned by a standing PREFERENCE from
  // landing on work already under way. With that door closed (#1353) the
  // walkthrough has one cause left: the venue this session is in, which is
  // a deliberate act and outranks all three of those states by design
  // (#1281 — a hand-off chosen halfway through a session is still a
  // hand-off). So the assertion is that there is ONE input, not four.
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  const fnStart = devChat.indexOf('_devFlowTarget() {');
  assert.ok(fnStart !== -1, '_devFlowTarget must exist');
  const fn = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fn, /DevChat\._currentVenueId\(\)/, 'the venue is the whole question');
  assert.match(fn, /'web-codex'/);
  assert.match(fn, /'web-claude-code'/);
  assert.doesNotMatch(fn, /pr_number|status !== 'active'|role === 'user'/,
    'no second set of gates to fall out of step with the header');
  // And the surface asks the same one thing, which is the invariant
  // tests/venue-surface-sync.test.js drives for real.
  const launchpad = devChat.match(/_launchpadVenue\(\) \{[\s\S]*?\n  \},/);
  assert.ok(launchpad, '_launchpadVenue must exist');
  assert.match(launchpad[0], /DevChat\._currentVenueId\(\)/);
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

test('the ⋯ menu leads with its asks and names its settings group', () => {
  const appView = read('public/js/app-view.js');
  // #1084 chunk G converted the menu to JSX: the two headings are
  // <PlusMenuHeading> elements in the toolbar row now (actions-row.tsx, split
  // out of the board frame when the Workshop gained its own copy), not
  // AppView._plusMenuHeading() calls. #1490 moved New change to Improve and
  // left import alone in the first group; #1900 put filing an issue back
  // beside it, under "Add to the board". The hub's ⋯ leads with that row as
  // "Suggest an improvement", and the first group needs no heading: it is the
  // menu's first, and "Settings & rules" says where the rest begins.
  const frame = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.doesNotMatch(frame, /label="Add to the board"/);
  assert.ok(frame.indexOf('data-plus="issue"') < frame.indexOf('data-plus="import-pr"')
    && frame.indexOf('data-plus="import-pr"') < frame.indexOf('data-plus="settings"'));
  // #4045: one "Settings & rules" row now, which opens the settings on top.
  assert.match(frame, /data-plus="settings"\s+group="settings"[\s\S]{0,120}title=\{t\('project:menu\.settings\.title'\)\}[\s\S]{0,240}dividerCls=\{PLUS_ROW_DIVIDER_CLS\}/);
  assert.equal(require('./lib/platform-i18n').message('project:menu.settings.title'), 'Settings & rules');
  // The menu has no heading any more (#4045): "Settings & rules" is a real
  // row, a PlusRow, which a tap acts on, so it is a button carrying both
  // data-plus and its group's marker.
  assert.doesNotMatch(frame, /function PlusMenuHeading\(/);
  assert.match(frame, /data-plus=\{action\}\s+data-plus-group=\{group\}/);
  // The touch sheet renders them too, since it has no heading primitive.
  assert.match(appView, /button\[data-plus\], \[data-plus-group\]/,
    'the action sheet walks headings and rows together, in DOM order');
});
