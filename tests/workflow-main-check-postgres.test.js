'use strict';

// The unit suite on each new main against the full PostgreSQL schema: the
// main-check machine (src/workflow/main-check/), one instance per app, and
// its handlers (services.ts) with main-watch's run and filings faked. Each
// rule services/main-watch.js afterMerge, resume, recheckPaused and
// resumeInterrupted kept by hand is pinned here as the machine's: the
// apps.main_check_* row is its projection, every verdict a
// main_watch_verdicts row, a pause starting or ending an events row, and a
// kick a MergeWanted message to the app's merge queue.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-main-check-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

// main-watch's run and filings, and main-red-fix's request, faked before
// services.ts reaches them through the shared require cache (legacy.ts).
const suite = { calls: [], scripts: new Map(), reuse: [] };
const filings = [];
const fixes = [];
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const fileBotIssue = async () => 1;
stub('../src/services/main-watch', {
  // The next answer scripted for the app: a verdict, an Error to throw, or
  // a function of the call (which may checkpoint the run id and wait).
  async runMainSuite(config, pool, args) {
    suite.calls.push({ appId: args.app.id, slug: args.app.slug, sha: args.sha, resumeRunId: args.resumeRunId });
    suite.reuse.push([args.sha, args.reuse]);
    const next = (suite.scripts.get(args.app.id) || []).shift();
    if (next === undefined) throw new Error(`no run scripted for app ${args.app.id}`);
    const answer = typeof next === 'function' ? await next(args) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  },
  async noteFlakes(config, pool, app, sha, reds, excerpts) {
    filings.push({ mode: 'note', appId: app.id, sha, reds, excerpts });
    return [];
  },
  // One call per test now (the work files each as a step of its own); the
  // calls of one item are read as one filing.
  async fileFlakeRequest(config, pool, app, t, { mergeSha, excerpt }) {
    const last = filings.at(-1);
    const one = last && last.mode === 'request' && last.appId === app.id && last.sha === mergeSha && !last.done ? last : null;
    if (one) { one.tests.push(t); if (excerpt) one.excerpts.push(excerpt); } else {
      filings.push({ mode: 'request', appId: app.id, sha: mergeSha, tests: [t], excerpts: excerpt ? [excerpt] : [] });
    }
    return null;
  },
  fileBotIssue,
});
// `fixScripts`: the next answer scripted for the app's fix request, a
// function of the call (which may keep its claim and wait).
const fixScripts = new Map();
stub('../src/services/main-red-fix', {
  async fileFixRequest(config, pool, args) {
    fixes.push({ ...args, appId: args.app.id });
    const next = (fixScripts.get(args.app.id) || []).shift();
    return next ? next(args) : 700;
  },
});

