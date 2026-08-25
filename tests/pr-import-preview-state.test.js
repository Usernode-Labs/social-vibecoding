// #866 — the Preview slot has THREE states on an imported proposal.
//
// A native proposal is promoted only after its staging preview is already up,
// so `staging_url ? Preview : nothing` was an honest two-way branch. An
// imported PR is promoted the instant it's imported and its preview is built
// afterwards (minutes), so that branch rendered NOTHING for the whole build —
// indistinguishable from a preview that will never exist, and read by
// reviewers as a broken card.
//
// The state is derived on READ, not persisted (no staging_state column):
//   staging_building = no staging_url AND staging.hasInFlightBuild(id)
//   staging_error    = no staging_url AND check_state 'error' AND the
//                      check_error_detail the failure path already captured
//
// Covered here:
//   - services/staging.previewDisplayState against a REAL in-flight build
//     (the flag is the live build registry, not a fixture);
//   - the client's three renderings — Preview button / non-interactive
//     "Preview building…" pill / "Preview unavailable" chip (+ "Retry
//     preview" for viewers who can act, and none for read-only viewers);
//   - the matching prose in the proposal detail view;
//   - source invariants on routes/votes.js: both proposal queries derive the
//     two fields, and the ?demo=1 mock rows cover all three states so they're
//     reviewable in a staging preview.
//
// Run with: node --test tests/pr-import-preview-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { detailsHtml } = require('./lib/dev-card-html');

