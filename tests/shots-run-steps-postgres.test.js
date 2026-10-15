'use strict';

// The steps of a before & after shots run (services/shots-orchestrator.js),
// as the shots machine's work runs them, against the full PostgreSQL schema
// for the agent's workspace (services/shots-control.js): the copies and the
// workspace they leave, the agent's turn and what its workspace adds up to,
// the comparison, and the cleanup. The outside world (builds, runtimes,
// GitHub, the worker) is faked; the decisions on these results are the
// machine's (tests/workflow-shots-postgres.test.js).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/shots-run-steps-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const contract = require('../src/services/visible-changes');
const shotsControl = require('../src/services/shots-control');
const orchestrator = require('../src/services/shots-orchestrator');
const fixtures = require('./fixtures/shots');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ORIGINS = { base: 'http://base.internal:3000', head: 'http://head.internal:3000' };
const TOKENS = { member: 'member.jwt', read_only_admin: 'admin.jwt', full_admin: 'full-admin.jwt' };
const TILES = {
  base: { name: 'Demo', icon: { kind: 'letter', letter: 'D' }, color: null },
  head: { name: 'Demo 2', icon: { kind: 'emoji', emoji: '🧭' }, color: '#123456' },
};

test('the steps of a shots run against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'shots_steps_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  // A second process's pool: the agent's calls land on whichever serves them.
  const other = new Pool({ connectionString: String(url), max: 2 });
  other.on('error', () => {});
  t.after(async () => {
    await pool.end(); await other.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function proposal({ source = null, selfApp = false } = {}) {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`st_${++seq}`]);
    const slug = selfApp ? 'homeroom' : `steps-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1, $1, $2, $3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
      [slug, u.id, `https://github.com/acme/${slug}.git`]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, reviewed_head_sha, pr_title)
       VALUES ($1, $2, 'promoted', $3, 'proposal', $4, $5, 'Show suggestions') RETURNING *`,
      [a.id, u.id, source, ++seq, HEAD]);
    return { ...s, app: a };
  }
  const runId = () => crypto.randomBytes(16).toString('hex');
  // The run is the proposal's current one and its agent at work: what the
  // control plane answers a proposal's run for.
  const taking = (s, id) => pool.query(`UPDATE chat_sessions SET shots_run_id = $2, shots_state = 'exploring' WHERE id = $1`, [s.id, id]);

  const github = {
    compareRefs: async () => ({ files: [{ filename: 'public/js/app.js' }], filesComplete: true, mergeBaseSha: BASE }),
    getRepoHead: async () => ({ defaultBranch: 'main' }),
    getProposalDiff: async () => ({ diff: '+ suggestions', fileCount: 1, truncated: false }),
  };
  function copiesDeps({ provenance = {}, afterOnly = false, removed = [] } = {}) {
    const calls = { prepare: [], reset: 0, guest: 0, removed: [], tiles: 0 };
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-shots-test-'));
    return {
      calls, rootDir,
      deps: {
        github,
        removeCopies: async (_config, ref) => { calls.removed.push(ref); return removed; },
        environment: {
          preparePair: async (_config, o) => {
            calls.prepare.push({ images: o.images });
            const images = o.images || { base: { imageRef: 'img:base', imageDigest: 'sha256:base' }, head: { imageRef: 'img:head', imageDigest: 'sha256:head' } };
            if (o.onImages) await o.onImages(images);
            return { runId: o.run.id, rootDir, fixtureFingerprint: 'fixture-1', preparedSource: {},
              sides: { base: { ...images.base, checkout: rootDir }, head: { ...images.head, checkout: rootDir } } };
          },
          resetPair: async () => {
            calls.reset += 1;
            return { origins: { ...ORIGINS }, baseSha: BASE, headSha: HEAD, fixtureFingerprint: 'fixture-1',
              baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head', ...provenance };
          },
        },
        identities: {
          shotsGuestIdentity: async () => { calls.guest += 1; return { kind: 'guest', token: 'guest.jwt' }; },
          mintShotsAuthTokens: async () => ({ ...TOKENS }),
        },
        shotsHomeTile: { tilesForPair: async () => { calls.tiles += 1; return TILES; } },
        shotsStarter: { beforeIsStarter: async () => afterOnly },
      },
    };
  }
  const intent = contract.parseIntent(fixtures.intent());
  const copies = (s, id, extra = {}, deps) => orchestrator.buildCopies({ selfAppSlug: 'homeroom' }, pool, {
    runId: id, sessionId: s.id, intent, baseSha: BASE, headSha: HEAD, budgetMs: 60_000, ...extra,
  }, deps);

  await t.test('the copies leave the agent\'s workspace: its brief, the addresses, no fixture secret', async () => {
    const s = await proposal();
    const id = runId();
    const { deps, calls, rootDir } = copiesDeps();
    let kept = null;
    const out = await copies(s, id, { onImages: (images) => { kept = images; } }, deps);
    assert.deepEqual(out, { fixtureFingerprint: 'fixture-1', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head', afterOnly: false });
    assert.deepEqual(kept.base.imageRef, 'img:base', 'the images are handed over once built (the step\'s checkpoint)');
    assert.equal(fs.existsSync(rootDir), false, 'the checkouts are this process\'s and go');
    assert.deepEqual(calls.removed, [], 'nothing to remove on a fresh step');
    const { rows: [row] } = await pool.query('SELECT * FROM shot_run_control WHERE run_id = $1', [id]);
    assert.equal(row.kind, 'run');
    assert.equal(row.context.declaredChanges[0].id, 'invite-suggestions');
    assert.deepEqual(row.context.addresses, { before: ORIGINS.base, after: ORIGINS.head });
    assert.equal(row.context.phoneSignIn, undefined, 'a child app\'s copies have no phone sign-in');
    assert.deepEqual(row.agent.origins, ORIGINS);
    assert.equal(row.agent.phoneTestCode, null);
    assert.deepEqual(row.home_tiles, TILES);
    assert.equal(row.context.homeTile.differs, true, 'the brief describes the tiles, never their bytes');
    assert.doesNotMatch(JSON.stringify(row), /member\.jwt|admin\.jwt|guest\.jwt/, 'no sign-in token is kept');
  });

  await t.test('a step taken again reuses the built images and removes what the earlier attempt left first', async () => {
    const s = await proposal();
    const id = runId();
    const { deps, calls } = copiesDeps();
    const images = { base: { imageRef: 'old:base', imageDigest: 'sha256:base' }, head: { imageRef: 'old:head', imageDigest: 'sha256:head' } };
    await copies(s, id, { images, fresh: false }, deps);
    assert.deepEqual(calls.prepare[0].images, images);
    assert.deepEqual(calls.removed.map((r) => r.runId), [id]);
    const left = copiesDeps({ removed: [new Error('still there')] });
    await assert.rejects(copies(s, runId(), { fresh: false }, left.deps), (err) => {
      assert.equal(err.code, 'shots_copies_left');
      assert.equal(err.shotsPlatformFault, 'database', 'a platform fault: taken again once');
      return true;
    });
    assert.equal(left.calls.reset, 0, 'nothing is built over what was left');
  });

  await t.test('builds that do not match their fixture and images fail before any guest or workspace', async () => {
    const s = await proposal();
    const id = runId();
    const { deps, calls } = copiesDeps({ provenance: { headImageDigest: 'sha256:other' } });
    await assert.rejects(copies(s, id, {}, deps), { code: 'shots_provenance_mismatch' });
    assert.equal(calls.guest, 0);
    assert.equal((await pool.query('SELECT 1 FROM shot_run_control WHERE run_id = $1', [id])).rowCount, 0);
  });

  await t.test('a first version takes the after side only; Homeroom itself never asks', async () => {
    const s = await proposal();
    const id = runId();
    const out = await copies(s, id, {}, copiesDeps({ afterOnly: true }).deps);
    assert.equal(out.afterOnly, true);
    assert.equal((await pool.query('SELECT after_only FROM shot_run_control WHERE run_id = $1', [id])).rows[0].after_only, true);
    const own = await proposal({ selfApp: true });
    const ownId = runId();
    const d = copiesDeps({ afterOnly: true, provenance: { phoneTestCode: '482913' } });
    const mine = await copies(own, ownId, {}, d.deps);
    assert.equal(mine.afterOnly, false, 'the starter check is not read for Homeroom');
    const { rows: [row] } = await pool.query('SELECT context, agent FROM shot_run_control WHERE run_id = $1', [ownId]);
    assert.equal(row.agent.platformAssets, false, 'Homeroom serves its own bridge and kit');
    assert.match(JSON.stringify(row.context.phoneSignIn), /482913/, 'Homeroom\'s copies hand the agent the run\'s phone code');
  });

  // ── The agent's turn ──────────────────────────────────────────────────

  async function prepared(s, extra = {}) {
    const id = runId();
    await copies(s, id, {}, copiesDeps(extra).deps);
    await taking(s, id);
    return id;
  }
  function agentDeps(behaviour) {
    const calls = { dispatches: [], stops: [], clears: 0 };
    return {
      calls,
      deps: {
        identities: { shotsGuestIdentity: async () => ({ kind: 'guest', token: 'guest.jwt' }), mintShotsAuthTokens: async () => ({ ...TOKENS }) },
        worker: { stopTurn: async (id) => { calls.stops.push(id); }, clearPendingStop: () => { calls.clears += 1; } },
        shotsAgent: {
          dispatch: async (_config, options) => {
            calls.dispatches.push(options);
            return behaviour(options);
          },
        },
      },
    };
  }
  // What the agent's tools do, through another process's pool.
  const save = (options, change, side, shade) => shotsControl.withControl(other, { runId: options.runId, sessionId: options.session.id },
    (c) => c.saveShot({ change, screen: 'desktop', side, kind: 'screen' }, fixtures.png({ shade })));
  const agent = (s, id, deps, extra = {}) => orchestrator.dispatchAgent({}, pool, { runId: id, sessionId: s.id, budgetMs: 60_000, ...extra }, deps);

  await t.test('the agent saves through any process; a complete set is a verdict to publish, its slots named', async () => {
    const s = await proposal();
    const id = await prepared(s);
    const { deps, calls } = agentDeps(async (options) => {
      await save(options, 'invite-suggestions', 'before', 10);
      await save(options, 'invite-suggestions', 'after', 200);
      await save(options, 'invite-suggestions', 'after', 201);   // a retake replaces the slot
      return { backend: 'claude_code', model: 'claude-sonnet-5-5', result: { exitCode: 0 } };
    });
    const out = await agent(s, id, deps);
    assert.deepEqual(out.agent, { outcome: 'completed' });
    assert.equal(out.passed, true);
    assert.deepEqual(out.slots.sort(), ['invite-suggestions/desktop/base/context', 'invite-suggestions/desktop/head/context']);
    assert.match(out.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(out.verdict.stories[0].status, 'ready');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM shot_run_files WHERE run_id = $1', [id])).rows[0].n, 2);
    const [options] = calls.dispatches;
    assert.deepEqual(options.authTokens, { ...TOKENS, guest: 'guest.jwt' }, 'the sign-in tokens reach the dispatch only');
    assert.equal(options.resumeThreadId, null, 'never the proposal\'s coding thread');
    assert.deepEqual(options.origins, ORIGINS);
    assert.equal(calls.clears, 1, 'a stop marker an earlier turn left is cleared');
  });

  await t.test('a skipped change, a broken one, and nothing saved: each says why, for the machine to fail on', async () => {
    const s = await proposal();
    const skipped = await prepared(s);
    let out = await agent(s, skipped, agentDeps(async (options) => {
      await shotsControl.withControl(other, { runId: options.runId, sessionId: s.id },
        (c) => c.skipChange({ change: 'invite-suggestions', reason: 'These copies have no members to invite.' }));
      return { result: {} };
    }).deps);
    assert.deepEqual([out.passed, out.skippedAny, out.failedCount], [false, true, 0]);
    assert.match(out.incompleteReason, /no members to invite/);
    const s2 = await proposal();
    const broken = await prepared(s2);
    out = await agent(s2, broken, agentDeps(async (options) => {
      await shotsControl.withControl(other, { runId: options.runId, sessionId: s2.id },
        (c) => c.skipChange({ change: 'invite-suggestions', reason: 'Typing showed a server error.', outcome: 'failed' }));
      return { result: {} };
    }).deps);
    assert.equal(out.failedCount, 1);
    assert.match(out.failedReason, /^Tried "Typing a username shows suggestions/);
    const s3 = await proposal();
    const empty = await prepared(s3);
    out = await agent(s3, empty, agentDeps(async () => { throw Object.assign(new Error('boom'), { code: 'shots_agent_failed' }); }).deps);
    assert.deepEqual([out.agent.outcome, out.agent.code, out.passed, out.skippedAny], ['failed', 'shots_agent_failed', false, false]);
    assert.match(out.incompleteReason, /did not save/);
  });

  await t.test('how the turn ended: another turn took the agent, its process died, its clock ran out', async () => {
    const s = await proposal();
    const id = await prepared(s);
    let out = await agent(s, id, agentDeps(async () => {
      throw Object.assign(new Error('durable active turn could not be persisted'), { code: 'TURN_IN_FLIGHT' });
    }).deps);
    assert.equal(out.agent.outcome, 'busy');
    out = await agent(s, id, agentDeps(async () => {
      throw Object.assign(new Error('x'), { code: 'shots_agent_failed', shotsExitCause: 'oom_killed', shotsExitCode: 137 });
    }).deps);
    assert.deepEqual([out.agent.outcome, out.agent.exitCause, out.agent.exitCode, out.agent.platformFault.kind],
      ['died', 'oom_killed', 137, 'agent_exit']);
    out = await agent(s, id, agentDeps(async () => {
      throw Object.assign(new Error('The shots agent ran out of time.'), { code: 'shots_agent_timeout' });
    }).deps);
    assert.equal(out.agent.outcome, 'timed_out');
  });

  await t.test('a call from a turn that outlived its run changes nothing', async () => {
    const s = await proposal();
    const id = await prepared(s);
    await pool.query(`UPDATE chat_sessions SET shots_state = 'failed' WHERE id = $1`, [s.id]);
    await assert.rejects(shotsControl.withControl(other, { runId: id, sessionId: s.id },
      (c) => c.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'screen' }, fixtures.png())),
    { code: 'shots_control_not_found' });
    await assert.rejects(shotsControl.withControl(other, { runId: id, sessionId: s.id + 1000 }, (c) => c.getContext()),
      { code: 'shots_scope_mismatch' }, 'another proposal\'s token');
  });

  await t.test('a refused save is kept for the owner\'s diagnostics, and saves nothing', async () => {
    const s = await proposal();
    const id = await prepared(s);
    await assert.rejects(shotsControl.withControl(other, { runId: id, sessionId: s.id },
      (c) => c.saveShot({ change: 'nope', screen: 'desktop', side: 'before', kind: 'screen' }, fixtures.png())));
    const { rows: [row] } = await pool.query('SELECT last_tool_failure FROM shot_run_control WHERE run_id = $1', [id]);
    assert.equal(row.last_tool_failure.operation, 'save-shot');
    assert.equal((await pool.query('SELECT 1 FROM shot_run_files WHERE run_id = $1', [id])).rowCount, 0);
  });

  // ── Comparing, and cleaning up ────────────────────────────────────────

  await t.test('the comparison outlines the ready screens and marks the ones that came out the same', async () => {
    const s = await proposal();
    const id = await prepared(s);
    const out = await agent(s, id, agentDeps(async (options) => {
      await save(options, 'invite-suggestions', 'before', 10);
      await save(options, 'invite-suggestions', 'after', 200);
      return { result: {} };
    }).deps);
    const seen = [];
    const verdict = await orchestrator.compareScreens(pool, { runId: id, verdict: out.verdict }, {
      shotsDiff: {
        screensFor: async (stories, files) => { seen.push(stories.map((st) => st.id), files.length); return [{ change: 'invite-suggestions' }]; },
        unchangedStories: () => new Set(['invite-suggestions']),
      },
    });
    assert.deepEqual(seen, [['invite-suggestions'], 2]);
    assert.deepEqual(verdict.screens, [{ change: 'invite-suggestions' }]);
    assert.equal(verdict.stories[0].unchanged, true);
    const failing = await orchestrator.compareScreens(pool, { runId: id, verdict: out.verdict }, {
      shotsDiff: { screensFor: async () => { throw new Error('decode'); } },
    });
    assert.deepEqual(failing, out.verdict, 'a comparison that fails publishes without outlines');
  });

  await t.test('cleanup stops only the run\'s own turn, removes its copies and workspace, and keeps trying while any is left', async () => {
    const s = await proposal();
    const id = await prepared(s);
    const stops = [];
    const released = [];
    const worker = { stopTurn: async (sid) => { stops.push(sid); }, finishTurn: async (sid, o) => { released.push([sid, o.turnId]); },
      destroyCcVolume: async (sid) => { stops.push(['volume', sid]); } };
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
      [s.id, JSON.stringify({ mode: 'shots', telemetryCorrelationId: 'someone-else', turnId: 't-0' })]);
    await assert.rejects(orchestrator.cleanupRun({}, pool, { runId: id, sessionId: s.id, appSlug: s.app.slug, stopTurn: true },
      { worker, removeCopies: async () => [new Error('db busy')] }), { code: 'shots_cleanup_incomplete' });
    assert.deepEqual(stops, [], 'another run\'s turn is left alone');
    assert.equal((await pool.query('SELECT 1 FROM shot_run_control WHERE run_id = $1', [id])).rowCount, 1, 'kept until the copies go');
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
      [s.id, JSON.stringify({ mode: 'shots', telemetryCorrelationId: id, turnId: 't-1' })]);
    const done = await orchestrator.cleanupRun({}, pool, { runId: id, sessionId: s.id, appSlug: s.app.slug, stopTurn: true, worker: true },
      { worker, removeCopies: async () => [] });
    assert.equal(done.cleaned, true);
    assert.deepEqual(stops, [s.id, ['volume', s.id]]);
    assert.equal(released.length, 1, 'its turn record is released');
    assert.equal((await pool.query('SELECT 1 FROM shot_run_control WHERE run_id = $1', [id])).rowCount, 0);
  });
});
