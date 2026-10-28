'use strict';

// Stacked imports against the full PostgreSQL schema (src/workflow/rules/
// pr-base.ts): "merged" means "in main". An imported pull request based on
// another open change's branch waits for that change, stays out of the merge
// queue, and once that change is on main is retargeted to main and synced
// with it; a merge GitHub reports into any other branch is never recorded as
// merged; a base that is neither main nor an open change's is refused at
// promotion. The app's merge queue and the proposal machine run; the work is
// fake (the real handlers are src/workflow/proposal/services.ts, and
// routes/votes.js attemptMerge, whose base check is tests/merge-attempt.test.js).
//
// The 28 Oct 2026 incident these pin: a stack of three (#5955 ← #5956 ←
// #5957) was merged from Homeroom. #5957, based on #5956's branch, was
// merged into that branch and recorded merged; #5956 still targeted #5955's
// branch after #5955 landed, and its base had to be changed to main by hand.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-stacked-imports-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { proposal, sessionKey, MACHINE, WORK } = require('../src/workflow/proposal/machine.ts');
const { mergeQueue, MACHINE: QUEUE, appKey } = require('../src/workflow/merge-queue/machine.ts');
const { readLine } = require('../src/workflow/merge-queue/facts.ts');
const prBase = require('../src/workflow/rules/pr-base.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const DAY = 24 * 60 * 60 * 1000;
const DEPS = { idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 7 * DAY, staleGraceMs: 3 * DAY, shotsEnforced: false };

test('stacked imports against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_stacked_' + crypto.randomBytes(6).toString('hex');
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
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1'), ('enabled:merge-followups', '1'),
                    ('enabled:${QUEUE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`st_${++seq}`]);
    return u;
  }
  async function app(owner) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, 1) RETURNING *`,
      [`st-app-${++seq}`, owner.id]);
    return a;
  }
  // An import in review (or underway), its checks passed on its head,
  // measured clean; based on main (no other base) unless `on` names the
  // change under it or `base` another branch.
  async function imported({ appRow, owner, on = null, base = null, status = 'promoted', head = null } = {}) {
    const n = ++seq;
    const h = head || SHA(String(n % 10));
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, pr_title,
                                  imported_pr_head_sha, promoted_at, check_state, checks_commit_sha,
                                  integration_merges_clean, integration_head_sha, integration_main_sha,
                                  imported_pr_base_ref, waits_for_session_id, imported_pr_head_repo)
       VALUES ($1, $2, $3::text, 'imported', $4, $5, $6, $7,
               CASE WHEN $3::text = 'promoted' THEN NOW() - interval '1 day' END, 'passing', $7, TRUE, $7, $8, $9, $10,
               'acme/' || $11::text)
       RETURNING *`,
      [appRow.id, owner.id, status, `claude/stack-${n}`, 5900 + n, `Change ${n}`, h, SHA('e'),
        on ? on.branch_name : base, on ? on.id : null, appRow.slug]);
    return { ...s, app: appRow, owner };
  }
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const pInst = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const eventsOf = async (machine, key, type) => (await pool.query(
    `SELECT type, payload, source FROM wf_events WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR type = $3) ORDER BY id`,
    [machine, key, type || null])).rows;
  const lines = async (s) => (await pool.query(
    `SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`, [s.id])).rows.map((r) => r.content);
  const asTransition = async (fn) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
  };
  const vote = async (s) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
     SELECT $1, $2, 'yes', cs.approval_epoch FROM chat_sessions cs WHERE cs.id = $1`, [s.id, (await user()).id]);
  // merge-followups' move into merged, then its message.
  const landed = async (s) => {
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [s.id]));
    await toProposal(s, 'Merged', {}, fromMerge);
    await settle();
  };

  // Fake work: each call recorded; `answer` per kind; `hold` keeps an item
  // running.
  const work = { calls: [], answer: new Map(), hold: new Map() };
  const fake = (kind, extra = {}) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, ...extra,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (work.hold.has(kind)) await work.hold.get(kind);
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input) : (a ?? { ok: true });
    },
  });
  const ready = (r) => ({ ready: true, head: r.imported_pr_head_sha, epoch: Number(r.approval_epoch),
    explicitApproval: false, explicitReason: null, mainPassThrough: false, tally: { yes: 1, required: 1, active: 1 } });
  const defaults = () => {
    work.calls.length = 0;
    work.hold.clear();
    work.answer.clear();
    work.answer.set(WORK.gate, async (input) => ready((await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId])).rows[0]));
    // Into main: attemptMerge names no other base.
    work.answer.set(WORK.attempt, { outcome: 'merged', sha: SHA('9') });
    work.answer.set(WORK.sync, { outcome: 'clean', sha: SHA('5'), message: 'Merged main cleanly.' });
    work.answer.set(WORK.retarget, { base: 'main' });
    work.answer.set(WORK.open, () => ({ head: SHA('1'), prNumber: 5999, prUrl: null, prTitle: 'x' }));
  };
  defaults();
  const pm = proposal(DEPS);
  const qm = mergeQueue();
  const rt = createRuntime({ pool, machines: [pm, qm], pollMs: 50, publish: async () => {},
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])) });
  runtimes.push(rt);

  let rk = 0;
  const system = { kind: 'system' };
  const route = { kind: 'route' };
  const fromQueue = { kind: 'message', from: { machine: QUEUE, key: 'x', eventId: 1 } };
  const fromMerge = { kind: 'message', from: { machine: 'merge-followups', key: 'x', eventId: 1 } };
  const toProposal = (s, type, payload = {}, source = system) => rt.append(pm, sessionKey(s.id),
    { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const want = (a) => rt.append(qm, appKey(a.id),
    { type: 'MergeWanted', payload: { appId: a.id, reason: 'test' } }, { requestKey: `w-${++rk}`, source: system, appId: a.id });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after FROM wf_events WHERE id = $1', [id])).rows[0];
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  const callsFor = (kind, s) => calls(kind).filter((c) => Number(c.input.sessionId) === s.id);
  const stack = async () => {
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    const C = await imported({ appRow: a, owner, on: B });
    for (const s of [A, B, C]) await vote(s);
    return { a, owner, A, B, C };
  };

  // ── Waiting ─────────────────────────────────────────────────────────

  await t.test('S1 a stacked import is not in the merge queue\'s line: only the change at the bottom of a stack of three is merged', async () => {
    defaults();
    const { a, A, B, C } = await stack();
    const line = await readLine(pool, a.id, new Date());
    assert.deepEqual(line.map((c) => c.id), [A.id], 'B and C wait for the change under them');
    await want(a);
    await settle();
    assert.deepEqual(calls(WORK.gate).map((c) => Number(c.input.sessionId)), [A.id], 'only A is measured');
    assert.deepEqual(calls(WORK.attempt).map((c) => Number(c.input.sessionId)), [A.id], 'only A is asked of GitHub');
    assert.equal((await eventsOf('merge-followups', sessionKey(A.id), 'Merged')).length, 1);
    for (const s of [B, C]) {
      assert.equal((await row(s)).status, 'promoted', 'still in review, waiting');
      assert.equal((await eventsOf('merge-followups', sessionKey(s.id), 'Merged')).length, 0);
    }
  });

  await t.test('S2 the child asked anyway (a stale line, a force) is declined without being measured', async () => {
    defaults();
    const { A, C } = await stack();
    const owner = await user();
    const lone = await imported({ appRow: A.app, owner, base: 'someone/else' });
    for (const s of [C, lone]) {
      await toProposal(s, 'Adopted');
      await toProposal(s, 'ForceMerge', { from: 'promoted', username: 'admin' }, route);
    }
    const asked = await toProposal(C, 'MergeRequested', { queueN: 7, force: true }, fromQueue);
    const askedLone = await toProposal(lone, 'MergeRequested', { queueN: 8, force: true }, fromQueue);
    await settle();
    assert.equal((await outcome(asked)).result, 'accepted');
    assert.equal(callsFor(WORK.gate, C).length + callsFor(WORK.gate, lone).length, 0, 'neither is measured');
    const ends = (await eventsOf(QUEUE, appKey(A.app.id), 'AttemptEnded')).map((e) => [e.payload.sessionId, e.payload.n, e.payload.reason]);
    assert.ok(ends.some(([id, n, reason]) => id === C.id && n === 7 && reason === 'waits_for_parent'), 'the queue hears it waits for its parent');
    assert.ok(ends.some(([id, n, reason]) => id === lone.id && n === 8 && reason === 'base_not_main'), 'and that the other is based on no change');
    assert.equal(callsFor(WORK.attempt, C).length + callsFor(WORK.attempt, lone).length, 0, 'a force does not reach past it');
    void askedLone;
  });

  await t.test('S3 a gate found ready is not claimed once the row says it is stacked', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const parent = await imported({ appRow: a, owner, status: 'active' });
    const s = await imported({ appRow: a, owner });
    await vote(s);
    let release;
    work.hold.set(WORK.gate, new Promise((r) => { release = r; }));
    await want(a);
    const run = settle();
    for (let i = 0; i < 200 && !callsFor(WORK.gate, s).length; i++) await new Promise((r) => setTimeout(r, 10));
    // A look read its base meanwhile: it is stacked on the parent's branch.
    await prBase.recordBase(pool, { sessionId: s.id, appId: a.id, base: parent.branch_name });
    release();
    await run;
    await settle();
    assert.equal(calls(WORK.attempt).length, 0, 'never asked GitHub');
    assert.equal((await pInst(s)).state, 'in_review');
    const ended = (await eventsOf(QUEUE, appKey(a.id), 'AttemptEnded')).map((e) => e.payload.reason);
    assert.ok(ended.includes('waits_for_parent'));
    assert.equal((await row(s)).waits_for_session_id, parent.id);
  });

  // ── Merged means in main ────────────────────────────────────────────

  await t.test('S4 a merge GitHub reports into another branch closes the proposal as merged elsewhere: never merged, never live', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const s = await imported({ appRow: a, owner });
    await vote(s);
    // Its base moved after the attempt read it: GitHub merged it there.
    work.answer.set(WORK.attempt, { outcome: 'merged', sha: SHA('9'), base: 'claude/somewhere' });
    await want(a);
    await settle();
    assert.equal(calls(WORK.attempt).length, 1);
    assert.equal((await pInst(s)).state, 'closed');
    assert.equal((await pInst(s)).data.reason, 'merged-elsewhere');
    assert.equal((await row(s)).status, 'archived');
    assert.equal((await eventsOf('merge-followups', sessionKey(s.id), 'Merged')).length, 0, 'merge-followups never hears it');
    assert.ok((await lines(s)).some((l) => /merged on GitHub into claude\/somewhere, not into main, so it is not recorded as merged/.test(l)));
    assert.equal(calls(WORK.close).length, 0, 'its pull request is GitHub\'s already: nothing is closed there');
  });

  await t.test('S5 a child merged on GitHub before its parent (28 Oct, #5957 into #5956\'s branch) is closed as merged elsewhere, and its parent keeps waiting for its own vote', async () => {
    defaults();
    const { A, B, C } = await stack();
    for (const s of [A, B, C]) await toProposal(s, 'Adopted');
    await settle();
    const looked = await toProposal(C, 'PrLooked', { from: 'promoted', merged: true, closed: true, baseRead: true, mergeSha: SHA('7'),
      mergedAt: '2026-10-28T17:31:27Z', closedAt: '2026-10-28T17:31:27Z', base: B.branch_name });
    await settle();
    assert.equal((await outcome(looked)).result, 'accepted');
    assert.equal((await pInst(C)).state, 'closed');
    assert.equal((await pInst(C)).data.reason, 'merged-elsewhere');
    assert.notEqual((await row(C)).status, 'merged', 'never recorded as merged (11569 was)');
    assert.equal((await eventsOf('merge-followups', sessionKey(C.id), 'Merged')).length, 0);
    assert.equal((await row(B)).status, 'promoted', 'B still waits for A');
    assert.equal((await eventsOf(MACHINE, sessionKey(B.id), 'ParentMerged')).length, 0, 'nothing reached main, so nothing moves');
    // The same merge seen while it is underway closes it the same way.
    const owner = await user();
    const early = await imported({ appRow: A.app, owner, on: A, status: 'active' });
    await toProposal(early, 'PrLooked', { from: 'active', merged: true, closed: true, baseRead: true, base: A.branch_name });
    await settle();
    assert.equal((await pInst(early)).data.reason, 'merged-elsewhere');
  });

  // ── The parent lands ────────────────────────────────────────────────

  await t.test('S6 a stack of three lands in order: each change, once the one under it is on main, is retargeted to main, synced, and merged', async () => {
    defaults();
    const { a, A, B, C } = await stack();
    await want(a);
    await settle();
    assert.deepEqual(calls(WORK.attempt).map((c) => Number(c.input.sessionId)), [A.id]);

    // A lands: B is told, C (stacked on B, still open) is not.
    await landed(A);
    const told = await eventsOf(MACHINE, sessionKey(B.id), 'ParentMerged');
    assert.equal(told.length, 1);
    assert.equal(told[0].payload.parentId, A.id);
    assert.equal(told[0].source.from.machine, MACHINE, 'from the parent\'s own machine');
    assert.equal((await eventsOf(MACHINE, sessionKey(C.id), 'ParentMerged')).length, 0);
    // B's pull request is retargeted to main, then it syncs with main.
    const [retarget] = callsFor(WORK.retarget, B);
    assert.deepEqual([retarget.input.number, retarget.input.owner], [B.pr_number, 'acme'], 'onto its repository\'s default branch, which the work reads');
    const b = await row(B);
    assert.deepEqual([b.imported_pr_base_ref, b.waits_for_session_id], [null, null], 'no other base: it merges into main');
    const [sync] = callsFor(WORK.sync, B);
    assert.equal(sync.input.reason, 'parent_merged', 'the existing Homeroom sync, which resolved #5956\'s conflict');
    assert.ok((await lines(B)).some((l) => /^PR #\d+: Change \d+: the change it is built on is on main now, so its pull request targets main\. Homeroom is bringing it up to date with main; its checks run again on the result\.$/.test(l)));
    assert.ok((await eventsOf(QUEUE, appKey(a.id), 'MergeWanted')).some((e) => e.payload.reason === 'parent-merged'), 'the queue hears it may be in line');
    assert.equal((await row(C)).waits_for_session_id, B.id, 'C still waits for B');

    // The sync is done (its checks ran again on what it pushed): B merges, C does not.
    await want(a);
    await settle();
    assert.deepEqual(calls(WORK.attempt).map((c) => Number(c.input.sessionId)), [A.id, B.id]);

    // B lands: C moves onto main the same way, and merges last.
    await landed(B);
    assert.equal((await eventsOf(MACHINE, sessionKey(C.id), 'ParentMerged'))[0].payload.parentId, B.id);
    assert.equal(callsFor(WORK.retarget, C).length, 1);
    assert.equal(callsFor(WORK.sync, C)[0].input.reason, 'parent_merged');
    await want(a);
    await settle();
    assert.deepEqual(calls(WORK.attempt).map((c) => Number(c.input.sessionId)), [A.id, B.id, C.id], 'in order, each into main');
  });

  await t.test('S7 a parent merged into main on GitHub before its vote moves its children; told twice, a child retargets once; a closed child keeps its base', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner, status: 'active' });
    const B = await imported({ appRow: a, owner, on: A, status: 'active' });
    const gone = await imported({ appRow: a, owner, on: A, status: 'archived' });
    await toProposal(A, 'PrLooked', { from: 'active', merged: true, closed: true, baseRead: true, base: null });
    await rt.drain();
    assert.equal((await pInst(A)).data.reason, 'pr-merged');
    assert.equal((await eventsOf(MACHINE, sessionKey(B.id), 'ParentMerged')).length, 1);
    assert.equal((await eventsOf(MACHINE, sessionKey(gone.id), 'ParentMerged')).length, 0, 'only open children are told');
    // A look reads the parent merged too, before the retarget has run.
    const again = await toProposal(B, 'ParentMerged', { parentId: A.id });
    await rt.drain();
    assert.equal((await outcome(again)).result, 'accepted');
    await settle();
    assert.equal(callsFor(WORK.retarget, B).length, 1, 'one retarget answers both');
    assert.equal((await row(B)).imported_pr_base_ref, null);
    assert.equal(callsFor(WORK.sync, B)[0].input.reason, 'parent_merged', 'underway, it syncs too');
    const closed = await toProposal(gone, 'ParentMerged', { parentId: A.id });
    await settle();
    assert.equal((await outcome(closed)).reason, 'closed');
  });

  await t.test('S8 a retarget GitHub never answers says what a person can do, and the change no longer reads as waiting; one no longer open says nothing', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    work.answer.set(WORK.retarget, () => { throw new Error('GitHub is unreachable.'); });
    await settle();
    await landed(A);
    assert.equal(callsFor(WORK.retarget, B).length, 1);
    assert.equal(callsFor(WORK.sync, B).length, 0);
    assert.deepEqual([(await row(B)).imported_pr_base_ref, (await row(B)).waits_for_session_id], [A.branch_name, A.id], 'still where it was');
    assert.equal((await pInst(B)).data.retarget, null, 'and a later look may ask again');
    assert.ok((await lines(B)).some((l) => /could not move its pull request onto main on GitHub \(GitHub is unreachable\)\. Change its base to main on GitHub/.test(l)));
    // Its parent is merged, so it waits for nothing: its base is just not main.
    const asked = await toProposal(B, 'MergeRequested', { queueN: 31 }, fromQueue);
    await settle();
    assert.equal((await outcome(asked)).result, 'accepted');
    assert.ok((await eventsOf(QUEUE, appKey(a.id), 'AttemptEnded')).some((x) => x.payload.n === 31 && x.payload.reason === 'base_not_main'));
    // Merged or closed on GitHub meanwhile: its look settles it, nothing is said.
    const C = await imported({ appRow: a, owner, on: B });
    work.answer.set(WORK.retarget, { skipped: 'not_open' });
    await settle();
    await toProposal(C, 'ParentMerged', { parentId: B.id });
    await settle();
    assert.equal(callsFor(WORK.retarget, C).length, 1);
    assert.deepEqual(await lines(C), []);
  });

  // ── Promotion ───────────────────────────────────────────────────────

  await t.test('S9 a stacked import goes up for a vote and records what it waits for; one based on a branch no open change has is refused', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner, status: 'active' });
    const B = await imported({ appRow: a, owner, status: 'active' });
    await pool.query('UPDATE chat_sessions SET imported_pr_base_ref = NULL, waits_for_session_id = NULL WHERE id = $1', [B.id]);
    const promote = (s, base) => toProposal(s, 'Promote', {
      from: 'active', userId: owner.id, username: owner.username, cap: 10,
      pr: { state: 'open', draft: false, merged: false, head: s.imported_pr_head_sha, base },
    }, route);
    const up = await promote(B, A.branch_name);
    await settle();
    assert.equal((await outcome(up)).result, 'accepted');
    const b = await row(B);
    assert.deepEqual([b.status, b.imported_pr_base_ref, b.waits_for_session_id], ['promoted', A.branch_name, A.id]);
    const D = await imported({ appRow: a, owner, status: 'active' });
    const refused = await promote(D, 'claude/a-branch-nobody-has');
    await settle();
    assert.deepEqual([(await outcome(refused)).result, (await outcome(refused)).reason], ['rejected', 'pr_base_not_main']);
    assert.equal((await row(D)).status, 'active');
    // One on main (no other base) goes up as ever.
    const ok = await promote(A, null);
    await settle();
    assert.equal((await outcome(ok)).result, 'accepted');
  });

  // ── What the review found (PR #5968) ────────────────────────────────

  const review = async (s) => {
    await asTransition((c) => c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]));
    await rt.fireTimers();
    await settle();
  };
  const until = async (fn, what) => {
    for (let i = 0; i < 500 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
    if (!(await fn())) assert.fail(`${what} never happened`);
  };

  await t.test('S10 a change waiting for a parent up for its own vote does not go quiet; one waiting for a draft, or for nothing, does', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const draft = await imported({ appRow: a, owner, status: 'active' });
    const waiting = await imported({ appRow: a, owner, on: A });
    const onDraft = await imported({ appRow: a, owner, on: draft });
    const lone = await imported({ appRow: a, owner, base: 'someone/else' });
    const quiet = [waiting, onDraft, lone];
    for (const s of quiet) {
      await pool.query(`UPDATE chat_sessions SET promoted_at = NOW() - interval '10 days', created_at = NOW() - interval '10 days' WHERE id = $1`, [s.id]);
    }
    await settle();
    for (const s of quiet) await review(s);
    assert.equal((await row(waiting)).stale_notified_at, null, 'its parent is up for a vote: nothing it could do would merge it sooner');
    assert.ok((await row(onDraft)).stale_notified_at, 'a parent nobody put up for a vote is no reason to hold a review slot');
    assert.ok((await row(lone)).stale_notified_at, 'nothing to wait for: it goes quiet as any change does');
  });

  await t.test('S11 moved onto main while it goes up for a vote: its sync is owed, and runs once it is in review', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A, status: 'active' });
    await settle();
    let release;
    work.hold.set(WORK.retarget, new Promise((r) => { release = r; }));
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [A.id]));
    await toProposal(A, 'Merged', {}, fromMerge);
    await rt.drain();
    const run = settle();
    await until(() => callsFor(WORK.retarget, B).length === 1, 'the retarget');
    // Put up for a vote while its retarget runs: it still targets A's
    // branch, the change it waited for, so it goes up; GitHub's open waits
    // behind the retarget (one GitHub move at a time).
    const up = await toProposal(B, 'Promote', { from: 'active', userId: owner.id, username: owner.username, cap: 10,
      pr: { state: 'open', draft: false, merged: false, head: B.imported_pr_head_sha, base: A.branch_name } }, route);
    await rt.drain();
    assert.equal((await outcome(up)).result, 'accepted');
    assert.equal((await pInst(B)).state, 'proposing');
    release();
    await run;
    await settle();
    assert.equal((await pInst(B)).state, 'in_review');
    const [sync] = callsFor(WORK.sync, B);
    assert.ok(sync, 'the owed sync ran once it was in review');
    assert.equal(sync.input.reason, 'parent_merged');
    assert.ok(work.calls.findIndex((c) => c.kind === WORK.open && Number(c.input.sessionId) === B.id)
      < work.calls.findIndex((c) => c.kind === WORK.sync && Number(c.input.sessionId) === B.id), 'after its pull request was opened for review');
    assert.ok(!(await pInst(B)).data.owedSync);
    assert.equal((await row(B)).imported_pr_base_ref, null);
  });

  await t.test('S12 a retarget finds its author moved the base meanwhile: nothing moves, nothing syncs', async () => {
    defaults();
    work.answer.set(WORK.retarget, { skipped: 'base_moved', base: 'someone/else' });
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    await settle();
    await landed(A);
    assert.equal(callsFor(WORK.retarget, B)[0].input.from, A.branch_name, 'it is told the base it was asked about');
    assert.equal(callsFor(WORK.sync, B).length, 0);
    assert.equal((await row(B)).imported_pr_base_ref, A.branch_name, 'the next look records where it is');
    assert.equal((await pInst(B)).data.retarget, null);
  });

  await t.test('S13 a close forgets the retarget it was waiting for, and a reopened change moves onto main again', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A, status: 'active' });
    await settle();
    let release;
    work.hold.set(WORK.retarget, new Promise((r) => { release = r; }));
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [A.id]));
    await toProposal(A, 'Merged', {}, fromMerge);
    await rt.drain();
    const run = settle();
    await until(() => callsFor(WORK.retarget, B).length === 1, 'the retarget');
    await toProposal(B, 'Close', { from: 'active', reason: 'manual', userId: owner.id }, route);
    await rt.drain();
    assert.equal((await pInst(B)).state, 'closed');
    assert.equal((await pInst(B)).data.retarget, null);
    work.hold.delete(WORK.retarget);
    release();
    await run;
    await settle();
    const back = await toProposal(B, 'Reopen', { from: 'archived', userId: owner.id }, route);
    await settle();
    assert.equal((await outcome(back)).result, 'accepted');
    await toProposal(B, 'ParentMerged', { parentId: A.id });
    await settle();
    assert.equal(callsFor(WORK.retarget, B).length, 2, 'moved again, not ignored');
  });

  await t.test('S14 a parent is a branch of the app\'s own repository, and a merged one only when it was waited for', async () => {
    const owner = await user();
    const a = await app(owner);
    const forked = await imported({ appRow: a, owner });
    await pool.query(`UPDATE chat_sessions SET branch_name = 'develop', imported_pr_head_repo = 'someone/fork' WHERE id = $1`, [forked.id]);
    const once = await imported({ appRow: a, owner, status: 'merged' });
    await pool.query(`UPDATE chat_sessions SET branch_name = 'develop' WHERE id = $1`, [once.id]);
    assert.deepEqual(await prBase.readBaseOwner(pool, { appId: a.id, sessionId: null, base: 'develop' }), { open: null, merged: null },
      'a fork\'s branch called develop is not the base\'s, and a develop merged once is no parent');
    const waited = await prBase.readBaseOwner(pool, { appId: a.id, sessionId: null, base: 'develop', waited: once.id });
    assert.equal(waited.merged.id, once.id, 'the parent it was waiting for, merged since');
  });

  await t.test('S15 the review check\'s clock runs from the move onto main, and a warning from the wait is forgotten', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    await pool.query(`UPDATE chat_sessions SET promoted_at = NOW() - interval '10 days', created_at = NOW() - interval '10 days',
                             stale_notified_at = NOW() - interval '1 day' WHERE id = $1`, [B.id]);
    await settle();
    await landed(A);
    assert.equal((await row(B)).imported_pr_base_ref, null);
    assert.equal((await row(B)).stale_notified_at, null, 'the warning from the wait is forgotten');
    await review(B);
    assert.equal((await row(B)).stale_notified_at, null, 'it has its week in the queue from the move');
    assert.ok((await pInst(B)).data.movedToMainAt);
  });

  await t.test('S16 a parent it no longer waits for moves nothing', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const D = await imported({ appRow: a, owner });
    const C = await imported({ appRow: a, owner, on: D });
    await settle();
    // Its author stacked it on D after a look had it waiting for A.
    await toProposal(C, 'ParentMerged', { parentId: A.id });
    await settle();
    assert.equal(callsFor(WORK.retarget, C).length, 0);
    assert.equal((await row(C)).waits_for_session_id, D.id);
  });

  await t.test('S17 a sync owed while somebody worked on it is begun by the queue\'s next ask, not an hour later', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    await settle();
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"mode":"build"}'::jsonb WHERE id = $1`, [B.id]);
    await landed(A);
    assert.equal(callsFor(WORK.sync, B).length, 0, 'not under a turn');
    assert.equal((await pInst(B)).data.owedSync, true);
    const early = await toProposal(B, 'MergeRequested', { queueN: 41 }, fromQueue);
    await settle();
    assert.equal((await outcome(early)).result, 'accepted');
    const ends = async () => (await eventsOf(QUEUE, appKey(a.id), 'AttemptEnded')).map((x) => [x.payload.n, x.payload.reason]);
    assert.ok((await ends()).some(([n, r]) => n === 41 && r === 'sync_owed'), 'never merged before its sync');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [B.id]);
    await toProposal(B, 'MergeRequested', { queueN: 42 }, fromQueue);
    await settle();
    assert.ok((await ends()).some(([n, r]) => n === 42 && r === 'syncing'));
    assert.equal(callsFor(WORK.sync, B)[0].input.reason, 'parent_merged');
    assert.ok(!(await pInst(B)).data.owedSync);
    assert.equal(calls(WORK.gate).filter((c) => Number(c.input.sessionId) === B.id).length, 0, 'measured only once it has synced');
  });

  await t.test('S18 a change is not merged while its retarget runs', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const A = await imported({ appRow: a, owner });
    const B = await imported({ appRow: a, owner, on: A });
    await settle();
    let release;
    work.hold.set(WORK.retarget, new Promise((r) => { release = r; }));
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [A.id]));
    await toProposal(A, 'Merged', {}, fromMerge);
    await rt.drain();
    const run = settle();
    await until(() => callsFor(WORK.retarget, B).length === 1, 'the retarget');
    // A look already reads it on main (GitHub retargeted it itself).
    await pool.query('UPDATE chat_sessions SET imported_pr_base_ref = NULL, waits_for_session_id = NULL WHERE id = $1', [B.id]);
    await toProposal(B, 'MergeRequested', { queueN: 51 }, fromQueue);
    await rt.drain();
    assert.ok((await eventsOf(QUEUE, appKey(a.id), 'AttemptEnded')).some((x) => x.payload.n === 51 && x.payload.reason === 'retargeting'));
    work.hold.delete(WORK.retarget);
    release();
    await run;
    await settle();
    assert.equal(callsFor(WORK.sync, B)[0].input.reason, 'parent_merged', 'it syncs once moved');
  });
});
