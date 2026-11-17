// GET /api/budget?demo=1 — the staging hook that makes the out-of-credits
// state reviewable.
//
// An exhausted allowance is otherwise unreachable on a staging preview
// without actually burning a real one, so a reviewer would only ever see the
// healthy layout. This adds the platform's standard staging fixture idiom
// to that one route.
//
// The property that matters is that it is a STRICT no-op in production: it
// must be gated on the deployment mode, must not read or write the
// database, and must not change the real code path.
//
// Run with: node --test tests/budget-demo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/sessions.js'), 'utf8'
);
const AUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/auth.js'), 'utf8'
);

// The demo branch, isolated from the rest of the handler.
const HANDLER = SESSIONS_SRC.slice(
  SESSIONS_SRC.indexOf("router.get('/api/budget'"),
  SESSIONS_SRC.indexOf("router.get('/api/sessions/:id/preview-status'")
);
const DEMO_BRANCH = HANDLER.slice(0, HANDLER.indexOf('try {'));
// #1788 added a second sibling fixture for the WEEKLY cap; #2571 collapsed
// the two back into ONE branch, because there is only one window left to
// demonstrate. Both spellings (?demo=1 and ?demo=weekly-out) reach it, so
// review links written against either keep working.
const DEMO_WEEKLY = DEMO_BRANCH;

test('the demo branch is gated on staging AND the explicit flag', () => {
  assert.match(
    DEMO_BRANCH,
    /process\.env\.USERNODE_ENV === 'staging'\s*\n?\s*&& \(req\.query\.demo === '1' \|\| req\.query\.demo === 'weekly-out'\)/,
    'staging AND an explicit value, so a stray ?demo=1 in production does nothing'
  );
  // It returns before any real work, so production never even evaluates it
  // beyond the one comparison.
  assert.ok(
    DEMO_BRANCH.indexOf('return res.json') > 0,
    'the branch returns its fixture directly'
  );
  assert.equal(
    (DEMO_BRANCH.match(/return res\.json/g) || []).length, 1,
    'one fixture, not one per spelling'
  );
});

test('the fixture never touches the database', () => {
  assert.doesNotMatch(DEMO_BRANCH, /pool\.query/);
  assert.doesNotMatch(DEMO_BRANCH, /await /);
  assert.doesNotMatch(DEMO_BRANCH, /limits\./);
});

test('the fixture reports the user’s own allowance as exhausted', () => {
  // An allowance reads as exhausted when spentCents >= limitCents
  // (CreditOptions.creditState), so these two must be equal.
  const spent = /spentCents: (\d+)/.exec(DEMO_BRANCH);
  const limit = /limitCents: (\d+)/.exec(DEMO_BRANCH);
  assert.ok(spent && limit);
  assert.equal(spent[1], limit[1], 'the personal allowance reads as spent');

  // …while the SHARED budget still has headroom, so the reviewed copy is
  // the ordinary "you're out" wording rather than the platform-wide one.
  const globalSpent = Number(/globalSpentCents: (\d+)/.exec(DEMO_BRANCH)[1]);
  const globalLimit = Number(/globalLimitCents: (\d+)/.exec(DEMO_BRANCH)[1]);
  assert.ok(globalSpent < globalLimit, 'the shared budget is not exhausted');

  // No BYOK spillover.
  assert.match(DEMO_BRANCH, /byokSpentCents: 0/);
  assert.match(DEMO_BRANCH, /aiEnabled: true/);
  // Flagged, so a reader can tell the fixture from a real answer.
  assert.match(DEMO_BRANCH, /demo: true/);

  // #2571: and it says WHICH window those three figures describe. There is
  // only one — the week — and the daily figures ride along switched off.
  assert.match(DEMO_BRANCH, /capWindow: 'weekly'/);
  assert.match(DEMO_BRANCH, /resetLabel: 'Monday 00:00 UTC'/);
  assert.match(DEMO_BRANCH, /dailyApplies: false/);
});

test('it mirrors the established staging-fixture idiom', () => {
  // GET /api/me/ai-budget is the sibling that set this pattern; the two
  // should look the same so neither drifts into an ad-hoc shape.
  assert.match(
    AUTH_SRC,
    /IS_STAGING && req\.query\.demo === '1'/,
    'the sibling route uses the same gate'
  );
  assert.match(AUTH_SRC, /demo: true/);
});

// ── #1788: the weekly sibling ────────────────────────────────────────────
//
// A spent WEEKLY allowance is even less reachable on a preview than a spent
// daily one — it would take seven days of seeded spend — and its copy
// differs everywhere the boundary is named ("this week", "Resets Monday
// 00:00 UTC"). So it gets its own fixture at ?demo=weekly-out rather than a
// flag on the one above, and the same no-op-in-production properties apply.

test('the ?demo=weekly-out spelling still reaches the fixture', () => {
  assert.match(
    DEMO_BRANCH,
    /req\.query\.demo === 'weekly-out'/,
    'the #1788 spelling is kept so existing review links and declared '
    + 'checks keep working, now answered by the one fixture'
  );
  assert.doesNotMatch(DEMO_BRANCH, /pool\.query/);
  assert.doesNotMatch(DEMO_BRANCH, /await /);
});

test('the fixture makes the WEEKLY cap the binding one', () => {
  // The same equality creditState reads as exhausted.
  const spent = Number(/spentCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  const limit = Number(/limitCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  assert.equal(spent, limit, 'the reported allowance reads as spent');

  // The daily figures are reported but switched off, so there is no
  // ambiguity about which window the copy under review is describing.
  assert.match(DEMO_WEEKLY, /dailyApplies: false/);

  assert.match(DEMO_WEEKLY, /weeklyApplies: true/);
  const weeklyLimit = Number(/weeklyLimitCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  const weeklySpent = Number(/weeklySpentCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  assert.equal(weeklySpent, weeklyLimit, 'and the weekly one is');
  assert.equal(limit, weeklyLimit, 'the headline figures are the weekly cap’s');

  assert.match(DEMO_WEEKLY, /capWindow: 'weekly'/);
  assert.match(DEMO_WEEKLY, /windowLabel: 'This week'/);
  assert.match(DEMO_WEEKLY, /resetLabel: 'Monday 00:00 UTC'/,
    'so every "resets at midnight UTC" sentence reads the boundary correctly');
  assert.match(DEMO_WEEKLY, /demo: true/);
});
