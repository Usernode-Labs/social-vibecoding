// The build-flow preference is gone (#4311).
//
// #1049 added a saved "where changes get built" choice: Settings offered it
// as a dropdown, /api/auth/me echoed it as `devFlowPreference`, and
// POST /api/me/dev-flow wrote ONE nullable column,
// users.dev_flow_preference. #4268 took away the last reader — agent
// sessions pick where work runs in their own Build-with sheet — so #4311
// removed the setting end to end. A setting that does nothing misleads.
//
// What this file pins now, in the shape the old file established:
//   1. Behavioural: POST /api/me/dev-flow is NOT mounted — an old client
//      still holding the page gets a 404, and no UPDATE reaches the
//      database. GET /api/auth/me carries no `devFlowPreference` key, but
//      still reports whether the external flows are offerable at all (the
//      dev chat reads that to decide whether to offer Claude Code / Codex).
//   2. Source guards: no client surface names the select, the save or the
//      preference any more; the dev chat's venue sheet and launchpad do not
//      write it.
//   3. The database column and its CHECK stay, so a rollback of #4311 keeps
//      working. Dropping them is a later migration.
//
// The two dev-chat gates that never read the preference in the first place
// (#1353) are still pinned below.
//
// Run with: node --test tests/dev-flow-preference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes. `calls` records every query so
// the not-mounted assertion can prove no UPDATE reached the database.
const poolMod = require('../src/db/pool');
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      return { rows: [{ dev_flow_preference: null }] };
    }
    return { rows: [] };
  },
});

const { authRoutes } = require('../src/routes/auth');

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
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const flowUpdate = () => calls.find((c) => /UPDATE users SET dev_flow_preference/.test(c.sql));

// ── 1. The save route is not mounted ────────────────────────────────────

test('POST /api/me/dev-flow answers 404 and never writes the column', async () => {
  // An old client still holding the page may POST from its venue sheet.
  // That call was already best-effort with errors swallowed, so a 404
  // changes nothing it can see.
  for (const body of [{ flow: 'codex' }, { flow: null }, {}]) {
    calls = [];
    const r = await fetch(`${base}/api/me/dev-flow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 404, `expected 404 for ${JSON.stringify(body)}`);
    assert.equal(flowUpdate(), undefined, 'no UPDATE on a removed route');
  }
});

// ── 2. /api/auth/me ─────────────────────────────────────────────────────

test('/api/auth/me carries no devFlowPreference key', async () => {
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal('devFlowPreference' in j.user, false,
    'the echo is gone — a client still reading it must read absence, not null');
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

// ── 3. Source guards: no surface names the setting any more ─────────────

test('Settings no longer offers the preference', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(js, /settings-dev-flow/, 'no select or status line');
  assert.doesNotMatch(js, /_saveDevFlow\b/, 'and no save');
  assert.doesNotMatch(js, /devFlowPreference/, 'and no preference in state');
  assert.doesNotMatch(js, /build-venue/, 'and no part in the registry');

  const pane = read('frontend/src/features/settings/sections/connectors.tsx');
  assert.doesNotMatch(pane, /settings-dev-flow|dev-flow-pref-section|build-venue/,
    'the Connectors & CLI pane does not render the block');

  const facade = read('frontend/src/features/settings/facade.js');
  assert.doesNotMatch(facade, /devFlowPreference/,
    'the pre-takeover facade does not prime it either');
});

test('the dev chat no longer saves the preference', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /\/api\/me\/dev-flow/, 'no call to the removed route');
  assert.doesNotMatch(devChat, /_saveDevFlowPreference/, 'and no save helper');
});

// ── 4. The column stays, for rollback safety ────────────────────────────

test('schema keeps the nullable column and its constraint', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT/);
  assert.match(schema, /users_dev_flow_preference_chk/,
    'the constraint stays so a rollback keeps working');
  assert.match(schema, /CHECK \(dev_flow_preference IS NULL/,
    'NULL must stay legal — it was the "ask me every time" default');
});

// ── 5. The gates that never read the preference (#1353) still hold ──────

test('the dev chat asks nothing at creation, and assumes nothing either', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /forcePicker/,
    'nothing re-asks at creation time — the venue dropdown is the door now');
  // #1353: and nothing ANSWERS for the user either. A hand-off is a choice
  // made about THIS session now, through the dropdown, and recorded on it
  // (chat_sessions.build_venue).
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
  // The walkthrough has one cause: the venue this session is in, which is a
  // deliberate act (#1281 — a hand-off chosen halfway through a session is
  // still a hand-off). So the assertion is that there is ONE input.
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
    && frame.indexOf('data-plus="import-pr"') < frame.indexOf('groupKey="settings"'));
  assert.match(frame, /label="Settings &amp; rules"[\s\S]{0,80}groupKey="settings"[\s\S]{0,40}divider/);
  // A heading must not be a <button>: _wirePlusMenu collects
  // `button[data-plus]` for the touch action sheet, and a heading that
  // matched would arrive there as a tappable row that does nothing.
  const fnStart = frame.indexOf('function PlusMenuHeading(');
  assert.ok(fnStart !== -1, 'the PlusMenuHeading primitive must exist');
  // Slice from the RETURN, not the signature: the destructured props' type
  // annotation closes with a `}` in column 0, which is not the function's end.
  const fn = frame.slice(fnStart, frame.indexOf('\n}\n', frame.indexOf('return (', fnStart)));
  assert.match(fn, /<div\s+data-plus-group=/, 'headings render as a div');
  assert.ok(!fn.includes('data-plus="'), 'a heading carries no data-plus');
  // The touch sheet renders them too, since it has no heading primitive.
  assert.match(appView, /button\[data-plus\], \[data-plus-group\]/,
    'the action sheet walks headings and rows together, in DOM order');
});
