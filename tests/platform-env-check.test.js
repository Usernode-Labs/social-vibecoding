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

// `headModuleSource` is the branch's src/services/app-manifest.js text, which
// the check reads to learn which keys THIS branch considers deploy-owned (see
// the "declares its own deploy-owned key" tests below). `moduleFetchThrows`
// exercises the fail-closed path.
function githubStub({ files = ['dapp.json'], filesComplete = true, mergeBaseSha = 'base1',
  base = [], head = [], compareThrows = false, fetchThrows = false, enabled = true,
  headModuleSource = null, moduleFetchThrows = false } = {}) {
  return {
    isEnabled: () => enabled,
    compareRefs: async () => {
      if (compareThrows) throw new Error('502 from GitHub');
      return { mergeBaseSha, files, filesComplete };
    },
    getFileContent: async (_o, _r, file, ref) => {
      if (file === check.MANIFEST_MODULE_PATH) {
        if (moduleFetchThrows) throw new Error('404 on app-manifest.js');
        return headModuleSource;
      }
      if (fetchThrows) throw new Error('404');
      return ref === mergeBaseSha ? manifest(base) : manifest(head);
    },
  };
}

// A stand-in for the branch's app-manifest.js: only the two declarations the
// check parses, in the same shape the real module uses (comments included, so
// the comment-stripping path is exercised).
const moduleSourceDeclaring = (keys, prefixes = []) => `
'use strict';
const RESERVED_KEYS = new Set([
  // The platform's own structural keys — don't let a dapp shadow them.
  'DATABASE_URL',
  'PORT',
  'USERNODE_ENV',
  'JWT_SECRET',
]);
const RESERVED_KEY_PREFIXES = [${prefixes.map((p) => `'${p}'`).join(', ')}];
const PLATFORM_ENV_UNWRITABLE = new Set([
  // Deploy-owned. It isn't settable from the console by construction.
  'SESSION_SECRET',
${keys.map((k) => `  '${k}',`).join('\n')}
]);
`;

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

