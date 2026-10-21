'use strict';

// A promoted CLI proposal takes a new local upload after its checks have run
// (session 8465, 16 October 2026). The checks are the preview machine's:
// it holds a head per proposal and re-checks that head. A promoted upload
// moves the head people vote on (reviewed_head_sha) and clears the verdict,
// but starts no checks; only the submit hands the new head to the machine.
// The submit used to refuse unless the checks were already pinned to the
// upload, and "Run checks again" re-checked the machine's old head, so
// neither could move the checks onto the upload: every submit answered 409
// session_state_changed and every recheck ran the old commit again.
//
// The whole path, through the real upload and build routes, the real
// preview machine and the real schema (GitHub, the build and the checks run
// stubbed, as in tests/workflow-preview-platform-postgres.test.js):
//   - checks run on H1, H2 is uploaded, the submit of H2 is taken and the
//     machine builds and checks H2;
//   - "Run checks again" with the machine on H1 and the reviewed head on H2
//     checks H2, and a submit after it starts no second build;
//   - the submit still refuses a moved branch, a newer upload, and checks
//     pinned to a third commit.
//
// Run with: node --test tests/promoted-upload-checks-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const BASE = SHA('0');
const H1 = SHA('1');
const H2 = SHA('2');
const H3 = SHA('3');
const THIRD = SHA('4');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    once() { return this; },
  };
}

