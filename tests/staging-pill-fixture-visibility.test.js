'use strict';

// The #786 staging pill fixtures must be visible to the identity that
// actually runs the proposal checks.
//
// What broke: seedStagingRestartRecoveredPills seeded both fixture
// sessions owned by the first admin and NOT shared. The Dev board's own-
// session block is fed by GET /api/me/active-sessions, which filters
// strictly on `cs.user_id = req.user.id` — so those cards render for the
// owner and nobody else. The proposal-checks assertion suite navigates
// signed as the view-only `usernode-capture-admin` identity (see
// selectCaptureTokens in src/services/visuals.js, and
// tests/capture-admin-token.test.js), a different user id, so both
// `expectText` checks failed on the staging preview even though the seed
// ran fine and the titles matched. Verifying by hand as the owner hid the
// bug — the owner is the one viewer who can see an unshared fixture.
//
// The fix: seed both rows SHARED. `shared_at` puts them on GET
// /api/apps/:slug/shared-sessions too, which is app-scoped, so the cards
// render for any viewer of the Dev board. The dev-chat endpoints stay
// owner-scoped, so sharing exposes the card, not the conversation.
//
// This is a source-invariant test (repo convention for seed contracts,
// same shape as tests/capture-admin-token.test.js): it reads the seed and
// dapp.json rather than booting Postgres.
//
// Run with: node --test tests/staging-pill-fixture-visibility.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MIGRATE_SRC = read('src/db/migrate.js');
const DAPP = JSON.parse(read('dapp.json'));

const SEED = 'seedStagingRestartRecoveredPills';
const DEV_BOARD_PATH = '/?demo=1#app/usernode-2d5619/dev';

// Slice the seed function body out: from its definition to the next
// top-level `async function` (both markers are unique definition sites).
function seedBody(name) {
  const start = MIGRATE_SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `found ${name} definition`);
  const end = MIGRATE_SRC.indexOf('\nasync function ', start + 1);
  assert.ok(end > start, `found the function after ${name}`);
  return MIGRATE_SRC.slice(start, end);
}

// Every `INSERT INTO chat_sessions (...) VALUES (...)` in a body, as
// { columns, values, valueFor(column) }. Both lists are positional, so a
// column's literal is its same-index VALUES token (NOW() - INTERVAL '...'
// holds no commas, so a naive split is safe for these two statements).
function sessionInserts(body) {
  const re = /INSERT INTO chat_sessions\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*RETURNING/g;
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    const columns = m[1].split(',').map((c) => c.trim());
    const values = m[2].split(',').map((v) => v.trim().replace(/\s+/g, ' '));
    assert.equal(columns.length, values.length, 'column list and VALUES line up');
    out.push({ columns, values, valueFor: (c) => values[columns.indexOf(c)] });
  }
  return out;
}

const BODY = seedBody(SEED);

test('the seed is registered in the boot migration sequence', () => {
  assert.match(MIGRATE_SRC, new RegExp(`await ${SEED}\\(pool, config\\)`),
    `${SEED} must be called from the seed list or it never runs`);
});

test('the seed is a strict no-op outside staging', () => {
  assert.match(BODY, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
    'staging fixtures must never touch a real database');
});

test('both fixture sessions are seeded shared, not owner-only', () => {
  const inserts = sessionInserts(BODY);
  assert.equal(inserts.length, 2, `${SEED} seeds exactly two chat_sessions rows`);
  for (const [i, ins] of inserts.entries()) {
    assert.ok(ins.columns.includes('shared_at'),
      `chat_sessions INSERT #${i + 1} must set shared_at: /api/me/active-sessions is `
      + 'owner-scoped (cs.user_id = req.user.id), so an unshared fixture is invisible to '
      + 'the usernode-capture-admin identity that runs the dapp.json checks');
    assert.notEqual(ins.valueFor('shared_at'), 'NULL',
      `chat_sessions INSERT #${i + 1} shares the row (a NULL shared_at is not shared)`);
    // /api/apps/:slug/shared-sessions also filters on status and headlessness.
    assert.equal(ins.valueFor('status'), "'active'",
      `chat_sessions INSERT #${i + 1} is active (shared-sessions returns active/paused only)`);
    assert.equal(ins.valueFor('is_headless'), 'FALSE',
      `chat_sessions INSERT #${i + 1} is not headless (shared-sessions excludes headless rows)`);
  }
});

// Every fixture this seed owns. The first two are the #786 pill shapes
// (auto-id, asserted via their Dev-board card title); the last three are
// the tail-recovery shapes, which carry FIXED ids so a dapp.json check can
// open the transcript itself rather than only its card.
const FIXTURE_BRANCHES = [
  // #896: -v2 so the reworded transcripts actually re-seed — the guard is an
  // existence check on the branch name, so reusing the old name would leave
  // staging showing the pre-#896 rows forever.
  'staging-fixture/restart-recovered-pills-v2',
  'staging-fixture/restart-unanswered-pills-v2',
  'staging-fixture/restart-recovered-tail',
  'staging-fixture/staging-rebuild-running',
  'staging-fixture/restart-code-landed',
];

test('the fixture titles are obviously fake and prefixed', () => {
  const titles = [...BODY.matchAll(/'(\[staging fixture\][^']*)'/g)].map((m) => m[1]);
  assert.equal(titles.length, FIXTURE_BRANCHES.length,
    'every fixture carries the [staging fixture] prefix');
  for (const t of titles) {
    assert.match(t, /Staging demo/, `"${t}" reads as demo content, not a real session`);
  }
});