test('imported and CLI proposals use immutable heads; ordinary native uses its branch', () => {
  assert.equal(check.headRefForSession({ source: 'imported', imported_pr_head_sha: 'abc', branch_name: 'b' }), 'abc');
  assert.equal(check.headRefForSession({
    source: 'cli_handoff', checks_commit_sha: 'checked',
    handoff_head_sha: 'local', branch_name: 'dev/cli',
  }), 'checked');
  assert.equal(check.headRefForSession({
    source: 'cli_handoff', handoff_head_sha: 'local', branch_name: 'dev/cli',
  }), 'local');
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

// ── A branch that declares its OWN deploy-owned key ───────────────────
//
// The regression these cover: `unwritable` is derived from the reserved lists
// of the module that is RUNNING, but the check evaluates a BRANCH's manifest.
// A proposal that adds a deploy-owned variable necessarily does two things in
// one commit — declare the platform_env entry, and name the key in
// PLATFORM_ENV_UNWRITABLE — and the running platform has only the first half.
// Scoring against the deployed list alone made such a proposal block the very
// merge that would make it unwritable. This is exactly what happened to the
// JWT key-separation PR (DATA_ENCRYPTION_KEY and friends).

// Synthetic key names on purpose: these must exercise the OVERLAY, so they
// have to be keys the running module's reserved list does not already cover.
// Using the real DATA_ENCRYPTION_KEY here would pass for the wrong reason once
// that key lands in PLATFORM_ENV_UNWRITABLE. The real five are asserted
// separately, against the real module, further down.
const FRESH_DEPLOY_KEYS = ['FRESH_DEPLOY_KEY_A', 'FRESH_DEPLOY_KEY_B', 'FRESH_DEPLOY_KEY_C',
  'FRESH_DEPLOY_KEY_D', 'FRESH_DEPLOY_KEY_E'];

test('WITHOUT the branch reserved list, a branch-declared deploy-owned key blocks — the bug', async () => {
  const result = await run({
    files: ['dapp.json'],   // branch does not appear to touch the module → no overlay
    base: [],
    head: FRESH_DEPLOY_KEYS.map((key) => ({ key, required: true })),
  });
  assert.equal(result.state, 'failing');
  assert.deepEqual(result.detail.missing.map((m) => m.key), FRESH_DEPLOY_KEYS,
    'this is the pre-fix behaviour, pinned so the regression is visible');
});

test('WITH the branch reserved list, the same five pass — the fix', async () => {
  const result = await run({
    files: ['dapp.json', check.MANIFEST_MODULE_PATH],
    base: [],
    head: FRESH_DEPLOY_KEYS.map((key) => ({ key, required: true })),
    headModuleSource: moduleSourceDeclaring(FRESH_DEPLOY_KEYS),
  });
  assert.equal(result.state, 'passing',
    'the branch names all five in PLATFORM_ENV_UNWRITABLE, so no admin could set them');
  assert.deepEqual(result.detail.missing, []);
  assert.equal(result.detail.added.length, 5, 'still reported as added, just not blocking');
});

test('a genuinely console-settable required variable in the SAME branch still blocks', async () => {
  const result = await run({
    files: ['dapp.json', check.MANIFEST_MODULE_PATH],
    base: [],
    head: [{ key: 'FRESH_DEPLOY_KEY_A', required: true }, { key: 'NEW_TUNABLE_MS', required: true }],
    headModuleSource: moduleSourceDeclaring(['FRESH_DEPLOY_KEY_A']),
  });
  assert.equal(result.state, 'failing', 'the overlay must not become a blanket bypass');
  assert.deepEqual(result.detail.missing.map((m) => m.key), ['NEW_TUNABLE_MS']);
});

test('a branch cannot SHRINK the running reserved list to make a credential writable', async () => {
  // USERNODE_DOMAIN is unwritable in the running platform. A branch whose
  // module source omits it must not thereby turn it into a blocking candidate
  // — the overlay is a union, never a replacement.
  const result = await run({
    files: ['dapp.json', check.MANIFEST_MODULE_PATH],
    base: [],
    head: [{ key: 'USERNODE_DOMAIN', required: true }],
    headModuleSource: moduleSourceDeclaring([]),
  });
  assert.equal(result.state, 'passing');
});

test('the branch reserved-list fetch is skipped when the branch does not touch that module', async () => {
  let fetchedModule = 0;
  const stub = githubStub({ base: [], head: [{ key: 'USERNODE_DOMAIN', required: true }] });
  const wrapped = {
    ...stub,
    getFileContent: async (o, r, file, ref) => {
      if (file === check.MANIFEST_MODULE_PATH) fetchedModule += 1;
      return stub.getFileContent(o, r, file, ref);
    },
  };
  const result = await withGithub(wrapped, () => check.resolvePlatformEnvCheck({
    pool: poolWithValues(), app: SELF_APP, session: SESSION,
  }));
  assert.equal(result.state, 'passing');
  assert.equal(fetchedModule, 0, 'the running list already IS the branch list — no extra API call');
});

test('a capped file list still consults the branch reserved list', async () => {
  // filesComplete:false means the compare's file list proves nothing, so the
  // module must be fetched rather than assumed unchanged.
  const result = await run({
    files: ['something-else.js'],
    filesComplete: false,
    base: [],
    head: [{ key: 'FRESH_DEPLOY_KEY_A', required: true }],
    headModuleSource: moduleSourceDeclaring(['FRESH_DEPLOY_KEY_A']),
  });
  assert.equal(result.state, 'passing');
});

test('a reserved-list fetch failure fails CLOSED, falling back to the deployed list', async () => {
  const result = await run({
    files: ['dapp.json', check.MANIFEST_MODULE_PATH],
    base: [],
    head: [{ key: 'FRESH_DEPLOY_KEY_A', required: true }],
    moduleFetchThrows: true,
  });
  assert.equal(result.state, 'failing',
    'unlike the other failure paths this one over-blocks rather than under-blocks');
});

test('an unparseable reserved list is treated as no overlay, not as an empty one', async () => {
  const result = await run({
    files: ['dapp.json', check.MANIFEST_MODULE_PATH],
    base: [],
    head: [{ key: 'USERNODE_DOMAIN', required: true }],
    headModuleSource: 'export const somethingElse = 1;',
  });
  assert.equal(result.state, 'passing',
    'a garbage parse must not drop USERNODE_DOMAIN out of the deployed reserved set');
});

// ── The static reserved-list parser ───────────────────────────────────

test('the reserved-list parser reads the real app-manifest.js', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '../src/services/app-manifest.js'), 'utf8');
  const overlay = check.unwritableOverlayFromSource(src);
  assert.ok(overlay, 'the real module must parse');
  for (const k of ['DATA_ENCRYPTION_KEY', 'IFRAME_JWT_PRIVATE_KEY', 'IFRAME_JWT_PUBLIC_KEY',
    'WORKER_JWT_SECRET', 'EDGE_JWT_SECRET', 'JWT_SECRET', 'DATABASE_URL']) {
    assert.ok(overlay.keys.has(k), `${k} should be deploy-owned`);
  }
  assert.ok(!overlay.keys.has('LOG_LEVEL'), 'a settable tunable must not be swept in');
  assert.deepEqual(overlay.prefixes,
    ['USERNODE_LLM_PROXY', 'USERNODE_STORAGE', 'USERNODE_PLATFORM_API']);
});

