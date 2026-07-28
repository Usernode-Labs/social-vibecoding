// Tests for src/services/platform-env-check.js — the diff-scoped
// pre-merge gate that blocks a proposal which adds a required platform
// variable nobody has set a value for.
//
// Two design decisions carry the weight, and both are easy to "fix" into
// a much worse feature:
//
//  1. DIFF-SCOPED. The check looks only at what THIS branch adds
//     relative to its merge base. A whole-state check ("is anything
//     required unset?") would let one unset variable block every merge
//     on the platform — including the proposal that removes it. Three-
//     dot compare semantics for the same reason app-admins uses them:
//     main moving underneath a branch is not something the branch did.
//
//  2. FAILS OPEN. No GitHub, no merge base, a transport error — all
//     resolve to 'skipped'. The state before this feature existed was
//     "no gate at all", so a GitHub hiccup must degrade to that rather
//     than freezing every self-app merge behind an outage.
//
// Run with: node --test tests/platform-env-check.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const check = require('../src/services/platform-env-check');

// Swap the lazily-required github module for a scripted stub by seeding
// require.cache. platform-env-check requires it inside the function, so
// each test can install its own before calling in.
const GITHUB_PATH = require.resolve('../src/services/github');

function withGithub(stub, fn) {
  const previous = require.cache[GITHUB_PATH];
  require.cache[GITHUB_PATH] = { id: GITHUB_PATH, filename: GITHUB_PATH, loaded: true, exports: stub };
  try {
    return fn();
  } finally {
    if (previous) require.cache[GITHUB_PATH] = previous;
    else delete require.cache[GITHUB_PATH];
  }
}

const manifest = (keys) => JSON.stringify({
  platform_env: keys.map((k) => (typeof k === 'string' ? { key: k, required: true } : k)),
});

function githubStub({ files = ['dapp.json'], filesComplete = true, mergeBaseSha = 'base1',
  base = [], head = [], compareThrows = false, fetchThrows = false, enabled = true } = {}) {
  return {
    isEnabled: () => enabled,
    compareRefs: async () => {
      if (compareThrows) throw new Error('502 from GitHub');
      return { mergeBaseSha, files, filesComplete };
    },
    getFileContent: async (_o, _r, _f, ref) => {
      if (fetchThrows) throw new Error('404');
      return ref === mergeBaseSha ? manifest(base) : manifest(head);
    },
  };
}

function poolWithValues(keys = []) {
  return {
    query: async (_sql, params) => ({
      rows: (params[1] || []).filter((k) => keys.includes(k)).map((key) => ({ key })),
    }),
  };
}

