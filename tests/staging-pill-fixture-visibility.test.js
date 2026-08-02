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

test('the fixture titles are obviously fake and prefixed', () => {
  const titles = [...BODY.matchAll(/'(\[staging fixture\][^']*)'/g)].map((m) => m[1]);
  assert.equal(titles.length, 2, 'both fixtures carry the [staging fixture] prefix');
  for (const t of titles) {
    assert.match(t, /Staging demo/, `"${t}" reads as demo content, not a real session`);
  }
});

test('the seed is idempotent via its branch-name existence checks', () => {
  // #896: bumped to -v2 so the reworded transcripts actually re-seed —
  // the guard below is an existence check on the branch name, so reusing
  // the old name would leave staging showing the pre-#896 rows forever.
  for (const branch of ['staging-fixture/restart-recovered-pills-v2',
    'staging-fixture/restart-unanswered-pills-v2']) {
    assert.ok(BODY.includes(branch), `seeds ${branch}`);
  }
  const checks = BODY.match(
    /SELECT id FROM chat_sessions WHERE app_id = \$1 AND branch_name = \$2 LIMIT 1/g
  );
  assert.equal(checks && checks.length, 2, 'each fixture guards on its own branch name');
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