function routeHandler(router, routePath, method) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath && entry.route.methods[method]);
  if (!layer) throw new Error(`${method} ${routePath} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('a promoted CLI upload reaches its checks', { timeout: 120000 }, async (t) => {
  // Every wait shares this budget: a step's deadline is the test's own
  // timeout less a margin for t.after's cleanup, so a loaded container fails
  // on the state it reached, never on the clock behind it.
  const TIMEOUT_MS = 120000;
  const startedAt = Date.now();
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'promoted_upload_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // Each call is recorded with the session that made it: the sub-tests reuse
  // the heads (H1 and H2), so a call still in flight from an earlier
  // sub-test's session must not be counted in a later one.
  const calls = [];
  const gh = { remote: H1, nextUpload: null, onRead: null };
  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', { ...realWs, broadcast: () => {}, broadcastGlobal: () => {}, pushSessionUpdate: () => {},
    sendSystemMessage: async () => {}, pushVoteUpdate: () => {} });
  const realStaging = require('../src/services/staging');
  stub('../src/services/staging', {
    ...realStaging,
    async prepareAttempt(config, row, app, head, attempt) {
      calls.push({ kind: 'prepare', head, session: row.id });
      await attempt.checkpoint({ step: 'deploy', db: attempt.dbName });
      return { stagingUrl: `https://shop--s${row.id}.apps`, hostname: `shop--s${row.id}.apps`, runtimeKind: 'kubernetes',
        runtimeName: `sv-preview-${app.id}-s${row.id}`, containerId: null, imageRef: `img@sha256:${attempt.n}`, buildRef: null };
    },
    async verifyStagingEdge() { return { ok: true }; },
  });
  const realVisuals = require('../src/services/visuals');
  stub('../src/services/visuals', {
    ...realVisuals,
    async captureForSession(config, row, app, head) {
      calls.push({ kind: 'checks', head, session: row.id });
      // A head with no repo unit suite, so a person's recheck is answered
      // whether or not the machine asks for a fresh suite on it.
      return { outcome: 'verdict', state: 'passing', results: [], console: { state: 'clean', errors: [] }, history: [],
        capture: { state: 'console_only', detail: {} }, visuals: false, unitSuiteAbsent: true };
    },
    startShotsIfIdle: async () => {}, scheduleShots: () => {}, notifyChecks: () => {}, notifyChecksPending: () => {},
    noteBotChecksAfterChecks: () => {}, maybeAutoMergeAfterChecks: () => {},
  });
  stub('../src/services/db-manager', { ...require('../src/services/db-manager'), dropDatabase: async () => {} });
  stub('../src/services/kubernetes', { ...require('../src/services/kubernetes'), deleteSecret: async () => {}, cancelPreviewChecks: async () => {} });
  const realGithub = require('../src/services/github');
  stub('../src/services/github', {
    ...realGithub,
    isEnabled: () => true,
    // A hook is armed for one branch and runs on the FIRST read of it, as the
    // submit's own branch_moved check is; other readers (preview-workflow's
    // exactHead, cli-handoff-sync) and other branches pass through untouched.
    // Every read of the armed branch is counted while it is armed, so a
    // submit that reads it more than once fails here instead of passing by.
    async getBranchSha(owner, repo, branch) {
      const hook = gh.onRead;
      if (hook && hook.branch === branch) {
        hook.reads += 1;
        if (hook.reads === 1) await hook.fn();
      }
      return gh.remote;
    },
    async createProposalCommit(owner, repo, args) {
      // The real one refuses a branch that is not at the expected parent.
      if (args.expectedRemoteParentSha !== gh.remote) throw Object.assign(new Error('moved'), { code: 'branch_moved' });
      gh.remote = gh.nextUpload;
      return { sha: gh.nextUpload, treeSha: args.expectedTreeSha, created: true };
    },
  });
  // What votes.reconcileNativeReviewedHead does to the row for a promoted
  // upload (deferChecks, a move that is not a mechanical merge): the head
  // people vote on becomes the branch's head and the approvals reset. It
  // starts no checks and leaves the checks pin where it was. The move is the
  // proposal machine's (it holds every promoted row once the release's
  // adoptions ran), so the stand-in writes as its transition does.
  stub('../src/routes/votes', {
    async reconcileNativeReviewedHead({ pool: p, session }) {
      const c = await p.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        const { rows: [r] } = await c.query(
          `UPDATE chat_sessions SET reviewed_head_sha = $1, approval_epoch = approval_epoch + 1
            WHERE id = $2 RETURNING approval_epoch`, [gh.remote, session.id]);
        await c.query('COMMIT');
        return { headSha: gh.remote, epoch: r.approval_epoch, kind: 'code', checksDeferred: true };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  });

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPreviewsEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise', captureRuntime: 'kubernetes', kubernetes: {},
  };
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    await platform.stopWorkflow();
    // The routes' session operations hold this process's presence lock on
    // its own connection to the test database.
    await require('../src/services/process-presence').reset();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow(config, { loops: true });
  const router = require('../src/routes/proposal-handoff').proposalHandoffRoutes(config);
  const upload = routeHandler(router, '/api/sessions/:id/proposal-handoff/commits', 'post');
  const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
  const recovery = require('../src/services/staging-recovery');

  const { rows: [author] } = await pool.query(`INSERT INTO users (username, password) VALUES ('author', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('Shop', 'shop', $1, 'https://github.com/acme/shop') RETURNING *`,
    [author.id]);
  const user = { id: author.id, username: 'author' };
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const machine = async (s) => platform.previewInstance(s.id);
  const callsOf = (s) => calls.filter((c) => c.session === s.id);
  const count = (s, kind, head) => callsOf(s)
    .filter((c) => c.kind === kind && (head === undefined || c.head === head)).length;
  const short = (sha) => String(sha || '').slice(0, 8);
  // What a failed wait saw, so a red run on main can be read from its log.
  const describe = async (s) => {
    try {
      const parts = [];
      const m = await machine(s);
      parts.push(`machine ${m ? `${m.state} on ${short(m.data?.head)}` : 'none'}`);
      const r = await row(s);
      parts.push(`row check_state ${r.check_state} checks ${short(r.checks_commit_sha)}`
        + ` reviewed ${short(r.reviewed_head_sha)} handoff ${short(r.handoff_head_sha)}`);
      const { rows } = await pool.query(
        `SELECT kind, work_key, status, last_error FROM wf_work WHERE machine = 'preview' AND status <> 'settled'`);
      parts.push(`unsettled ${JSON.stringify(rows)}`);
      parts.push(`work running ${platform.workflowWorkRunning()}`);
      parts.push(`calls ${JSON.stringify(callsOf(s))}`);
      return `; ${parts.join('; ')}`;
    } catch (err) {
      return `; (could not read the state: ${err.message})`;
    }
  };
  const until = async (check, what, s) => {
    const deadline = startedAt + TIMEOUT_MS - 10000;
    while (!(await check())) {
      if (Date.now() >= deadline) assert.fail(`${what}${s ? await describe(s) : ''}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const settledOn = (s, head) => until(async () => {
    const m = await machine(s);
    const r = await row(s);
    return m?.state === 'settled' && m.data.head === head && r.check_state === 'passing' && r.checks_commit_sha === head;
  }, `settled and passing on ${head.slice(0, 8)}`, s);
  // The rows are written a moment after the work starts: the machine moves
  // through preparing and checking and the kernel runs its work in memory, so
  // a single poll for quiet rows can land in that gap. At rest is all of these
  // at once, and the drain needs it twice in a row, a moment apart.
  const atRest = async (s) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM wf_work WHERE machine = 'preview' AND status IN ('queued', 'running', 'reported')
       UNION ALL SELECT 1 FROM wf_events WHERE machine = 'preview' AND status = 'pending'`);
    if (rows.length) return false;
    if (platform.workflowWorkRunning() !== 0) return false;
    const m = await machine(s);
    return !!m && (m.state === 'settled' || m.state === 'idle');
  };
  const drain = async (s) => {
    const deadline = startedAt + TIMEOUT_MS - 10000;
    let last = false;
    for (;;) {
      const rest = await atRest(s);
      if (rest && last) return;
      last = rest;
      if (Date.now() >= deadline) assert.fail(`drained${await describe(s)}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  };

  // A promoted CLI proposal whose checks ran and passed on H1.
  let branch = 0;
  const promotedOnH1 = async () => {
    branch += 1;
    gh.remote = H1;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, handoff_base_sha,
                                  handoff_head_sha, handoff_uploaded_sha, reviewed_head_sha, promoted_at)
       VALUES ($1, $2, 'promoted', 'cli_handoff', $3, 53, $4, $5, $5, $5, NOW()) RETURNING *`,
      [app.id, author.id, `dev/upload-${branch}`, BASE, H1]);
    await platform.submitRevision({ sessionId: s.id, appId: app.id, head: H1, source: 'cli', trigger: 'commit-push' });
    await settledOn(s, H1);
    await drain(s);
    return s;
  };
  const uploadHead = async (s, head, parent) => {
    gh.nextUpload = head;
    const res = mockRes();
    await upload({ params: { id: String(s.id) }, cliAuthenticated: true, user, body: {
      schemaVersion: 1, localCommitSha: crypto.createHash('sha1').update(head).digest('hex'),
      parentSha: parent, parentTreeSha: SHA('5'), treeSha: SHA('6'), message: 'Local revision',
      authoredAt: '2026-10-16T08:00:00Z', committedAt: '2026-10-16T08:00:00Z',
      files: [{ path: 'src/a.js', mode: '100644', contentBase64: 'YQ==' }],
    } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    return res;
  };
  const submit = async (s, head) => {
    const res = mockRes();
    await build({ params: { id: String(s.id) }, cliAuthenticated: true, user, body: {
      schemaVersion: 1, headSha: head,
      history: [{ id: `build-${head.slice(0, 8)}`, kind: 'summary', phase: 'build', content: 'Submitted the revision.' }],
      tests: [],
    } }, res);
    return res;
  };
  // The build route reads the branch once on a promoted submit (its own
  // branch_moved check), so the hook must run on that read and the submit
  // must not read the branch again.
  const BRANCH_READS_PER_SUBMIT = 1;
  const hookedSubmit = async (s, fn) => {
    const hook = { branch: s.branch_name, fn, reads: 0 };
    gh.onRead = hook;
    let res;
    try { res = await submit(s, H2); } finally { gh.onRead = null; }
    assert.equal(hook.reads, BRANCH_READS_PER_SUBMIT, 'the submit read the branch once');
    return res;
  };
  const prepared = (s, head) => count(s, 'prepare', head);

  await t.test('checks on H1, upload H2, submit H2: the submit is taken and the machine checks H2', async () => {
    const s = await promotedOnH1();
    await uploadHead(s, H2, H1);
    let r = await row(s);
    assert.equal(r.reviewed_head_sha, H2, 'the upload moved the head people vote on');
    assert.equal(r.checks_commit_sha, H1, 'and started no checks: the pin is still the old run\'s');
    assert.equal(r.handoff_upload_checked_sha, H1);
    assert.equal(r.check_state, null, 'the verdict is cleared');
    // No assertion on the machine's head here: clearing the verdict leaves a
    // promoted row owing checks on the head people vote on, and the machine
    // sweeps that head on its own at the upload's operation end. That it
    // built H2 once, and that the row's pin never moved to H2 by the upload,
    // is asserted below.

    const res = await submit(s, H2);
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.body.state, 'promoted');
    await settledOn(s, H2);
    r = await row(s);
    assert.equal(r.handoff_head_sha, H2);
    assert.equal(r.handoff_upload_checked_sha, null);
    assert.equal(prepared(s, H2), 1, 'the machine built H2 once');

    // A retry after a lost response is the idempotent early return.
    const before = callsOf(s).length;
    const retry = await submit(s, H2);
    assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
    await drain(s);
    assert.equal(callsOf(s).length, before, 'a retry starts nothing');
  });

  await t.test('"Run checks again" with the machine on H1 and the reviewed head on H2 checks H2, and a submit after it builds nothing twice', async () => {
    const s = await promotedOnH1();
    await uploadHead(s, H2, H1);
    const h1Builds = prepared(s, H1);
    const h1Checks = count(s, 'checks', H1);
    const fresh = { ...(await row(s)), app_slug: app.slug, repo_url: app.repo_url };
    await recovery.recheckSessionChecks({ config, pool, session: fresh, reason: 'manual-recheck' });
    await settledOn(s, H2);
    await drain(s);
    assert.equal(prepared(s, H1), h1Builds, 'the old head is not built again');
    assert.equal(count(s, 'checks', H1), h1Checks, 'nor checked again');
    const h2Builds = prepared(s, H2);

    // Rechecking again with the machine on the reviewed head checks it in
    // place: this session's checks on H2 go past what the first run left.
    const h2Checks = count(s, 'checks', H2);
    await recovery.recheckSessionChecks({ config, pool, session: await row(s), reason: 'manual-recheck' });
    await until(async () => count(s, 'checks', H2) > h2Checks, 'rechecked H2 in place', s);
    await drain(s);
    assert.equal(prepared(s, H2), h2Builds, 'a recheck of the head the machine holds builds nothing');

    // The submit adopts the upload (its checks are already on it) and the
    // revision joins what the machine holds: no second build.
    const res = await submit(s, H2);
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal((await row(s)).handoff_head_sha, H2);
    await drain(s);
    assert.equal(prepared(s, H2), h2Builds, 'the submit\'s revision of the same head is joined');
  });

  await t.test('the submit still refuses a moved branch, a newer upload, and checks pinned to a third commit', async () => {
    const s = await promotedOnH1();
    await uploadHead(s, H2, H1);
    // The upload cleared the verdict, so the machine sweeps the head people
    // vote on by itself. Let that run finish first: what this sub-test pins
    // is that the three REFUSED submits adopt nothing and build nothing, not
    // whether the machine's own sweep ran.
    await settledOn(s, H2);
    await drain(s);
    const builds = prepared(s, H2);

    gh.remote = H3;
    let res = await submit(s, H2);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'branch_moved');
    gh.remote = H2;

    // A newer upload lands while this submit reads the branch.
    res = await hookedSubmit(s, () => pool.query(`UPDATE chat_sessions SET handoff_uploaded_sha = $2 WHERE id = $1`, [s.id, H3]));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    await pool.query(`UPDATE chat_sessions SET handoff_uploaded_sha = $2 WHERE id = $1`, [s.id, H2]);

    // The upload's recorded pin changes under the submit.
    res = await hookedSubmit(s, () => pool.query(`UPDATE chat_sessions SET handoff_upload_checked_sha = $2 WHERE id = $1`, [s.id, THIRD]));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    await pool.query(`UPDATE chat_sessions SET handoff_upload_checked_sha = $2 WHERE id = $1`, [s.id, H1]);

    // Checks pinned to a commit that is neither the upload's recorded pin nor
    // the upload (written as the machine would write it).
    res = await hookedSubmit(s, async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL app.wf_writer = 'transition'`);
        await c.query(`UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1`, [s.id, THIRD]);
        await c.query('COMMIT');
      } finally { c.release(); }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    const r = await row(s);
    assert.equal(r.handoff_head_sha, H1, 'nothing was adopted');
    await drain(s);
    assert.equal(prepared(s, H2), builds, 'the refused submits built nothing');
  });
});