const SELF_APP = { id: 1, self_hosted: true, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const SESSION = { id: 42, source: 'native', branch_name: 'dev/feature' };

const run = (opts, pool = poolWithValues(), app = SELF_APP, session = SESSION) =>
  withGithub(githubStub(opts), () => check.resolvePlatformEnvCheck({ pool, app, session }));

// ── Scope ─────────────────────────────────────────────────────────────

test('a child app is out of scope', async () => {
  const result = await run({}, poolWithValues(), { id: 9, self_hosted: false, repo_url: 'x' });
  assert.equal(result.state, 'skipped');
  assert.match(result.detail.reason, /platform's own proposals/);
});

test('an imported PR is compared at its head sha, a native proposal at its branch', () => {
  assert.equal(check.headRefForSession({ source: 'imported', imported_pr_head_sha: 'abc', branch_name: 'b' }), 'abc');
  assert.equal(check.headRefForSession({ source: 'native', branch_name: 'dev/x' }), 'dev/x');
  assert.equal(check.headRefForSession({}), null);
});

// ── Fail-open paths ───────────────────────────────────────────────────

test('GitHub disabled fails open', async () => {
  const result = await run({ enabled: false });
  assert.equal(result.state, 'skipped');
});

test('an unparseable repo URL fails open', async () => {
  const result = await run({}, poolWithValues(), { ...SELF_APP, repo_url: 'not-a-url' });
  assert.equal(result.state, 'skipped');
  assert.match(result.detail.reason, /repository URL/);
});

test('a compare that throws fails open rather than blocking every merge', async () => {
  const result = await run({ compareThrows: true, head: ['NEW_ONE'] });
  assert.equal(result.state, 'skipped',
    'a GitHub outage must degrade to the pre-feature behaviour, not freeze the platform');
});

test('no merge base fails open', async () => {
  const result = await run({ mergeBaseSha: null });
  assert.equal(result.state, 'skipped');
});

test('a manifest fetch that throws fails open', async () => {
  const result = await run({ fetchThrows: true });
  assert.equal(result.state, 'skipped');
});

test('a session with no branch fails open', async () => {
  const result = await run({}, poolWithValues(), SELF_APP, { id: 42, source: 'native' });
  assert.equal(result.state, 'skipped');
});

// ── The cheap path ────────────────────────────────────────────────────

test('a proposal that does not touch dapp.json passes without fetching it', async () => {
  let fetched = 0;
  const stub = githubStub({ files: ['src/routes/votes.js'] });
  const wrapped = { ...stub, getFileContent: async (...a) => { fetched += 1; return stub.getFileContent(...a); } };
  const result = await withGithub(wrapped, () => check.resolvePlatformEnvCheck({
    pool: poolWithValues(), app: SELF_APP, session: SESSION,
  }));
  assert.equal(result.state, 'passing');
  assert.equal(fetched, 0, 'one compare call and nothing else for the common case');
});

test('a truncated file list is not trusted', async () => {
  let fetched = 0;
  const stub = githubStub({ files: ['src/routes/votes.js'], filesComplete: false, head: ['NEW_ONE'] });
  const wrapped = { ...stub, getFileContent: async (...a) => { fetched += 1; return stub.getFileContent(...a); } };
  const result = await withGithub(wrapped, () => check.resolvePlatformEnvCheck({
    pool: poolWithValues(), app: SELF_APP, session: SESSION,
  }));
  assert.ok(fetched > 0, 'a capped list that happens not to mention dapp.json proves nothing');
  assert.equal(result.state, 'failing');
});

// ── The diff ──────────────────────────────────────────────────────────

test('adding a required variable with no value blocks the merge', async () => {
  const result = await run({ base: [], head: ['NEW_TUNABLE'] });
  assert.equal(result.state, 'failing');
  assert.deepEqual(result.detail.missing.map((m) => m.key), ['NEW_TUNABLE']);
  assert.deepEqual(result.detail.added, ['NEW_TUNABLE']);
});

test('adding a required variable that already has a value passes', async () => {
  const result = await run({ base: [], head: ['NEW_TUNABLE'] }, poolWithValues(['NEW_TUNABLE']));
  assert.equal(result.state, 'passing');
  assert.deepEqual(result.detail.missing, []);
  assert.deepEqual(result.detail.added, ['NEW_TUNABLE'],
    'the added list is still reported so the UI can say "all set"');
});

test('an unset variable that main already had does NOT block this branch', async () => {
  const result = await run({ base: ['PRE_EXISTING'], head: ['PRE_EXISTING'] });
  assert.equal(result.state, 'passing',
    'diff-scoped: one unset variable must not block every merge, including its own fix');
});

test('removing a variable passes and is reported', async () => {
  const result = await run({ base: ['GOING_AWAY'], head: [] });
  assert.equal(result.state, 'passing');
  assert.deepEqual(result.detail.removed, ['GOING_AWAY']);
  assert.match(result.detail.reason, /removes 1 platform variable/);
});

test('an added OPTIONAL variable does not block', async () => {
  const result = await run({ base: [], head: [{ key: 'NICE_TO_HAVE', required: false }] });
  assert.equal(result.state, 'passing');
  assert.deepEqual(result.detail.added, ['NICE_TO_HAVE']);
});

test('an added deploy-owned variable does not block', async () => {
  const result = await run({ base: [], head: [{ key: 'USERNODE_DOMAIN', required: true }] });
  assert.equal(result.state, 'passing',
    'documenting a GitHub-secret-sourced variable is not something an admin could satisfy');
});

test('a mix reports only the ones a human can actually set', async () => {
  const result = await run({
    base: [],
    head: ['ONE_MISSING', { key: 'HAS_VALUE', required: true }, { key: 'OPTIONAL', required: false }],
  }, poolWithValues(['HAS_VALUE']));
  assert.equal(result.state, 'failing');
  assert.deepEqual(result.detail.missing.map((m) => m.key), ['ONE_MISSING']);
  assert.equal(result.detail.added.length, 3);
});

test('a DB failure is an error state, not a silent pass', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  const result = await run({ base: [], head: ['NEW_ONE'] }, pool);
  assert.equal(result.state, 'error');
  assert.deepEqual(result.detail.missing, [],
    'an error must never be rendered as a list of missing keys it did not actually check');
});

// ── Shape + persistence + copy ────────────────────────────────────────

test('every outcome has the same detail shape', async () => {
  const outcomes = await Promise.all([
    run({ base: [], head: ['NEW_ONE'] }),
    run({ base: [], head: [] }),
    run({ enabled: false }),
  ]);
  for (const o of outcomes) {
    assert.ok(['passing', 'failing', 'skipped', 'error'].includes(o.state));
    assert.ok(Array.isArray(o.detail.missing));
    assert.ok(Array.isArray(o.detail.added));
    assert.ok(Array.isArray(o.detail.removed));
    assert.equal(typeof o.detail.reason, 'string');
  }
});

test('the verdict is stamped on its own columns, never on check_state', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await check.storePlatformEnvCheck(pool, 42, { state: 'failing', detail: { missing: [] } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SET platform_env_state = \$2/);
  assert.match(calls[0].sql, /platform_env_detail = \$3::jsonb/);
  assert.ok(!/check_state/.test(calls[0].sql),
    'check_state is owned by the staging-capture pipeline and rewritten wholesale by storeChecks');
  assert.equal(calls[0].params[1], 'failing');
});

test('a stamp failure never propagates to the caller', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  await check.storePlatformEnvCheck(pool, 42, { state: 'failing', detail: {} });
});