test('no deploy-owned platform_env entry is declared required', () => {
  // `required` on a platform_env entry means "the admin console must hold a
  // value for this". A deploy-owned (unwritable) key can never hold one — the
  // DAO, the route and the vote path all refuse it — so `required: true` there
  // is a category error, and one with real consequences: it makes the entry a
  // blocking candidate for any gate whose reserved list predates the branch,
  // which is exactly how the JWT key-separation PR blocked itself. Enforcement
  // for these lives in src/config.js REQUIRED_PROD (boot exits 1), not here.
  const manifestJson = JSON.parse(require('node:fs').readFileSync(
    path.join(__dirname, '../dapp.json'), 'utf8'));
  // eslint-disable-next-line global-require
  const appManifest = require('../src/services/app-manifest');
  const offenders = appManifest.readPlatformEnv(manifestJson)
    .filter((e) => e.unwritable && e.required)
    .map((e) => e.key);
  assert.deepEqual(offenders, [],
    'declare deploy-owned keys with required:false and say so in the description');
});

test('every platform_env description survives the panel cap intact', () => {
  // readPlatformEnv truncates at MAX_PLATFORM_ENV_DESC_LEN, so an over-long
  // description loses its tail in the panel — and the tail is where the
  // operational warnings had been sitting.
  const manifestJson = JSON.parse(require('node:fs').readFileSync(
    path.join(__dirname, '../dapp.json'), 'utf8'));
  const tooLong = (manifestJson.platform_env || [])
    .filter((e) => typeof e.description === 'string' && e.description.length > 400)
    .map((e) => `${e.key} (${e.description.length})`);
  assert.deepEqual(tooLong, [], 'trim these to 400 chars or the panel cuts them off mid-sentence');
});

test('the parser never executes the source it is handed', () => {
  // The source comes from an unmerged branch, so require/eval/vm are all off
  // the table. A payload that would throw or exfiltrate if run must simply
  // fail to parse.
  global.__pec_pwned = false;
  const hostile = `
    global.__pec_pwned = true; throw new Error('should never run');
    const PLATFORM_ENV_UNWRITABLE = new Set(['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY']);
  `;
  const overlay = check.unwritableOverlayFromSource(hostile);
  assert.equal(global.__pec_pwned, false, 'the source must never be evaluated');
  assert.ok(overlay.keys.has('A_KEY'), 'the literal is still read statically');
  delete global.__pec_pwned;
});

test('the parser strips comments so prose apostrophes cannot truncate a list', () => {
  const src = `const PLATFORM_ENV_UNWRITABLE = new Set([
    // Don't let a dapp shadow these — it's the platform's own config.
    'ALPHA_KEY',
    /* A block comment mentioning 'QUOTED_IN_COMMENT' too. */
    'BETA_KEY',
    'GAMMA_KEY',
    'DELTA_KEY',
  ]);`;
  const overlay = check.unwritableOverlayFromSource(src);
  assert.deepEqual([...overlay.keys].sort(),
    ['ALPHA_KEY', 'BETA_KEY', 'DELTA_KEY', 'GAMMA_KEY']);
});

