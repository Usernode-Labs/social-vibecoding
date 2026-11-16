// A session's branch is created on its FIRST USE, not when the session is
// created (#1350).
//
// What this replaced: creating a session used to mint a name and call
// github.createBranch before it returned, so a session opened and abandoned
// left a real ref on the app's repository. Most were never written to and
// never cleaned up. Homeroom bot's builds now make the session first and
// cut its branch when the build starts.
//
// Pinned here:
//
//   1. ensureSessionBranch (services/session-lifecycle.js) is idempotent,
//      serialized, and all-or-nothing
//   2. every surface that reads branch_name copes with NULL rather than
//      producing a name-shaped hole ('heads/null', 'origin/null')
//
// Obligation 1's third clause is the load-bearing one. run-cc.sh dies on
// "branch missing upstream: origin/$BRANCH" for a build turn, so a row that
// records a branch GitHub does not have is a session that can never run a
// turn again. The helper therefore persists the name only AFTER the ref
// exists, and holds the session's lock (on the process's lock connection,
// src/db/session-locks.js) across the call so two concurrent first uses
// cannot mint two names for one session.
//
// Run with: node --test tests/session-branch-deferral.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── a pool stand-in ─────────────────────────────────────────────────────
//
// ensureSessionBranch is the only thing under test. Matching on the shape of
// the SQL rather than mocking pg keeps the test honest about the ORDER the
// statements run in, which is the part that matters. The lock it holds is
// recorded by a stand-in for src/db/session-locks.js
// (tests/session-locks-postgres.test.js runs the real one).
const locked = [];
const locksPath = require.resolve('../src/db/session-locks');
require.cache[locksPath] = { id: locksPath, filename: locksPath, loaded: true, exports: {
  withSessionLock: async (_pool, key, fn) => { locked.push(key); return fn(); },
} };

function fakePool(rowsBySession, opts = {}) {
  const log = [];
  const pool = {
    log,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      log.push(text);
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) {
        const row = rowsBySession.get(Number(params[0])) || null;
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/UPDATE chat_sessions SET branch_name/.test(text)) {
        if (opts.failUpdate) throw new Error('update exploded');
        const row = rowsBySession.get(Number(params[0]));
        if (opts.recordedMeanwhile && row) row.branch_name = opts.recordedMeanwhile;
        if (!row || row.branch_name) return { rowCount: 0, rows: [] };
        row.branch_name = params[1];
        return { rowCount: 1, rows: [{ branch_name: params[1] }] };
      }
      if (/SELECT branch_name FROM chat_sessions/.test(text)) {
        const row = rowsBySession.get(Number(params[0]));
        return { rows: row ? [{ branch_name: row.branch_name }] : [] };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return pool;
}

function loadLifecycle() {
  // github.isEnabled() is false with no GitHub App configured, which is the
  // shape this container runs in. The helper then persists the name without
  // calling out, which is exactly the path a self-hosted deployment with no
  // GitHub App takes in production.
  return require('../src/services/session-lifecycle');
}

// ── the helper ──────────────────────────────────────────────────────────

test('ensureSessionBranch mints a name for a branchless session', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);

  const out = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  assert.equal(out.created, true);
  assert.match(out.branchName, /^dev\/evan-\d+$/);
  assert.equal(rows.get(7).branch_name, out.branchName, 'the name must be persisted');
});

test('ensureSessionBranch sanitizes an email-address username', async () => {
  // The #1376 regression, re-pinned at the new mint site: 194 of 303
  // production usernames are email addresses.
  const lifecycle = loadLifecycle();
  const branchNames = require('../src/services/branch-names');
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'koenigup@gmail.com', repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(rows), sessionId: 7 });
  assert.ok(branchNames.isValidBranchName(out.branchName), `${out.branchName} must be pushable`);
});

test('ensureSessionBranch is idempotent: a second call returns the same branch', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);

  const first = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  const second = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  assert.equal(second.branchName, first.branchName);
  assert.equal(second.created, false, 'the second call must not claim to have created it');
  // And it must not have tried: a second CREATE for an existing ref is a
  // 422 from GitHub, which would surface as a failed turn.
  assert.equal(
    pool.log.filter((s) => s.startsWith('UPDATE chat_sessions')).length, 1,
    'only the first call may write'
  );
});

test('ensureSessionBranch holds the session\'s lock, and never writes over a branch recorded meanwhile', async () => {
  // The lock is what serializes two concurrent first turns on one session
  // (on the process's lock connection: holding it takes nothing from the
  // pool, whose connection GitHub's client may need).
  const lifecycle = loadLifecycle();
  const { SESSION_BRANCH_LOCK } = require('../src/services/advisory-locks');
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);
  locked.length = 0;
  await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  assert.deepEqual(locked, [[SESSION_BRANCH_LOCK, 7]]);
  assert.match(pool.log[0], /FROM chat_sessions cs JOIN apps a/);
  assert.match(pool.log[1], /^UPDATE chat_sessions SET branch_name = \$2 WHERE id = \$1 AND branch_name IS NULL/);
  // An older release (row lock, not this one) recorded one meanwhile: it stands.
  const other = new Map([[8, { id: 8, branch_name: null, user_id: 3, username: 'evan', repo_url: null }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(other, { recordedMeanwhile: 'dev/evan-1' }), sessionId: 8 });
  assert.deepEqual(out, { branchName: 'dev/evan-1', created: false });
});