test('the block message names the variables and where to set them', () => {
  const msg = check.describeBlock({ missing: [{ key: 'ALPHA' }, { key: 'BETA' }] }, 'Proposal #12');
  assert.match(msg, /Proposal #12/);
  assert.match(msg, /ALPHA, BETA/, 'a gate that only says "blocked" costs more time than it saves');
  assert.match(msg, /Platform variables panel/,
    'the surface is the platform app\'s own secrets panel now — the admin-console '
    + 'section this used to name was folded into it');
  assert.match(msg, /propose one by vote/,
    'a non-admin who hits the block needs a route that is open to them');
  assert.match(msg, /does not count/,
    'the gate reads APPLIED values, so a proposal still collecting votes does not '
    + 'clear it — say so or someone waits on a vote forever');
  assert.match(msg, /vote again/, 'the gate re-evaluates live — say so, or people rebuild for nothing');
});

test('an unparseable manifest blob is emptiness, not a throw', () => {
  assert.deepEqual(check.platformEnvFromManifestSource(null), []);
  assert.deepEqual(check.platformEnvFromManifestSource('{ not json'), []);
  assert.deepEqual(check.platformEnvFromManifestSource('{}'), []);
  assert.equal(check.platformEnvFromManifestSource(manifest(['A_KEY'])).length, 1);
});

test('the check module pulls github in lazily, not at require time', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '../src/services/platform-env-check.js'), 'utf8'
  );
  const header = src.slice(0, src.indexOf('function platformEnvFromManifestSource'));
  assert.ok(!/require\('\.\/github'\)/.test(header),
    'a top-level github require would make this module unloadable in tests and '
    + 'create a cycle with services/github.js');
});