const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { mainCheck, appKey, MACHINE, WORK, DEFAULTS } = require('../src/workflow/main-check/machine.ts');
const { mainCheckServices } = require('../src/workflow/main-check/services.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const [S1, S2, S3] = [SHA('1'), SHA('2'), SHA('3')];

const FLAKY = { file: 'tests/bot-clock.test.js', test: 'the clock reads the next whole minute' };
const OTHER = { file: 'tests/persona.test.js', test: 'persona listener hears the reply' };
const REAL = { file: 'tests/sessions.test.js', test: 'shared-sessions returns linked_issues per row' };
const DB = { file: 'tests/db-export-service.test.js', test: 'backpressure pauses the child instead of buffering the dump' };
const PUSH = { file: 'tests/social-push-web.test.js', test: 'tap retries are bounded and pagehide cancels a scheduled retry' };

// What main-watch.runMainSuite resolves (its classify).
const green = { state: 'passing', detail: { summary: { tests: 40, pass: 40, fail: 0 } } };
const redOn = (tests, { complete = true, excerpts = [] } = {}) => ({
  state: 'failing',
  detail: {
    summary: { tests: 40, pass: 40 - tests.length, fail: tests.length },
    failureReason: tests.map((x) => `${x.file} (1): ${x.test}`).join(' | '),
    failingTests: tests, failingTestsComplete: complete,
  },
  excerpts,
});
const cannot = (why) => ({ state: 'error', detail: { failureReason: why } });
// The suite's own account of a red, as the machine keeps it (redOf).
const accountOf = (v) => {
  const { summary, failureReason, failingTests, failingTestsComplete } = v.detail;
  return { summary, failureReason, failingTests, failingTestsComplete };
};

test('the main check against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_main_check_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  async function app({ repo = true } = {}) {
    const slug = `mc-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, status) VALUES ($1, $1, $2, $3, 'running') RETURNING *`,
      [slug, owner.id, repo ? `https://github.com/acme/${slug}` : null]);
    return a;
  }
  // An app's main_check_* columns, written before any instance holds it.
  const seed = (a, { state, sha = S1, detail = {}, paused = null, at = 'now()' }) => pool.query(
    `UPDATE apps SET main_check_state = $2, main_check_sha = $3, main_check_detail = $4::jsonb,
            main_check_paused_sha = $5, main_check_at = ${at} WHERE id = $1`,
    [a.id, state, sha, JSON.stringify(detail), paused]);
  const knownFlake = (a, x, { daysAgo = 0 } = {}) => pool.query(
    `INSERT INTO main_test_flakes (app_id, file, test, last_seen_at) VALUES ($1, $2, $3, now() - ($4::int * interval '1 day'))`,
    [a.id, x.file, x.test, daysAgo]);
  const script = (a, ...answers) => suite.scripts.set(a.id, answers);
  const ran = (a) => suite.calls.filter((c) => c.appId === a.id);

  const row = async (a) => (await pool.query(
    `SELECT main_check_state AS state, main_check_sha AS sha, main_check_at AS at, main_check_detail AS detail,
            main_check_paused_sha AS paused, main_check_resumed_sha AS resumed FROM apps WHERE id = $1`, [a.id])).rows[0];
  const inst = async (a) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, appKey(a.id)])).rows[0];
  const verdicts = async (a) => (await pool.query(
    'SELECT sha, state, superseded, confirmed, flake FROM main_watch_verdicts WHERE app_id = $1 ORDER BY id', [a.id]))
    .rows.map((r) => [r.sha, r.state, r.superseded, r.confirmed, r.flake]);
  const kicks = async (a) => (await pool.query(
    `SELECT payload->>'reason' AS reason FROM wf_events WHERE machine = 'merge-queue' AND key = $1 AND type = 'MergeWanted' ORDER BY id`,
    [appKey(a.id)])).rows.map((r) => r.reason);
  const pauses = async (a) => (await pool.query(
    `SELECT event_type, metadata FROM events WHERE app_id = $1 AND event_type IN ('main_paused', 'main_resumed') ORDER BY id`,
    [a.id])).rows.map((r) => [r.event_type, r.metadata]);
  const suiteWork = async (a) => (await pool.query(
    `SELECT work_key, input, status, attempt_count, lost_attempts, checkpoint FROM wf_work
      WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at`, [MACHINE, appKey(a.id), WORK.suite])).rows;
  const filedFor = (a) => filings.filter((f) => f.appId === a.id);
  const fixedFor = (a) => fixes.filter((f) => f.appId === a.id);
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try { await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT'); } finally { cl.release(); }
  };

  // The real handlers, their retries made immediate and the suite's tries
  // two, so a run that fails for good fails within the test.
  const real = mainCheckServices({ config: {}, pool });
  const services = Object.fromEntries(Object.entries(real).map(([k, h]) => [k, { ...h, backoffMs: () => 0, maxAttempts: 2 }]));
  function runtimeWith(deps = {}) {
    const rt = createRuntime({ pool, machines: [mainCheck({ ...DEFAULTS, ...deps })], services, pollMs: 50, publish: async () => {} });
    runtimes.push(rt);
    return rt;
  }
  const rt = runtimeWith();

  let rk = 0;
  const system = { kind: 'system', name: 'new-main' };
  const route = { kind: 'route', name: 'main-check-resume' };
  const outcome = async (id) => {
    const { rows: [e] } = await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id]);
    return { status: e.result, reason: e.reason, reply: e.reply };
  };
  const send = async (r, a, type, payload = {}, source = system, key = appKey(a.id)) => {
    const id = await r.append(MACHINE, key, { type, payload: { appId: a.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: a.id });
    await r.drain();
    return outcome(id);
  };
  const ask = (r, a, sha, more = {}) => send(r, a, 'CheckRequested', { sha, sessionId: 3, prNumber: 41, ...more });
  // One round: the work queued now runs, and what it reported is applied.
  const round = async (r = rt) => { await r.drain(); const n = await r.runServices(); await r.drain(); return n; };
  const settle = async (r = rt) => {
    for (let i = 0; i < 40; i++) if (!(await round(r))) return;
    assert.fail('the work never settled');
  };
  // The instance's deadline, made due and fired as the kernel's timer loop does.
  const fire = async (r, a) => {
    await asTransition((cl) => cl.query(
      'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2 AND deadline_at IS NOT NULL', [MACHINE, appKey(a.id)]));
    assert.ok((await r.fireTimers()) >= 1, 'a deadline was due');
    await r.drain();
  };
  const deadlineAfter = async (a) => {
    const [i, r] = [await inst(a), await row(a)];
    return i.deadline_at ? i.deadline_at.getTime() - r.at.getTime() : null;
  };

  await t.test('a green first run is passing, pauses nothing and tells nobody', async () => {
    const a = await app();
    script(a, green);
    const out = await ask(rt, a, S1);
    assert.equal(out.status, 'accepted');
    assert.deepEqual(out.reply, { state: 'running', pausedSha: null });
    let r = await row(a);
    assert.deepEqual([r.state, r.sha, r.detail, r.paused], ['running', S1, { prNumber: 41, sessionId: 3 }, null],
      'the board reads "checking the last merge" from the row at once');
    assert.deepEqual((await suiteWork(a)).map((w) => w.input), [{ appId: a.id, sha: S1, phase: 'first', reuse: true }],
      'a first run on an unpaused main may copy a pass of its tree');
    await settle();
    assert.deepEqual(ran(a), [{ appId: a.id, slug: a.slug, sha: S1, resumeRunId: null }], 'green needs no second opinion');
    assert.deepEqual(suite.reuse.at(-1), [S1, true], 'and the work passes that on to the run');
    r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.prNumber, r.detail.summary.pass], ['passing', null, 41, 40]);
    assert.deepEqual(await verdicts(a), [[S1, 'passing', false, null, false]]);
    assert.deepEqual(await kicks(a), [], 'nothing waited: no kick');
    assert.deepEqual(await pauses(a), []);
    assert.deepEqual([filedFor(a), fixedFor(a)], [[], []]);
    const i = await inst(a);
    assert.deepEqual([i.state, i.deadline_at], ['idle', null]);
  });

  await t.test('the claim: a commit is checked once, again only after a run that could not happen', async () => {
    const a = await app();
    script(a, green);
    assert.equal((await ask(rt, a, S1)).status, 'accepted');
    assert.deepEqual(await ask(rt, a, S1), { status: 'rejected', reason: 'already_checked', reply: null }, 'a run under way is not doubled');
    await settle();
    assert.equal((await ask(rt, a, S1.toUpperCase())).reason, 'already_checked', 'nor a verdict asked again, in any case');
    assert.equal(ran(a).length, 1);

    // A run that could not happen leaves the commit to be asked again.
    const b = await app();
    script(b, cannot('quota'), green);
    await ask(rt, b, S1);
    await settle();
    assert.equal((await row(b)).state, 'error');
    assert.equal((await ask(rt, b, S1)).status, 'accepted');
    await settle();
    assert.equal((await row(b)).state, 'passing');
    assert.equal(ran(b).length, 2);

    // Nothing runs without a repository, an app, the instance's own key, a
    // commit sha, a producer, or the switch on.
    const bare = await app({ repo: false });
    assert.equal((await ask(rt, bare, S1)).reason, 'no_repo');
    assert.equal((await send(rt, { id: 999999 }, 'CheckRequested', { sha: S1 })).reason, 'no_app');
    assert.equal((await send(rt, a, 'CheckRequested', { sha: S2 }, system, appKey(b.id))).reason, 'key_mismatch');
    await assert.rejects(rt.append(mainCheck(), appKey(a.id), { type: 'CheckRequested', payload: { appId: a.id, sha: 'abc' } },
      { requestKey: `t-${++rk}`, source: system }), /40-character commit sha/);
    assert.equal((await send(rt, a, 'CheckRequested', { sha: S2 }, { kind: 'timer' })).reason, 'not_a_producer');
    const off = runtimeWith({ enabled: false });
    assert.equal((await send(off, a, 'CheckRequested', { sha: S2 })).reason, 'off');
    assert.equal(ran(a).length + ran(bare).length, 1);
  });

  await t.test('a first red is provisional: merges pause, the suite runs again, and red again is confirmed and sent to be fixed', async () => {
    const a = await app();
    const long = { ...REAL, excerpt: 'x'.repeat(2000) };
    script(a, redOn([REAL], { excerpts: [long] }), redOn([REAL]));
    await ask(rt, a, S1);
    await round();
    let r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirming, r.detail.prNumber, r.detail.failureReason],
      ['confirming', S1, true, 41, redOn([REAL]).detail.failureReason], 'held: the banner says "re-running to confirm"');
    assert.equal((await inst(a)).state, 'confirming');
    assert.deepEqual(await pauses(a), [['main_paused', { sha: S1, confirming: true }]]);
    assert.deepEqual((await suiteWork(a)).map((w) => [w.work_key, w.input.phase, w.input.reuse]), [['suite:1', 'first', true], ['suite:2', 'confirm', false]],
      'a confirmation asks whether the red is real: it runs the suite');
    assert.deepEqual(await verdicts(a), [], 'a provisional red is no verdict');
    await settle();
    assert.deepEqual(ran(a).map((c) => c.sha), [S1, S1], 'on the same commit');
    r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.firstRun.failureReason],
      ['failing', S1, true, redOn([REAL]).detail.failureReason]);
    assert.deepEqual(await verdicts(a), [[S1, 'failing', false, true, false]]);
    assert.deepEqual(await kicks(a), [], 'red kicks nothing');
    assert.deepEqual(await pauses(a), [['main_paused', { sha: S1, confirming: true }]], 'one pause, still on');
    const [fix] = fixedFor(a);
    assert.deepEqual([fix.redSha, fix.prNumber, fix.parsed, fix.detail], [S1, 41, { owner: 'acme', repo: a.slug }, accountOf(redOn([REAL]))]);
    assert.equal(fix.fileBotIssue, fileBotIssue);
    assert.equal(fix.excerpts.length, 1, 'the confirming run printed nothing: the first run\'s output is sent');
    assert.equal(fix.excerpts[0].excerpt.length, 1500, 'each excerpt kept short (services.ts)');
    assert.equal(await deadlineAfter(a), DEFAULTS.recheckMs, 'a confirmed red is asked again after a quarter hour');
    assert.equal((await inst(a)).deadline_event.type, 'RecheckDue');
  });

  await t.test('red then green is a flake: passing, the pause lifts, the queue goes, the flake is noted', async () => {
    const a = await app();
    const excerpt = { ...FLAKY, excerpt: 'expected 12:01, got 12:00' };
    script(a, redOn([FLAKY], { excerpts: [excerpt] }), green);
    await ask(rt, a, S1);
    await settle();
    const r = await row(a);
    assert.deepEqual([r.state, r.paused], ['passing', null]);
    assert.deepEqual(r.detail.flake, redOn([FLAKY]).detail, 'the failure that did not repeat is kept');
    assert.deepEqual(await pauses(a), [['main_paused', { sha: S1, confirming: true }], ['main_resumed', { sha: S1, by: 'green' }]]);
    assert.deepEqual(await kicks(a), ['main-post-flake'], 'whatever waited out the re-run can go');
    assert.deepEqual(filedFor(a), [{ mode: 'note', appId: a.id, sha: S1, reds: [redOn([FLAKY]).detail], excerpts: [excerpt] }]);
    assert.deepEqual(await verdicts(a), [[S1, 'passing', false, null, true]]);
    assert.deepEqual(fixedFor(a), []);
  });

  await t.test('two reds on one commit with no test in common are flakes; two that share one pause as always', async () => {
    const a = await app();
    script(a, redOn([DB]), redOn([PUSH]));
    await ask(rt, a, S1);
    await settle();
    let r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.disjoint, r.detail.flakesOnly],
      ['failing', null, true, true, [DB.test, PUSH.test]]);
    assert.deepEqual(await kicks(a), ['main-post-flake']);
    assert.deepEqual((await pauses(a)).map(([type, m]) => [type, m.by]), [['main_paused', undefined], ['main_resumed', 'flakes']]);
    const [note] = filedFor(a);
    assert.deepEqual([note.mode, note.reds.map((x) => x.failingTests)], ['note', [[DB], [PUSH]]]);
    assert.deepEqual(await verdicts(a), [[S1, 'failing', false, true, true]]);
    assert.deepEqual(fixedFor(a), [], 'flakes are not a broken main');

    const b = await app();
    script(b, redOn([DB, REAL]), redOn([REAL]));
    await ask(rt, b, S1);
    await settle();
    r = await row(b);
    assert.deepEqual([r.state, r.paused, r.detail.disjoint], ['failing', S1, undefined]);
    assert.equal(fixedFor(b).length, 1);
  });

  await t.test('a re-run that could not happen leaves the first red standing, unconfirmed, and asked again within minutes', async () => {
    const a = await app();
    script(a, redOn([REAL]), cannot('quota'));
    await ask(rt, a, S1);
    await settle();
    const r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.confirmation, r.detail.failureReason],
      ['failing', S1, false, { failureReason: 'quota' }, redOn([REAL]).detail.failureReason]);
    assert.deepEqual(await verdicts(a), [[S1, 'failing', false, false, false]]);
    assert.deepEqual([await kicks(a), fixedFor(a)], [[], []]);
    assert.equal(await deadlineAfter(a), DEFAULTS.confirmRetryMs);
  });

  await t.test('MAIN_WATCH_CONFIRM off: the first red is taken at its word; one of known flakes still pauses nothing', async () => {
    const once = runtimeWith({ confirm: false });
    const a = await app();
    script(a, redOn([REAL]));
    await ask(once, a, S1);
    await settle(once);
    const r = await row(a);
    assert.equal(ran(a).length, 1, 'no re-run');
    assert.deepEqual([r.state, r.paused, r.detail.confirmed], ['failing', S1, undefined]);
    assert.deepEqual(await pauses(a), [['main_paused', { sha: S1, confirming: false }]]);
    assert.deepEqual(fixedFor(a), [], 'only a confirmed red is sent to be fixed');

    const b = await app();
    await knownFlake(b, FLAKY);
    script(b, redOn([FLAKY]));
    await ask(once, b, S1);
    await settle(once);
    const rb = await row(b);
    assert.deepEqual([rb.state, rb.paused, rb.detail.flakesOnly], ['failing', null, [FLAKY.test]]);
    assert.deepEqual(await pauses(b), []);
    assert.deepEqual(filedFor(b), [{ mode: 'request', appId: b.id, sha: S1, tests: [FLAKY], excerpts: [] }]);
  });

  await t.test('a red of known flakes alone pauses nothing, even confirmed; with one other test, or not named in full, it pauses', async () => {
    const a = await app();
    await knownFlake(a, FLAKY);
    await knownFlake(a, OTHER);
    script(a, redOn([FLAKY]), redOn([FLAKY, OTHER]));
    await ask(rt, a, S1);
    await round();
    let r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.flakesOnly], ['confirming', null, [FLAKY.test]], 'the hold holds nothing');
    await settle();
    r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.flakesOnly], ['failing', null, true, [FLAKY.test, OTHER.test]]);
    assert.deepEqual(await pauses(a), []);
    assert.deepEqual(filedFor(a).map((f) => [f.mode, f.tests]), [['request', [FLAKY, OTHER]]], 'a request for each, so someone fixes them');
    assert.deepEqual(fixedFor(a), []);

    for (const [why, answer, flakeAge] of [
      ['a known flake plus one other test', redOn([FLAKY, REAL]), 0],
      ['a list that did not name every failure', redOn([FLAKY], { complete: false }), 0],
      ['a flake not seen for a month', redOn([FLAKY]), 31],
    ]) {
      const b = await app();
      await knownFlake(b, FLAKY, { daysAgo: flakeAge });
      script(b, answer, answer);
      await ask(rt, b, S1);
      await settle();
      const rb = await row(b);
      assert.deepEqual([rb.paused, rb.detail.flakesOnly], [S1, undefined], why);
    }
  });

  await t.test('a run that fails for good is an error verdict that leaves the pause; the green after it lifts it and lets the queue go', async () => {
    const a = await app();
    script(a, redOn([REAL]), redOn([REAL]), new Error('docker daemon unreachable'), new Error('docker daemon unreachable'), green);
    await ask(rt, a, S1);
    await settle();
    assert.equal((await row(a)).paused, S1);
    await ask(rt, a, S2, { prNumber: 42 });
    assert.deepEqual((await suiteWork(a)).filter((w) => w.input.sha === S2).map((w) => [w.input.phase, w.input.reuse]), [['first', false]],
      'a merge on a paused main is the one that re-tests it: it runs the suite');
    await settle();
    let r = await row(a);
    assert.equal(ran(a).filter((c) => c.sha === S2).length, 2, 'tried twice, then given up');
    assert.deepEqual(suite.reuse.filter(([sha]) => sha === S2).map(([, reuse]) => reuse), [false, false]);
    assert.deepEqual([r.state, r.sha, r.paused], ['error', S2, S1], 'a run that says nothing about main cannot lift a pause');
    assert.match(r.detail.failureReason, /docker daemon unreachable/);
    assert.equal((await inst(a)).deadline_at, null, 'and its commit is no paused red to ask again');
    assert.deepEqual(await kicks(a), []);
    await ask(rt, a, S3);
    await settle();
    r = await row(a);
    assert.deepEqual([r.state, r.paused], ['passing', null]);
    assert.deepEqual(await kicks(a), ['main-post-green'], 'green after a pause the state no longer showed');
    assert.deepEqual((await pauses(a)).at(-1), ['main_resumed', { sha: S3, by: 'green' }]);
    assert.deepEqual((await verdicts(a)).map(([sha, state]) => [sha, state]), [[S1, 'failing'], [S2, 'error'], [S3, 'passing']]);
  });

  await t.test('a newer commit while a run is under way gets its own first run; the older verdict is recorded superseded only', async () => {
    // The two runs go at once, so each answers for its commit, and the
    // verdicts are compared in commit order.
    const bySha = (answers) => (args) => answers.get(args.sha);
    const byCommit = (rows) => [...rows].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    // The first run superseded.
    const a = await app();
    const first = bySha(new Map([[S1, redOn([REAL])], [S2, green]]));
    script(a, first, first);
    await ask(rt, a, S1);
    assert.deepEqual((await ask(rt, a, S2)).reply, { state: 'running', pausedSha: null });
    assert.equal((await row(a)).sha, S2, 'the row is the newer commit\'s at once');
    await settle();
    let r = await row(a);
    assert.deepEqual([r.state, r.sha, r.paused], ['passing', S2, null], 'the older red changed nothing');
    assert.equal(ran(a).length, 2, 'a superseded first red is not worth a second run');
    assert.deepEqual(byCommit(await verdicts(a)), [[S1, 'failing', true, false, false], [S2, 'passing', false, null, false]],
      'kept: a later red\'s suspects are read from them');
    assert.deepEqual((await inst(a)).data.older, []);

    // The confirmation superseded.
    const b = await app();
    const confirm = bySha(new Map([[S1, redOn([REAL])], [S2, green]]));
    script(b, confirm, confirm, confirm);
    await ask(rt, b, S1);
    await round();
    assert.equal((await row(b)).state, 'confirming');
    await ask(rt, b, S2);
    await settle();
    r = await row(b);
    assert.deepEqual([r.state, r.sha, r.paused], ['passing', S2, null]);
    assert.deepEqual(byCommit(await verdicts(b)), [[S1, 'failing', true, true, false], [S2, 'passing', false, null, false]],
      'a red again is kept confirmed, as the run would have stored it');
    assert.deepEqual(fixedFor(b), [], 'a superseded red is sent to nobody');
    assert.deepEqual(await kicks(b), ['main-post-green'], 'the green lifts the hold the confirmation had');
  });

  // Review round 2 (2026-10-17).
  await t.test('review: superseded greens are flakes, flakes are read on a failed confirmation, a deleted app faults nothing, the switch holds', async () => {
    const bySha = (answers) => (args) => answers.get(args.sha);
    // A confirmation green after a newer commit took the row: a flake.
    const a = await app();
    const confirm = bySha(new Map([[S1, null], [S2, green]]));
    script(a, redOn([REAL]), confirm, confirm);
    suite.scripts.set(a.id, [redOn([REAL]), () => green, () => green]);
    await ask(rt, a, S1);
    await round();
    assert.equal((await row(a)).state, 'confirming');
    await ask(rt, a, S2);
    await settle();
    assert.deepEqual((await verdicts(a)).filter(([sha]) => sha === S1).map(([, state, sup, conf, flake]) => [state, sup, conf, flake]),
      [['passing', true, null, true]], 'red then green on that commit: a flake, though superseded');

    // A confirmation that fails for good stands the first red: one of known
    // flakes alone still pauses nothing (the flakes are read for every result).
    const b = await app();
    await knownFlake(b, FLAKY);
    script(b, redOn([FLAKY]), new Error('docker daemon unreachable'), new Error('docker daemon unreachable'));
    await ask(rt, b, S1);
    await settle();
    let r = await row(b);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.flakesOnly], ['failing', null, false, [FLAKY.test]]);

    // An app deleted while its run is under way: the verdict has nowhere to
    // go, and the instance is not faulted for it.
    const c = await app();
    let release;
    script(c, () => new Promise((resolve) => { release = () => resolve(green); }));
    await ask(rt, c, S1);
    const running = (async () => { await round(); })();
    for (let i = 0; i < 100 && !release; i += 1) await new Promise((res) => setTimeout(res, 20));
    await pool.query('DELETE FROM apps WHERE id = $1', [c.id]);
    release();
    await running;
    await settle();
    assert.equal((await inst(c)).flag, null, 'not faulted');

    // An admin's Resume names the commit it resumed, while a newer one runs.
    const f = await app();
    script(f, redOn([REAL]), redOn([REAL]), green);
    await ask(rt, f, S1);
    await settle();
    await ask(rt, f, S2);
    await send(rt, f, 'Resume', {}, route);
    assert.deepEqual((await pauses(f)).at(-1), ['main_resumed', { sha: S1, by: 'admin' }]);
    await settle();
  });

  await t.test('Resume lifts the pause, remembers its commit, clears the recheck and lets the queue go', async () => {
    const a = await app();
    script(a, redOn([REAL]), redOn([REAL]));
    await ask(rt, a, S1);
    await settle();
    assert.ok((await inst(a)).deadline_at);
    assert.equal((await send(rt, a, 'Resume', { by: 'evan' })).reason, 'admin_only', 'a producer cannot resume');
    const out = await send(rt, a, 'Resume', { by: 'evan' }, route);
    assert.deepEqual(out, { status: 'accepted', reason: null, reply: { state: 'idle', pausedSha: null } });
    const r = await row(a);
    assert.deepEqual([r.state, r.paused, r.resumed], ['failing', null, S1]);
    assert.deepEqual(await kicks(a), ['main-post-resume']);
    assert.deepEqual((await pauses(a)).at(-1), ['main_resumed', { sha: S1, by: 'admin' }]);
    assert.equal((await inst(a)).deadline_at, null);
    assert.equal((await send(rt, a, 'Resume', {}, route)).reason, 'not_paused');

    // During the confirmation: the red still in flight for this commit
    // cannot pause again.
    const b = await app();
    script(b, redOn([REAL]), redOn([REAL]));
    await ask(rt, b, S1);
    await round();
    assert.equal((await send(rt, b, 'Resume', {}, route)).reply.state, 'confirming');
    await settle();
    const rb = await row(b);
    assert.deepEqual([rb.state, rb.detail.confirmed, rb.paused, rb.resumed], ['failing', true, null, S1]);
    assert.equal((await inst(b)).deadline_at, null, 'nothing paused, nothing to ask again');
    assert.deepEqual((await pauses(b)).map(([type]) => type), ['main_paused', 'main_resumed']);

    // A pause no instance holds (none in production): Resume lifts it.
    const c = await app();
    await seed(c, { state: 'failing', paused: S1, detail: { confirmed: true } });
    assert.equal((await send(rt, c, 'Resume', {}, route)).status, 'accepted');
    const rc = await row(c);
    assert.deepEqual([rc.paused, rc.resumed, (await inst(c)).state], [null, S1, 'idle']);
    assert.deepEqual(await kicks(c), ['main-post-resume']);
  });

  await t.test('a paused red is asked again at its deadline: green lifts it as a flake', async () => {
    const r2 = runtimeWith({ maxRechecks: 2 });
    const a = await app();
    script(a, redOn([FLAKY]), redOn([FLAKY]), green);
    await ask(r2, a, S1);
    await settle(r2);
    assert.equal((await send(r2, a, 'RecheckDue', {}, system)).reason, 'timer_only');
    await fire(r2, a);
    let r = await row(a);
    assert.equal((await inst(a)).state, 'rechecking');
    assert.equal(r.detail.rechecks, 1);
    assert.ok(r.detail.recheckingAt, 'in flight, on the row');
    assert.equal((await send(r2, a, 'RecheckDue', {}, { kind: 'timer' })).reason, 'under_way');
    assert.equal((await suiteWork(a)).at(-1).input.phase, 'recheck');
    assert.equal((await suiteWork(a)).at(-1).input.reuse, false, 'a recheck of a paused red runs the suite');
    await settle(r2);
    r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.rechecks, r.detail.prNumber, r.detail.recheckingAt],
      ['passing', null, 1, 41, undefined], 'the verdict replaces the in-flight mark');
    assert.deepEqual(r.detail.flake, accountOf(redOn([FLAKY])));
    assert.deepEqual(await kicks(a), ['main-post-recheck']);
    const note = filedFor(a).at(-1);
    assert.deepEqual([note.mode, note.reds.length], ['note', 2], 'the red and the first run it confirmed');
    assert.deepEqual((await verdicts(a)).at(-1), [S1, 'passing', false, null, true]);
    assert.equal((await send(r2, a, 'RecheckDue', {}, { kind: 'timer' })).reason, 'not_due');
  });

  await t.test('a recheck red again stands, confirmed, counted, until the rechecks run out', async () => {
    const r2 = runtimeWith({ maxRechecks: 2 });
    const a = await app();
    script(a, redOn([FLAKY]), redOn([FLAKY]), redOn([FLAKY, REAL]), redOn([FLAKY]));
    await ask(r2, a, S1);
    await settle(r2);
    await fire(r2, a);
    await settle(r2);
    let r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.rechecks, r.detail.failingTests, r.detail.firstRun.failingTests],
      ['failing', S1, true, 1, [FLAKY, REAL], [FLAKY]], 'with the red it asked about');
    assert.deepEqual(await kicks(a), []);
    assert.equal(await deadlineAfter(a), DEFAULTS.recheckMs);
    await fire(r2, a);
    await settle(r2);
    r = await row(a);
    assert.equal(r.detail.rechecks, 2);
    assert.equal((await inst(a)).deadline_at, null, 'at most maxRechecks');
    assert.equal((await verdicts(a)).length, 3, 'each recheck is a verdict');

    // None at all with the rechecks off.
    const none = runtimeWith({ maxRechecks: 0 });
    const b = await app();
    script(b, redOn([REAL]), redOn([REAL]));
    await ask(none, b, S1);
    await settle(none);
    assert.deepEqual([(await row(b)).paused, (await inst(b)).deadline_at], [S1, null]);
  });

  await t.test('a recheck that could not happen leaves the red as it was, one recheck spent, and tries again soon', async () => {
    const a = await app();
    script(a, redOn([REAL]), cannot('quota'), cannot('quota again'));
    await ask(rt, a, S1);
    await settle();
    await fire(rt, a);
    await settle();
    const r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.confirmed, r.detail.rechecks, r.detail.recheckError, r.detail.recheckingAt],
      ['failing', S1, false, 1, { failureReason: 'quota again' }, undefined]);
    assert.equal(r.detail.failureReason, redOn([REAL]).detail.failureReason);
    assert.equal(await deadlineAfter(a), DEFAULTS.confirmRetryMs, 'still unconfirmed, so the next try comes soon');
    assert.equal((await verdicts(a)).length, 1, 'a run that could not happen is no verdict');
  });

  await t.test('a recheck whose tests pass, with others failing instead, lifts the pause as flakes', async () => {
    const a = await app();
    script(a, redOn([FLAKY]), redOn([FLAKY]), redOn([PUSH]));
    await ask(rt, a, S1);
    await settle();
    await fire(rt, a);
    await settle();
    const r = await row(a);
    assert.deepEqual([r.state, r.paused, r.detail.disjoint, r.detail.flakesOnly], ['failing', null, true, [FLAKY.test, PUSH.test]]);
    assert.deepEqual(await kicks(a), ['main-post-recheck']);
    assert.deepEqual(filedFor(a).at(-1).reds.map((x) => x.failingTests), [[FLAKY], [PUSH]]);
  });

  await t.test('no row is adopted: the machine has no Adopted, and a Resume of a row no instance holds only lifts its pause', async () => {
    const m = mainCheck();
    assert.equal(m.events.has('Adopted'), false);
    assert.equal(m.create.has('Adopted'), false);
    const a = await app();
    await seed(a, { state: 'confirming', paused: S1, detail: { prNumber: 41, sessionId: 3, confirming: true, ...redOn([FLAKY]).detail } });
    assert.equal((await send(rt, a, 'Resume', {}, route)).status, 'accepted');
    assert.equal((await inst(a)).state, 'idle', 'no run is carried on from the row');
    assert.deepEqual(await suiteWork(a), []);
    assert.deepEqual([(await row(a)).paused, (await row(a)).resumed], [null, S1]);
  });


  await t.test('the guard: once the instance holds the app, nothing else writes its main_check_* columns', async () => {
    const a = await app();
    await seed(a, { state: 'passing' });
    script(a, green);
    await ask(rt, a, S2);
    await settle();
    for (const sql of [`main_check_state = 'failing'`, `main_check_paused_sha = '${S2}'`, `main_check_detail = '{}'::jsonb`,
      'main_check_at = now()', `main_check_resumed_sha = '${S2}'`, `main_check_sha = '${S3}'`]) {
      await assert.rejects(pool.query(`UPDATE apps SET ${sql} WHERE id = $1`, [a.id]), /WF_OWNERSHIP_VIOLATION/, sql);
    }
    await pool.query(`UPDATE apps SET name = 'renamed' WHERE id = $1`, [a.id]);
    assert.equal((await row(a)).state, 'passing');
  });

  // A release restarts the platform while main's suite runs. The old
  // merge-followups `main.check` item ran afterMerge to its end inside one
  // process: a process gone mid-suite left the row at 'running' and the
  // item, retried, found the commit claimed and ended `{ state: null }`,
  // with no verdict coming until the leader's re-drive. Now the suite is the
  // machine's resumable work: the run id is checkpointed before the Jobs
  // exist, and the next attempt carries the run on (main-watch adopts its
  // Jobs) to a verdict, without spending one of its tries.
  await t.test('a process lost mid-suite: the next attempt carries the run on from its checkpoint to a verdict', async () => {
    const a = await app();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    script(a, async (args) => { await args.onRunId('3b6e1c2a-run'); await held; return redOn([REAL]); }, green);
    const dying = runtimeWith();
    await ask(dying, a, S1);
    const lost = dying.runServices();
    for (let i = 0; i < 200 && !(await suiteWork(a))[0]?.checkpoint; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((await suiteWork(a))[0].checkpoint, { runId: '3b6e1c2a-run' }, 'the run named before its Jobs');
    // The process is gone: its lease lapses.
    await pool.query(`UPDATE wf_work SET lease_until = now() WHERE machine = $1 AND key = $2`, [MACHINE, appKey(a.id)]);
    const next = runtimeWith();
    assert.equal(await next.runServices(), 1);
    release();
    await lost;
    await settle(next);
    assert.deepEqual(ran(a).map((c) => c.resumeRunId), [null, '3b6e1c2a-run'], 'the next attempt adopts the run');
    const [w] = await suiteWork(a);
    assert.deepEqual([w.attempt_count, w.lost_attempts], [2, 1], 'the lost attempt is not one of its tries');
    const r = await row(a);
    assert.deepEqual([r.state, r.paused], ['passing', null], 'the dead attempt\'s late answer is not reported');
    assert.deepEqual(await verdicts(a), [[S1, 'passing', false, null, false]]);
  });
  await t.test('a process lost while filing the fix request: the next attempt claims in the same name and files it', async () => {
    const a = await app();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    script(a, redOn([REAL]), redOn([REAL]));
    let reached;
    const filing = new Promise((resolve) => { reached = resolve; });
    fixScripts.set(a.id, [async () => { reached(); await held; return 0; }, async () => 701]);
    const dying = runtimeWith();
    await ask(dying, a, S1);
    await round(dying); await round(dying);
    const fixWork = async () => (await pool.query(
      `SELECT status, result, attempt_count, lost_attempts, checkpoint FROM wf_work
        WHERE machine = $1 AND key = $2 AND kind = $3`, [MACHINE, appKey(a.id), WORK.fix])).rows;
    assert.equal((await fixWork()).length, 1, 'a confirmed red is sent to be fixed');
    const lost = dying.runServices();
    await filing;
    // The process is gone: its lease lapses.
    await pool.query(`UPDATE wf_work SET lease_until = now() WHERE machine = $1 AND key = $2 AND kind = $3`, [MACHINE, appKey(a.id), WORK.fix]);
    const next = runtimeWith();
    assert.equal(await next.runServices(), 1);
    release();
    await lost;
    await settle(next);
    const { rows: [{ id }] } = await pool.query('SELECT id FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3', [MACHINE, appKey(a.id), WORK.fix]);
    assert.deepEqual(fixedFor(a).map((f) => f.claimedBy), [id, id], 'both attempts claim in the work item\'s name');
    const [w] = await fixWork();
    assert.deepEqual([w.status, w.lost_attempts], ['settled', 1]);
    assert.match(JSON.stringify(w.result), /"issueNumber":701/, 'filed by the attempt that carried the claim on');
  });
});
