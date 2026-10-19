'use strict';

// The pass that measures every promoted proposal against main
// (server.js measurePromotedProposals, services/integration.js).
//
// It lived inside the session sweeper and fetched the whole repository once
// per proposal: on 19 Oct 2026 a pass measured about 126 proposals with a
// full `git fetch` each, every two minutes, and held idle pausing, preview
// cleanup and the staging heal for two to ten minutes a pass. Pinned here:
//
//   1. measure() reads a mirror the caller already fetched (`mirrorDir`)
//      without fetching again; without one it fetches as before.
//   2. fetchAppMirror fetches an app's mirror once, with every commit its
//      proposals will ask about.
//   3. The pass groups by app, fetches once per app, falls back to each
//      measurement's own fetch when that fails, and runs on its own
//      single-flight timer that a shutdown stops.
//
// Run with: node --test tests/proposal-measure-pass.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

require.cache[require.resolve('../src/services/ws')] = {
  id: 'ws', filename: 'ws', loaded: true,
  exports: { pushSessionUpdate: () => {}, sendSystemMessage: async () => {} },
};

const mirror = require('../src/services/repo-mirror');
const integration = require('../src/services/integration');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const sha = (c) => c.repeat(40);

function stubMirror() {
  const ensured = [];
  const real = {};
  const fns = {
    ensureMirror: async (owner, repo, opts) => { ensured.push({ owner, repo, refs: opts && opts.refs }); return '/tmp/fetched-mirror'; },
    defaultBranchSha: async () => sha('b'),
    resolveBranch: async () => sha('a'),
    mergeBase: async () => sha('c'),
    behindBy: async () => 0,
    aheadBy: async () => 1,
    mergeTree: async () => ({ clean: true, conflicts: [], tree: sha('e') }),
    hasCommit: async () => true,
    isAncestor: async () => true,
  };
  for (const [k, v] of Object.entries(fns)) { real[k] = mirror[k]; mirror[k] = v; }
  return { ensured, restore: () => { for (const [k, v] of Object.entries(real)) mirror[k] = v; } };
}

const pool = { async query() { return { rows: [{ was_clean: true, was_head: sha('a') }], rowCount: 1 }; } };
const session = (id, more = {}) => ({
  id, status: 'promoted', repo_url: 'https://github.com/org/app', branch_name: `b${id}`, app_slug: 'app',
  reviewed_head_sha: sha(String(id % 10)), ...more,
});

test('measure reads a mirror the caller fetched, and fetches for itself without one', async () => {
  const m = stubMirror();
  try {
    const out = await integration.measure({ pool, session: session(1) }, { force: true, mirrorDir: '/tmp/fetched-mirror' });
    assert.equal(out.error ?? null, null);
    assert.equal(m.ensured.length, 0, 'no fetch of its own');
    await integration.measure({ pool, session: session(2) }, { force: true });
    assert.equal(m.ensured.length, 1, 'a measurement on its own fetches as before');
    assert.deepEqual(m.ensured[0].refs, [sha('2')]);
  } finally { m.restore(); }
});

test('an app\'s mirror is fetched once, with every commit its proposals ask about', async () => {
  const m = stubMirror();
  try {
    const dir = await integration.fetchAppMirror([
      session(1, { checks_commit_sha: sha('d') }),
      session(2),
      session(3, { reviewed_head_sha: sha('1') }),
    ]);
    assert.equal(dir, '/tmp/fetched-mirror');
    assert.equal(m.ensured.length, 1);
    assert.deepEqual(m.ensured[0], { owner: 'org', repo: 'app', refs: [sha('1'), sha('d'), sha('2')] }, 'each commit once');
    assert.equal(await integration.fetchAppMirror([]), null);
    assert.equal(await integration.fetchAppMirror([{ id: 4, repo_url: 'not a repo' }]), null);
  } finally { m.restore(); }
});

test('the pass fetches once per app, measures each proposal from it, and falls back when the fetch fails', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function measurePromotedProposals('), SERVER.indexOf('function startSessionAutoPauseSweeper('));
  assert.ok(fn.length > 0);
  assert.match(fn, /ORDER BY cs\.app_id, cs\.integration_measured_at NULLS FIRST/);
  assert.match(fn, /for \(const sessions of byApp\.values\(\)\)/);
  assert.match(fn, /const mirrorDir = await integrationSvc\.fetchAppMirror\(ready\)\.catch\(/);
  assert.match(fn, /integrationSvc\.measure\(\{ pool, session \}, \{ force: true, \.\.\.\(mirrorDir \? \{ mirrorDir \} : \{\}\) \}\)/,
    'with the app\'s mirror when it was fetched, and a fetch of its own when not');
  assert.match(fn, /!\(worker\.isInFlight\(session\.id\) \|\| activeWorkersSvc\.isSessionBusy\(session\.id\)\)/, 'never a session mid-turn');
});

test('the measurement runs on its own single-flight timer, not inside the session sweeper, and a shutdown stops it', () => {
  const sweeper = SERVER.slice(SERVER.indexOf("sessionSweeperHandle = setInterval(singleFlight('session-sweeper'"),
    SERVER.indexOf("proposalMeasureHandle = setInterval(singleFlight('proposal-measure'"));
  assert.ok(sweeper.length > 0, 'the measurement timer starts after the sweeper');
  assert.doesNotMatch(sweeper, /integrationSvc\.measure|measurePromotedProposals\(/, 'no pass of the sweeper measures');
  assert.match(SERVER, /proposalMeasureHandle = setInterval\(singleFlight\('proposal-measure', async \(\) => \{\n\s+if \(lifecycle\.isShuttingDown\(\)\) return;\n\s+try \{\n\s+await measurePromotedProposals\(pool\);/);
  assert.match(SERVER, /if \(proposalMeasureHandle\) \{\n\s+clearInterval\(proposalMeasureHandle\);\n\s+proposalMeasureHandle = null;\n\s+\}/);
});