// ── services/staging.previewDisplayState ────────────────────────────────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Same collaborator stubbing as tests/pr-import-fork-clone.test.js, with a
// gate on the DB-clone step so a build can be held mid-flight while
// previewDisplayState is read.
function loadStaging() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    github: require.resolve('../src/services/github'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/staging'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  let release;
  const gate = new Promise((r) => { release = r; });
  let reachedClone;
  const cloneStarted = new Promise((r) => { reachedClone = r; });

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { getCloneUrl: async () => 'https://x/clone.git', isEnabled: () => true });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], missingPrivateStagingDefault: [], env: {} }),
  });
  stub(ids.appLlmEnv, {
    // #1213: platformStagingEnv() injects the app-platform API base URL
    // into previews (URL only, no token), so the staging path calls this.
    platformApiBaseUrl: () => 'http://usernode:3000/api/app-platform',
  });
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.caddy, {
    stagingHostname: (slug, u) => `${slug}--${u}.example.test`,
    warmCert: async () => ({ ok: true, code: 200 }),
  });
  stub(ids.docker, {
    execFileAsync: async () => ({ stdout: '' }),
    buildImage: async () => {},
    runContainer: async () => 'cid123',
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${String(hash).substring(0, 6)}`,
    cloneDatabase: async () => { reachedClone(); await gate; return { password: 'pw' }; },
    connectionUrl: () => 'postgres://x',
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, restore, release, cloneStarted };
}

const APP = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };

test('a live build makes the row read as building — and stops once it lands', async () => {
  const { subject, restore, release, cloneStarted } = loadStaging();
  try {
    const session = { id: 91, branch_name: 'contributor/f', pr_number: 9401, staging_container_id: null };
    const build = subject.buildAndDeployStaging({ jwtSecret: 's' }, session, APP, 'abc123');
    await cloneStarted;

    const during = subject.previewDisplayState({ id: 91, staging_url: null, check_state: 'pending' });
    assert.equal(during.staging_building, true, 'the in-flight build is what lights the pill');
    assert.equal(during.staging_error, null, 'a build in progress is not a failure');

    // A row that already HAS a preview never shows the pill, even mid-rebuild:
    // the working Preview button is the more useful affordance.
    const withUrl = subject.previewDisplayState({ id: 91, staging_url: 'https://x', check_state: 'pending' });
    assert.equal(withUrl.staging_building, false, 'staging_url wins over a rebuild');

    release();
    await build;
    const after = subject.previewDisplayState({ id: 91, staging_url: null, check_state: 'pending' });
    assert.equal(after.staging_building, false, 'the flag clears when the build finishes');
  } finally { restore(); }
});

test('a checks error with no preview surfaces its reason as staging_error', async () => {
  const { subject, restore, release } = loadStaging();
  try {
    release();
    const reason = 'app failed to boot: missing required secret DEMO_API_KEY';
    assert.deepEqual(
      subject.previewDisplayState({ id: 4, staging_url: null, check_state: 'error', check_error_detail: reason }),
      { staging_building: false, staging_error: reason }
    );
    // A live preview means the reviewer can look for themselves — an older
    // checks error is not a preview failure.
    assert.equal(
      subject.previewDisplayState({ id: 4, staging_url: 'https://x', check_state: 'error', check_error_detail: reason }).staging_error,
      null, 'a working preview is never reported as unavailable'
    );
    // Only 'error' means "the build/run itself broke". Failing tests ran
    // against a preview that exists.
    assert.equal(
      subject.previewDisplayState({ id: 4, staging_url: null, check_state: 'failing', check_error_detail: reason }).staging_error,
      null, "'failing' is a test verdict, not a broken preview"
    );
    // No detail → no chip. An empty tooltip would be worse than the plain
    // "not previewable yet" empty slot.
    assert.equal(
      subject.previewDisplayState({ id: 4, staging_url: null, check_state: 'error', check_error_detail: null }).staging_error,
      null, 'a reasonless error stays silent'
    );
  } finally { restore(); }
});

// ── client rendering (public/js/app-view.js) ────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView({ readOnly = false } = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: false } },
    Kudos: { renderButton: () => '' },
    MergeStatus: null,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._sessionTesting = {};
  // readOnly is a getter derived from appData.can_collaborate.
  AppView.appData = { slug: 'widget', can_collaborate: !readOnly };
  return AppView;
}

const PR = (over) => ({
  id: 77, pr_number: 900141, pr_title: 'Imported thing', username: 'octo-contributor',
  user_id: 9, status: 'promoted', source: 'imported', created_at: '2026-07-01T00:00:00Z',
  yes_count: 1, no_count: 0, staging_url: null, staging_building: false, staging_error: null,
  ...over,
});

test('a built preview renders the ordinary Preview button', () => {
  const AppView = makeAppView();
  const html = AppView.voteButtonsHtml(PR({ staging_url: 'https://widget--abc123.example.test' }));
  assert.match(html, />Preview</, 'Preview button present');
  assert.match(html, /swapToStagingForSession\(77, 'https:\/\/widget--abc123\.example\.test'\)/);
  assert.doesNotMatch(html, /Preview building/, 'not also claiming to be building');
  assert.doesNotMatch(html, /Retry preview/, 'nothing to retry');
});

test('a build in flight renders a non-interactive "Preview building…" pill', () => {
  const AppView = makeAppView();
  const html = AppView.voteButtonsHtml(PR({ staging_building: true }));
  assert.match(html, /Preview building/, 'the building state is stated, not left blank');
  assert.ok(!/onclick="AppView\.swapToStagingForSession\(77/.test(html),
    'not clickable: an ensure-staging POST mid-build can only answer "rebuilding"');
  assert.match(html, /dc-status-spinner-arc/, 'carries the shared spinner glyph');
  assert.doesNotMatch(html, /Retry preview/, 'a running build is not retried');
  // Voting is unaffected by a missing preview.
  assert.match(html, /castVote\(77, 'yes'\)/);
});

test('a failed build renders the unavailable chip with the reason, plus Retry preview', () => {
  const AppView = makeAppView();
  const reason = 'missing required secret DEMO_API_KEY';
  const html = AppView.voteButtonsHtml(PR({ staging_error: reason }));
  assert.match(html, /Preview unavailable/, 'says so rather than rendering an empty slot');
  assert.ok(html.includes(reason), 'the captured reason rides along in the tooltip');
  assert.match(html, /Retry preview/, 'a viewer who can act gets an escape hatch');
  // The retry goes through ensure-staging (swapToStagingForSession with no
  // URL → ensureStaging → POST /api/sessions/:id/ensure-staging).
  assert.match(html, /Retry preview<\/button>/);
  assert.match(html, /swapToStagingForSession\(77, ''\)/);
});

test('a read-only viewer sees the state but gets no Retry preview', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.equal(AppView.readOnly, true, 'viewer is read-only');
  const html = AppView.voteButtonsHtml(PR({ staging_error: 'boom' }));
  assert.match(html, /Preview unavailable/, 'the state is still explained');
  assert.doesNotMatch(html, /Retry preview/, 'the ensure POST is collab-gated');
  assert.doesNotMatch(html, /castVote/, 'and no vote controls, as before');
});

test('neither flag keeps the historical empty slot', () => {
  const AppView = makeAppView();
  const html = AppView.voteButtonsHtml(PR({}));
  assert.doesNotMatch(html, /Preview/, 'a plain GC\'d/never-built row renders no preview affordance');
});

test('the detail view explains the same three states in prose', () => {
  const AppView = makeAppView();
  const building = detailsHtml(AppView, PR({ staging_building: true }), { majority: 1 });
  assert.match(building, /staging preview is being built/i);
  assert.match(building, /few minutes/i, 'sets an expectation for how long');

  const failed = detailsHtml(AppView, 
    PR({ staging_error: 'missing required secret DEMO_API_KEY' }), { majority: 1 }
  );
  assert.match(failed, /couldn(&#x27;|')t be built/i);
  assert.ok(failed.includes('missing required secret DEMO_API_KEY'), 'names the reason');

  const ready = detailsHtml(AppView, PR({ staging_url: 'https://x' }), { majority: 1 });
  assert.doesNotMatch(ready, /being built/i, 'a ready preview says nothing about building');
});

// ── routes/votes.js source invariants ──────────────────────────────────

const VOTES_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');

test('both proposal queries derive the two preview fields', () => {
  const calls = VOTES_SRC.match(/previewDisplayState\(/g) || [];
  assert.ok(calls.length >= 2,
    'the app proposal list AND the home-strip/work-drawer list both need the fields — '
    + 'a card that renders in two places must not disagree with itself');
  // The home-strip query has to actually select what the derivation reads.
  assert.match(VOTES_SRC, /cs\.staging_url, cs\.source,/,
    '/api/me/proposals selects staging_url (the derivation is "no url AND …")');
});

test('the staging ?demo=1 mocks cover all three preview states', () => {
  const start = VOTES_SRC.indexOf('function stagingMockProposals(');
  const end = VOTES_SRC.indexOf('function stagingMockMerged(');
  assert.ok(start >= 0 && end > start, 'found the mock-proposal factory');
  const body = VOTES_SRC.slice(start, end);

  const imported = body.match(/source: 'imported'/g) || [];
  assert.ok(imported.length >= 3,
    'one imported mock per preview state — these pills cannot be seeded in the DB '
    + 'because staging_building is derived from an in-memory build registry');
  assert.match(body, /staging_building: true/, 'the building pill has a fixture');
  assert.match(body, /staging_error: '[^']+'/, 'the unavailable chip has a fixture');
  assert.match(body, /staging_url: 'https:\/\/mock-preview/, 'the Preview button has a fixture');
  // Staging-fixture conventions: obviously fake, and never in production.
  const titles = [...body.matchAll(/'(\[Mock\] Imported-preview test[^']*)'/g)].map((m) => m[1]);
  assert.equal(titles.length, 3, 'all three are [Mock]-prefixed');
  assert.match(VOTES_SRC, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/,
    'mock rows are staging-gated');
});

test('dapp.json asserts the text the new pills render', () => {
  const dapp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const mine = (dapp.tests || []).filter((t) => /#866/.test(t.name || ''));
  assert.ok(mine.length >= 2, 'the new states are checked on merge');
  for (const t of mine) {
    assert.match(t.path, /demo=1/, 'the mock rows only render under ?demo=1');
    assert.match(t.path, /#app\/[^/]+\/dev/, 'and only on the proposal screen');
  }
  const texts = mine.map((t) => t.expectText).filter(Boolean);
  assert.ok(texts.some((t) => /Preview building/.test(t)), 'building pill checked');
  assert.ok(texts.some((t) => /Preview unavailable/.test(t)), 'unavailable chip checked');
});

// ── the sweeper's two guards (server.js) ────────────────────────────────
//
// server.js cannot be required here — it binds ports and starts timers on
// load — so these are source invariants over the two edits the spec asks
// for. Both are one-line guards whose absence is silent and destructive, so
// they're worth pinning even at this coarse granularity.
//
//  Pass 3 (staging heal): an imported proposal's first build runs with no
//  worker attached and takes minutes, during which staging_url is NULL. Without
//  the guard the heal pass reads "preview missing" and launches a SECOND build
//  of the same commit.
//
//  Pass 2 (idle GC): archived rows are now reclaimable — a withdrawn
//  proposal's container is pure waste — but the same in-flight check has to
//  stand between the GC and a live build, or the GC deletes the container the
//  build is about to record.
test('server.js sweeper: both passes consult staging.hasInFlightBuild', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'), 'utf8'
  );

  assert.match(src, /const stagingSvc = require\('\.\/src\/services\/staging'\)/,
    'named stagingSvc: recoverActiveWorkers() already binds a local `staging`');

  const guards = src.match(/stagingSvc\.hasInFlightBuild\(/g) || [];
  assert.equal(guards.length, 2, 'one guard in the idle-GC pass, one in the heal pass');
  assert.match(src, /if \(stagingSvc\.hasInFlightBuild\(session\.id\)\) continue;/,
    'heal pass skips the session instead of starting a duplicate build');
  assert.match(src, /if \(stagingSvc\.hasInFlightBuild\(row\.id\)\) continue;/,
    'GC pass leaves a live build\'s container alone');

  // The GC query no longer excludes archived rows...
  assert.match(src, /AND status NOT IN \('promoted', 'merging', 'merged'\)/);
  assert.ok(!/NOT IN \('promoted', 'merging', 'merged', 'archived'\)/.test(src),
    'archived rows are in scope now — that is the withdrawn-mid-build leak');
  // ...but it still refuses to touch a session mid-turn.
  assert.match(src, /if \(activeWorkersSvc\.isSessionBusy\(row\.id\)\) continue;\n\s*\/\//);
});