test('ensureSessionBranch prefers the caller-supplied username', async () => {
  // The chat route has req.user in hand; the row's join may be NULL for a
  // deleted account.
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: null, repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({
    pool: fakePool(rows), sessionId: 7, username: 'ada',
  });
  assert.match(out.branchName, /^dev\/ada-\d+$/);
});

test('#3229: ensureSessionBranch names the branch after the caller-supplied label', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', session_title: null, repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({
    pool: fakePool(rows), sessionId: 7, label: 'Add a dark mode toggle',
  });
  assert.match(out.branchName, /^dev\/evan-add-a-dark-mode-toggle-\d+$/);
});

test('#3229: ensureSessionBranch falls back to the stored session title', async () => {
  // The bot's build sessions and the dispatch backstop pass no label; the
  // row's title is what they are about.
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'homeroom_bot',
    session_title: '#3229 · Session branch names', repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(rows), sessionId: 7 });
  assert.match(out.branchName, /^dev\/homeroom_bot-3229-session-branch-names-\d+$/);
});

test('ensureSessionBranch still produces a valid name with no username at all', async () => {
  const lifecycle = loadLifecycle();
  const branchNames = require('../src/services/branch-names');
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 42, username: null, repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(rows), sessionId: 7 });
  assert.ok(branchNames.isValidBranchName(out.branchName));
  assert.match(out.branchName, /^dev\//);
});

test('ensureSessionBranch reports a missing session as no_session', async () => {
  const lifecycle = loadLifecycle();
  const pool = fakePool(new Map());
  await assert.rejects(
    () => lifecycle.ensureSessionBranch({ pool, sessionId: 999 }),
    (err) => {
      assert.equal(err.code, 'no_session');
      return true;
    }
  );
});

test('a failed write leaves the session branchless rather than half-created', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows, { failUpdate: true });
  await assert.rejects(() => lifecycle.ensureSessionBranch({ pool, sessionId: 7 }));
  assert.equal(rows.get(7).branch_name, null, 'nothing may be persisted');
});

// ── the null-branch edge cases ──────────────────────────────────────────

test('the push proxy refuses a branchless session permanently, with advice', async () => {
  const worker = require('../src/services/worker');
  for (const empty of [null, undefined, '']) {
    await assert.rejects(
      () => worker.execPushFromWorker(1, empty),
      (err) => {
        assert.equal(err.code, 'no_branch');
        assert.equal(err.permanent, true);
        assert.match(err.userMessage, /Send a message in the session first/i);
        return true;
      },
      `branch ${JSON.stringify(empty)} must be refused`
    );
  }
});

test('the no_branch guard runs before the charset check', () => {
  // Otherwise isValidBranchName(null) answers first and the user gets
  // "isn't a valid git branch name", which is true but useless: the fix is
  // to send a message, not to start a new session.
  const src = read('src/services/worker.js');
  const guard = src.indexOf("err.code = 'no_branch'");
  const charset = src.indexOf('branchNames.isValidBranchName(branchName)');
  assert.ok(guard > 0 && charset > 0);
  assert.ok(guard < charset, 'the null check must come first');
});

test('the connector refuses to continue a session that has not run a turn', () => {
  const src = read('src/services/external-agent-tasks.js');
  assert.match(src, /fail\(\s*'session_not_started'/);
  const flow = read('src/routes/dev-flow.js');
  assert.match(flow, /session_not_started: 409/,
    'the code must be mapped, or dev-flow.js answers 500');
});

test('a staging build refuses a branchless session instead of cloning origin/null', () => {
  const src = read('src/services/staging.js');
  assert.match(src, /!viaPullRef && !session\.branch_name/);
  assert.match(src, /no branch yet/i);
});

test('the null-branch error messages read as instructions, not as diagnostics', () => {
  // Every one of these reaches a user, and each has exactly one useful
  // remedy: send a message. Saying so is the difference between a dead end
  // and a two-second fix.
  const worker = read('src/services/worker.js');
  const staging = read('src/services/staging.js');
  const sessions = read('src/routes/sessions.js');
  for (const src of [worker, staging, sessions]) {
    assert.equal(/—/.test(src.match(/Send a message in the session[^']*/)?.[0] || ''), false);
  }
  assert.match(worker, /Send a message in the session first/);
  assert.match(staging, /Send a message in the session first/);
});