test('a reserved PREFIX declared by the branch covers a matching key', () => {
  const overlay = check.unwritableOverlayFromSource(
    moduleSourceDeclaring(['ONE_KEY', 'TWO_KEY', 'THREE_KEY'], ['USERNODE_FUTURE']));
  assert.ok(check.isUnwritableWithOverlay(
    { key: 'USERNODE_FUTURE_THING', required: true, unwritable: false }, overlay));
  assert.ok(!check.isUnwritableWithOverlay(
    { key: 'UNRELATED_KEY', required: true, unwritable: false }, overlay));
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

test('a CLI platform-env verdict is commit-bound and cannot land after withdrawal', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const stored = await check.storePlatformEnvCheck(
    pool, 42, { state: 'passing', detail: {} }, 'a'.repeat(40)
  );
  assert.equal(stored, false);
  assert.match(calls[0].sql,
    /status IN \('active', 'paused', 'promoted', 'merging'\)/);
  assert.match(calls[0].sql,
    /checks_commit_sha IS NOT DISTINCT FROM \$4::text/);
  assert.equal(calls[0].params[3], 'a'.repeat(40));
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

// ── Values carried BY the proposal (pending_secret_declarations) ──────
//
// The panel's "+ New variable" flow declares a variable and holds its
// value until the merge. Without counting those, such a proposal blocks
// ITSELF: the declaration is in the branch, the value isn't in
// platform_env_values yet, and the gate would demand somebody set it
// separately — defeating the entire point of carrying it.

// Pool double answering BOTH statements the check issues: the stored-value
// lookup (params[1] = candidate keys) and keysForSession (params[0] =
// session id). `pending` maps session id → [{ key, scope, hasValue }].
function poolWithPending(stored = [], pending = {}) {
  return {
    query: async (sql, params) => {
      if (/FROM pending_secret_declarations/.test(sql)) {
        const rows = (pending[params[0]] || []).map((p) => ({
          key: p.key,
          scope: p.scope || 'platform',
          declaration: {},
          has_held_value: p.hasValue !== false,
          value_applied_at: null,
        }));
        return { rows };
      }
      return {
        rows: (params[1] || []).filter((k) => stored.includes(k)).map((key) => ({ key })),
      };
    },
  };
}

test('a required key whose value this proposal carries resolves passing', async () => {
  const result = await withGithub(
    githubStub({ head: ['CARRIED_KEY'] }),
    () => check.resolvePlatformEnvCheck({
      pool: poolWithPending([], { 42: [{ key: 'CARRIED_KEY' }] }),
      app: SELF_APP,
      session: SESSION,
    })
  );
  assert.equal(result.state, 'passing',
    'the value rides on the proposal, so there is nothing for anyone to go and set');
  assert.deepEqual(result.detail.missing, []);
  assert.deepEqual(result.detail.pendingValues, ['CARRIED_KEY']);
  assert.match(result.detail.reason, /carries its value/);
});

test('the same key carried by a DIFFERENT proposal still fails', async () => {
  const result = await withGithub(
    githubStub({ head: ['CARRIED_KEY'] }),
    () => check.resolvePlatformEnvCheck({
      // Session 99's held value proves nothing about session 42's merge —
      // that proposal might never land.
      pool: poolWithPending([], { 99: [{ key: 'CARRIED_KEY' }] }),
      app: SELF_APP,
      session: SESSION,
    })
  );
  assert.equal(result.state, 'failing');
  assert.deepEqual(result.detail.missing.map((m) => m.key), ['CARRIED_KEY']);
  assert.deepEqual(result.detail.pendingValues, []);
});

test('a declaration-only pending row (no value) does not clear the gate', async () => {
  const result = await withGithub(
    githubStub({ head: ['DOC_ONLY'] }),
    () => check.resolvePlatformEnvCheck({
      pool: poolWithPending([], { 42: [{ key: 'DOC_ONLY', hasValue: false }] }),
      app: SELF_APP,
      session: SESSION,
    })
  );
  assert.equal(result.state, 'failing', 'a proposal with no value to apply leaves the key unset');
});

test('an app-scope pending row never clears a PLATFORM variable', async () => {
  const result = await withGithub(
    githubStub({ head: ['PLATFORM_KEY'] }),
    () => check.resolvePlatformEnvCheck({
      pool: poolWithPending([], { 42: [{ key: 'PLATFORM_KEY', scope: 'app' }] }),
      app: SELF_APP,
      session: SESSION,
    })
  );
  assert.equal(result.state, 'failing',
    'the two stores are segregated — an app_secrets write would never reach the platform .env');
});

test('every detail shape carries pendingValues, so the UI has one shape to read', async () => {
  const skipped = await run({ enabled: false });
  assert.deepEqual(skipped.detail.pendingValues, []);
  const noChange = await run({ files: ['README.md'] });
  assert.deepEqual(noChange.detail.pendingValues, []);
  const removalOnly = await run({ base: ['GONE'], head: [] });
  assert.deepEqual(removalOnly.detail.pendingValues, []);
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