test('the seed is idempotent via its branch-name existence checks', () => {
  for (const branch of FIXTURE_BRANCHES) {
    assert.ok(BODY.includes(branch), `seeds ${branch}`);
  }
  const checks = BODY.match(
    /SELECT id FROM chat_sessions WHERE app_id = \$1 AND branch_name = \$2 LIMIT 1/g
  );
  assert.equal(checks && checks.length, FIXTURE_BRANCHES.length,
    'each fixture guards on its own branch name');
});

test('the tail-recovery fixtures are shared, active and fixed-id', () => {
  // These use explicit ids instead of RETURNING (the 9008xx convention), so
  // they need their own shape check — the sessionInserts() helper above only
  // sees the RETURNING form.
  const inserts = [...BODY.matchAll(
    /INSERT INTO chat_sessions\s*\(\s*(id,[\s\S]*?)\)\s*VALUES/g
  )].map((m) => m[1].split(',').map((c) => c.trim()));
  assert.equal(inserts.length, 3, 'three fixed-id tail fixtures');
  for (const columns of inserts) {
    assert.ok(columns.includes('id'), 'a fixed id, so dapp.json can deep-link it');
    // Same rationale as the two shared fixtures above: the dapp.json checks
    // run as the view-only capture identity, and an unshared row is
    // invisible to anyone but its owner.
    assert.ok(columns.includes('shared_at'), 'shared, or the checks cannot see it');
    assert.ok(columns.includes('is_headless'), 'explicitly non-headless');
  }
  // Ids must match what dapp.json deep-links, or the checks 404 into the
  // home feed and silently assert nothing.
  for (const id of [900820, 900821, 900822]) {
    assert.ok(BODY.includes(String(id)), `seeds session ${id}`);
    assert.ok((DAPP.tests || []).some((t) => (t.path || '').includes(`/sessions/${id}`)),
      `a dapp.json check opens session ${id}`);
  }
});

test('the tail-recovery checks assert text the fixtures actually render', () => {
  const byPath = (id) => (DAPP.tests || []).filter((t) => (t.path || '').endsWith(`/sessions/${id}`));

  // 900820 — the resumed tail's own rows.
  const recovered = byPath(900820);
  assert.ok(recovered.length >= 2, 'the tail-recovered transcript is checked');
  assert.ok(recovered.some((t) => t.expectText === 'Staging deployed!'),
    'the card the interrupted tail owed the user is asserted');
  assert.ok(BODY.includes("'Staging deployed!'"), 'and the fixture actually seeds it');

  // 900821 — the in-progress rebuild row must be the LAST row, or the
  // client will not spin it (see _activateTrailingStagingBuild).
  const rebuilding = byPath(900821);
  assert.ok(rebuilding.some((t) => /dc-status-spinner-arc/.test(t.expectSelector || '')),
    'the spinner is what this fixture exists to pin');
  const rebuildIdx = BODY.indexOf("'staging-fixture/staging-rebuild-running'");
  const rebuildBlock = BODY.slice(rebuildIdx, BODY.indexOf('Fixture 5', rebuildIdx));
  const lastRow = rebuildBlock.lastIndexOf("['system', 'Building staging preview...'");
  assert.ok(lastRow > 0, 'seeds the in-progress row');
  assert.ok(!/\['(system|assistant|user)',/.test(rebuildBlock.slice(lastRow + 40)),
    'and it is the final row — a row after it would (correctly) stop the spinner');

  // 900822 — the honest wording, kept in sync with recovery-pills.js.
  const landed = byPath(900822);
  const wording = landed.find((t) => /committed and pushed/.test(t.expectText || ''));
  assert.ok(wording, 'the code-landed wording is asserted');
  const seeded = BODY.match(/'(Your changes are committed and pushed to [^']*)'/);
  assert.ok(seeded, 'the fixture seeds that row');
  assert.ok(seeded[1].includes(wording.expectText),
    `dapp.json expects "${wording.expectText}" but the seeded row reads "${seeded[1]}"`);
  // The one thing this row must NEVER say.
  assert.ok(!/send your request again/i.test(seeded[1]),
    'landed work must not be reported as something to redo');
  const { isCodeLandedBreadcrumb } = require('../src/services/recovery-pills');
  assert.ok(isCodeLandedBreadcrumb(seeded[1]),
    'the seeded row is a real buildCodeLandedBreadcrumb output — keep both sides in sync');
});

// ── dapp.json ↔ seed contract ───────────────────────────────────────────

test('the #786 checks assert text the seed actually renders', () => {
  const checks = (DAPP.tests || []).filter((t) => /#786/.test(t.name || ''));
  assert.equal(checks.length, 2, 'both #786 pill-fixture checks are present');
  for (const check of checks) {
    assert.equal(check.path, DEV_BOARD_PATH,
      `${check.name} asserts on the Dev board, where the shared cards render`);
    assert.ok(check.expectText, `${check.name} has an expectText`);
    // The card label is the pr_title verbatim (AppView._sessionCardLabel),
    // so the assertion string must be a literal substring of a seeded title.
    assert.ok(BODY.includes(`[staging fixture] ${check.expectText}`),
      `dapp.json expects "${check.expectText}" but no ${SEED} pr_title contains it — `
      + 'rename both sides together or the check goes red on staging');
  }
});
