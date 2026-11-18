'use strict';

// Live app drafts (src/services/live-drafts.js) against the full PostgreSQL
// schema: opening a draft from a private thread about a project (its own
// change, branch and no-checks preview), the switch, the preview's start
// command, an edit (committed, then written into the running preview, with
// what the restart said), a preview behind the draft brought up to date, a
// new install built again, Propose (the person's own promote, refused until
// there is something to propose and the preview is up) and Close. The code
// host, the preview machine, the supervisor and the promote are stand-ins
// recording what they were asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const liveDrafts = require('../src/services/live-drafts');
const supervisor = require('../src/services/live-draft-supervisor');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const CONFIG = { appRuntime: 'docker', workerJwtSecret: 'w'.repeat(48), selfAppSlug: 'usernode-self' };

test('supervisorCommand: plain Node for Docker and BuildKit images, the CNB launcher for a buildpack image', () => {
  const docker = liveDrafts.supervisorCommand({ runtimeKind: 'docker' }, 'docker');
  assert.deepEqual(docker.slice(0, 2), ['node', '-e']);
  assert.match(docker[2], /live-draft-supervisor|USERNODE_LIVE_SUPERVISOR/);
  assert.deepEqual(liveDrafts.supervisorCommand({ engine: 'buildkit' }, 'kubernetes').slice(0, 2), ['node', '-e']);
  assert.deepEqual(liveDrafts.supervisorCommand({ buildRef: 'b/x' }, 'kubernetes').slice(0, 4),
    ['/cnb/lifecycle/launcher', '--', 'node', '-e']);
  // A single argument small enough for any exec (Linux caps one at 128 KiB).
  assert.ok(Buffer.byteLength(docker[2]) < 128 * 1024);
});

test('liveToken is the same on every process for one draft, and another draft\'s differs', () => {
  assert.equal(liveDrafts.liveToken(CONFIG, 7), liveDrafts.liveToken({ ...CONFIG }, 7));
  assert.notEqual(liveDrafts.liveToken(CONFIG, 7), liveDrafts.liveToken(CONFIG, 8));
  assert.match(liveDrafts.liveToken(CONFIG, 7), /^[0-9a-f]{64}$/);
});

test('rootOf reads the thread a message is in, else the message is its own root', () => {
  assert.equal(liveDrafts.rootOf({ id: 9, threadRootId: 4 }), 4);
  assert.equal(liveDrafts.rootOf({ id: 9, thread_root_id: 5 }), 5);
  assert.equal(liveDrafts.rootOf({ id: 9 }), 9);
});

test('live drafts against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'live_drafts_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 5 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  const user = async () => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`ld_${++seq}`])).rows[0];
  const app = async (extra = {}) => {
    const owner = await user();
    const slug = extra.slug || `ld-app-${++seq}`;
    return (await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1, $1, $2, $3) RETURNING *`,
      [slug, owner.id, `https://github.com/acme/${slug}`])).rows[0];
  };
  // A private thread of `u`'s chat with the bot, about `a` (or no project).
  const thread = async (u, a) => {
    const { rows: [c] } = await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [u.id]);
    const { rows: [m] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'make it blue') RETURNING id`, [c.id, u.id]);
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id) VALUES ($1, $2, $3, $4)`,
      [u.id, c.id, m.id, a ? a.id : null]);
    return m.id;
  };

  // ── Stand-ins ─────────────────────────────────────────────────────────
  const calls = { push: [], preview: [], fetch: [], ws: [], promote: [] };
  let commit = 0;
  let files = new Map([['server.js', 'v1'], ['public/index.html', '<p>one</p>']]);
  const github = {
    async getBranchSha() { return SHA('1'); },
    async pushFiles(owner, repo, list, opts) {
      calls.push.push({ owner, repo, list, opts });
      for (const f of list) files.set(f.path, f.content);
      commit += 1;
      return { sha: crypto.createHash('sha1').update(`c${commit}`).digest('hex') };
    },
    async listChangedFiles(owner, repo, basehead) { calls.compare = basehead; return ['public/index.html', 'gone.js']; },
    async getFileContent(owner, repo, p) { return files.has(p) ? files.get(p) : null; },
    async listRepoFiles() { return { files: [...files.keys()].map((p) => ({ path: p, size: 1 })) }; },
  };
  const lifecycle = {
    async ensureSessionBranch({ pool: p, sessionId }) {
      const branchName = `dev/draft-${sessionId}`;
      await p.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [sessionId, branchName]);
      return { branchName, created: true };
    },
  };
  const previewWorkflow = { async request(args) { calls.preview.push(args); return { status: 'accepted' }; } };
  // What the supervisor answers: { status: { head }, apply: (body) => [status, json] }, or throws.
  let preview = null;
  const fakeFetch = async (href, init = {}) => {
    calls.fetch.push({ href, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (!preview) throw new Error('connect ECONNREFUSED');
    const route = href.split(supervisor.CONTROL_PREFIX)[1];
    const [status, body] = route === 'status' ? [200, { ok: true, ...preview.status }] : preview.apply(JSON.parse(init.body));
    return { status, json: async () => body };
  };
  const ws = { pushToUser(id, payload) { calls.ws.push({ id, payload }); return 1; } };
  let promoteReply = { status: 200, body: { ok: true, status: 'promoted' } };
  const platform = { async promoteProposal(args) { calls.promote.push(args); return promoteReply; } };
  const deps = {
    github, sessionLifecycle: lifecycle, previewWorkflow, fetch: fakeFetch, ws, platform,
    appAccess: { ...require('../src/services/app-access'), checkAppAccess: async () => true },
    communities: { appNeedsJoin: async () => null },
  };
  // The preview machine published the draft's preview (services/staging.js does this on deploy).
  const publish = (draft, head = SHA('1')) => pool.query(
    `UPDATE chat_sessions SET staging_url = 'https://x--s1.example', staging_runtime_kind = 'docker',
       staging_runtime_name = $2, staging_commit_sha = $3 WHERE id = $1`, [draft.sessionId, `usernode-staging-s${draft.sessionId}`, head]);

  const person = await user();
  const project = await app();

  await t.test('opening a draft makes its own change, branch and no-checks preview', async () => {
    const root = await thread(person, project);
    const out = await liveDrafts.open(pool, CONFIG, { user: person, rootId: root, deps });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const { draft } = out.body;
    assert.equal(draft.state, 'open');
    assert.equal(draft.live, 'starting');
    assert.equal(draft.headSha, SHA('1'));
    const { rows: [s] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [draft.sessionId]);
    assert.deepEqual([s.user_id, s.status, s.is_headless, s.branch_name], [person.id, 'paused', false, `dev/draft-${s.id}`]);
    assert.equal(calls.preview.length, 1);
    assert.deepEqual([calls.preview[0].reason, calls.preview[0].head], ['preview', SHA('1')]);
    // Their thread's bar is told it was opened, so the preview comes up beside the chat.
    assert.deepEqual(calls.ws.map((c) => [c.id, c.payload.type, c.payload.opened, c.payload.draft.id]),
      [[person.id, 'live_draft_changed', true, draft.id]]);
    // Asked again, the same draft, brought up again.
    const again = await liveDrafts.open(pool, CONFIG, { user: person, rootId: root, deps });
    assert.deepEqual([again.body.reused, again.body.draft.id], [true, draft.id]);
    assert.equal(calls.preview.length, 1);
    assert.deepEqual([calls.ws.length, calls.ws[1].payload.opened], [2, true]);
    assert.equal((await liveDrafts.threadOf(pool, { userId: person.id, message: { id: 999, threadRootId: root } })).id, draft.id);
  });

  await t.test('a draft needs a thread about a project, drafts switched on, and room for one more', async () => {
    const loose = await thread(person, null);
    assert.equal((await liveDrafts.open(pool, CONFIG, { user: person, rootId: loose, deps })).body.error, 'no_project');
    const self = await app({ slug: 'usernode-self' });
    const selfRoot = await thread(person, self);
    assert.equal((await liveDrafts.open(pool, CONFIG, { user: person, rootId: selfRoot, deps })).body.error, 'not_supported');
    const second = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, project), deps });
    assert.equal(second.status, 200);
    const third = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, project), deps });
    assert.deepEqual([third.status, third.body.error], [409, 'too_many']);
    await liveDrafts.close(pool, { user: person, draftId: second.body.draft.id, deps });

    await liveDrafts.setEnabled(pool, { on: false, actorId: person.id });
    const off = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, project), deps });
    assert.deepEqual([off.status, off.body.error], [503, 'drafts_off']);
    const { rows: [open] } = await pool.query("SELECT root_message_id FROM live_drafts WHERE state = 'open' LIMIT 1");
    assert.equal(await liveDrafts.threadOf(pool, { userId: person.id, message: { id: open.root_message_id } }), null,
      'switched off, a draft\'s thread is answered as any other');
    await liveDrafts.setEnabled(pool, { on: true, actorId: person.id });
    assert.equal((await liveDrafts.adminPayload(pool)).enabled, true);
  });

  const theDraft = async () => liveDrafts.describe(await liveDrafts.byId(pool,
    (await pool.query("SELECT id FROM live_drafts WHERE user_id = $1 AND state = 'open' ORDER BY id LIMIT 1", [person.id])).rows[0].id));

  await t.test('a draft\'s preview starts the supervisor with the draft\'s secret; any other preview as before', async () => {
    const draft = await theDraft();
    // runtimeFor reads the platform's own pool (db/pool.js): point it at this database.
    const poolModule = require('../src/db/pool');
    const real = poolModule.getPool;
    poolModule.getPool = () => pool;
    try {
      const got = await liveDrafts.runtimeFor(CONFIG, { session: { id: draft.sessionId }, build: { runtimeKind: 'docker' }, head: SHA('1') });
      assert.deepEqual(got.command.slice(0, 2), ['node', '-e']);
      assert.deepEqual(got.env, {
        USERNODE_LIVE_SUPERVISOR: '1', USERNODE_LIVE_TOKEN: liveDrafts.liveToken(CONFIG, draft.id), USERNODE_LIVE_HEAD: SHA('1'),
      });
      const { rows: [other] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [project.id, person.id]);
      assert.equal(await liveDrafts.runtimeFor(CONFIG, { session: { id: other.id }, build: {}, head: SHA('1') }), null);
      assert.equal(await liveDrafts.runtimeFor(CONFIG, { session: { id: 'x' }, build: {}, head: SHA('1') }), null);
      await liveDrafts.noteDeployed(CONFIG, { sessionId: draft.sessionId, deps });
      assert.equal((await liveDrafts.byId(pool, draft.id)).live_state, 'live');
      assert.equal(calls.ws[calls.ws.length - 1].payload.reload, true, 'deployed: the frame shows it');
    } finally {
      poolModule.getPool = real;
    }
  });

  await t.test('an edit saved while the first preview is still building lands once that preview is up', async () => {
    const { body: { draft } } = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, project), deps });
    const poolModule = require('../src/db/pool');
    const real = poolModule.getPool;
    poolModule.getPool = () => pool;
    const realRequest = previewWorkflow.request;
    try {
      await pool.query("UPDATE live_drafts SET live_state = 'starting' WHERE id = $1", [draft.id]);
      // No preview to reach yet, and the machine is building the first one.
      preview = null;
      calls.preview.length = 0;
      previewWorkflow.request = async (args) => { calls.preview.push(args); return { status: 'rejected', reason: 'in_progress' }; };
      const out = await liveDrafts.applyEdit(pool, CONFIG, {
        draftId: draft.id, userId: person.id, files: [{ path: 'public/app.css', content: 'b{}' }], summary: 'Bold', deps,
      });
      assert.equal(out.ok, true, 'the edit is saved');
      assert.deepEqual([out.preview.rebuilding, out.preview.why], [true, 'starting']);
      assert.equal((await liveDrafts.byId(pool, draft.id)).live_state, 'starting', 'still the first build, not a second');
      // It deploys at the commit it was asked for, which lacks the edit: the supervisor is sent it.
      preview = { status: { head: SHA('1') }, apply: () => [200, { ok: true, bootMs: 200 }] };
      calls.fetch.length = 0;
      await liveDrafts.noteDeployed(CONFIG, {
        sessionId: draft.sessionId, runtime: { runtimeKind: 'docker', runtimeName: `usernode-staging-s${draft.sessionId}` }, deps,
      });
      const sent = calls.fetch.find((c) => c.method === 'POST');
      assert.ok(sent, 'brought up to the draft\'s head');
      assert.equal(sent.body.head, out.head);
      assert.ok(sent.body.files.some((f) => f.path === 'public/app.css' || f.path === 'public/index.html'));
      assert.equal((await liveDrafts.byId(pool, draft.id)).live_state, 'live');
      assert.equal(calls.ws[calls.ws.length - 1].payload.reload, true);
      await liveDrafts.close(pool, { user: person, draftId: draft.id, deps });
    } finally {
      poolModule.getPool = real;
      previewWorkflow.request = realRequest;
      preview = null;
    }
  });

  await t.test('an edit is a commit, then the same files in the running preview', async () => {
    const draft = await theDraft();
    await publish(draft);
    preview = { status: { head: SHA('1') }, apply: () => [200, { ok: true, bootMs: 420, head: null }] };
    calls.fetch.length = 0;
    const out = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'server.js', content: 'v2' }], summary: 'Bigger start button', deps,
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.preview, { ok: true, bootMs: 420 });
    const pushed = calls.push[calls.push.length - 1];
    assert.equal(pushed.opts.branch, `dev/draft-${draft.sessionId}`);
    assert.equal(pushed.opts.message, 'Bigger start button');
    const applied = calls.fetch.find((c) => c.method === 'POST');
    assert.ok(applied.href.startsWith(`http://usernode-staging-s${draft.sessionId}:3000${supervisor.CONTROL_PREFIX}apply`));
    assert.equal(applied.headers[supervisor.TOKEN_HEADER], liveDrafts.liveToken(CONFIG, draft.id));
    assert.deepEqual(applied.body, { files: [{ path: 'server.js', content: 'v2' }], head: out.head });
    const now = await liveDrafts.byId(pool, draft.id);
    assert.deepEqual([now.head_sha, now.edits, now.live_state, now.last_error], [out.head, 1, 'live', null]);
    const edits = await liveDrafts.editsOf(pool, draft.id);
    assert.deepEqual(edits.map((e) => [e.commit, e.summary, e.paths]), [[out.head, 'Bigger start button', ['server.js']]]);
    const told = calls.ws[calls.ws.length - 1];
    assert.deepEqual([told.id, told.payload.type, told.payload.reload], [person.id, 'live_draft_changed', true]);
  });

  await t.test('a preview behind the draft (it slept and woke) gets what it lacks with the edit', async () => {
    const draft = await theDraft();
    preview = { status: { head: SHA('1') }, apply: () => [200, { ok: true, bootMs: 300 }] };
    calls.fetch.length = 0;
    const out = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'server.js', content: 'v3' }], summary: 'Notes field', deps,
    });
    assert.equal(out.ok, true);
    assert.equal(calls.compare, `${SHA('1')}...${out.head}`);
    const applied = calls.fetch.find((c) => c.method === 'POST').body;
    assert.deepEqual(applied.files.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'gone.js', delete: true },
      { path: 'public/index.html', content: '<p>one</p>' },
      { path: 'server.js', content: 'v3' },
    ]);
  });

  await t.test('an edit that stops the app says why, and the draft remembers it', async () => {
    const draft = await theDraft();
    preview = { status: { head: draft.headSha }, apply: () => [200, { ok: false, why: 'exited', log: 'SyntaxError: Unexpected token' }] };
    const out = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'server.js', content: 'oops(' }], summary: 'Broken', deps,
    });
    assert.equal(out.ok, true, 'the edit is saved');
    assert.deepEqual([out.preview.ok, out.preview.crashed, out.preview.log], [false, true, 'SyntaxError: Unexpected token']);
    assert.match((await liveDrafts.byId(pool, draft.id)).last_error, /stopped the app/);
    assert.equal(calls.ws[calls.ws.length - 1].payload.reload, false);
  });

  await t.test('a new install, or no preview to reach, builds the draft again', async () => {
    let draft = await theDraft();
    preview = { status: { head: draft.headSha }, apply: () => [409, { ok: false, needsRebuild: true, why: 'install' }] };
    calls.preview.length = 0;
    const out = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'package.json', content: '{"dependencies":{"pg":"^8"}}' }], summary: 'Add pg', deps,
    });
    assert.deepEqual([out.preview.rebuilding, out.preview.why], [true, 'install']);
    assert.deepEqual([calls.preview[0].reason, calls.preview[0].head], ['preview', out.head]);
    draft = liveDrafts.describe(await liveDrafts.byId(pool, draft.id));
    assert.equal(draft.live, 'rebuilding');
    // Proposing waits for that preview.
    const early = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.deepEqual([early.status, early.body.error], [409, 'preview_building']);
    // Once it serves the head, it is live again.
    await publish(draft, out.head);
    assert.equal(liveDrafts.describe(await liveDrafts.byId(pool, draft.id)).live, 'live');

    preview = null;
    calls.preview.length = 0;
    const gone = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'server.js', content: 'v4' }], summary: 'Fix', deps,
    });
    assert.deepEqual([gone.preview.rebuilding, gone.preview.why], [true, 'unreachable']);
    assert.equal(calls.preview.length, 1);
    await publish(draft, gone.head);
  });

  await t.test('an edit is refused once drafts are off, and for a draft that is not open or not theirs', async () => {
    const draft = await theDraft();
    const stranger = await user();
    assert.equal((await liveDrafts.applyEdit(pool, CONFIG, { draftId: draft.id, userId: stranger.id, files: [{ path: 'a.js', content: '' }], deps })).ok, false);
    assert.equal((await liveDrafts.applyEdit(pool, CONFIG, { draftId: draft.id, userId: person.id, files: [{ path: '../a.js', content: '' }], deps })).ok, false);
    await liveDrafts.setEnabled(pool, { on: false });
    assert.equal((await liveDrafts.applyEdit(pool, CONFIG, { draftId: draft.id, userId: person.id, files: [{ path: 'a.js', content: '' }], deps })).ok, false);
    await liveDrafts.setEnabled(pool, { on: true });
  });

  await t.test('Propose is the person\'s own promote, with what the edits said', async () => {
    const draft = await theDraft();
    promoteReply = { status: 409, body: { error: 'promoted_cap' } };
    const refused = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.equal(refused.status, 409);
    assert.equal((await liveDrafts.byId(pool, draft.id)).state, 'open', 'a refused promote leaves it open');
    promoteReply = { status: 200, body: { ok: true, status: 'promoted' } };
    const out = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.draft.state, 'proposed');
    const asked = calls.promote[calls.promote.length - 1];
    assert.deepEqual([asked.sessionId, asked.userId, asked.from, asked.pr], [draft.sessionId, person.id, 'paused', null]);
    const { rows: [s] } = await pool.query('SELECT session_title FROM chat_sessions WHERE id = $1', [draft.sessionId]);
    assert.equal(s.session_title, 'Fix');
    const { rows: msgs } = await pool.query('SELECT role, content FROM chat_session_messages WHERE session_id = $1', [draft.sessionId]);
    assert.match(msgs[msgs.length - 1].content, /- Bigger start button\n- Notes field/);
    // No longer open: no edits, no supervisor on its next preview, its thread answered as any other.
    assert.equal((await liveDrafts.applyEdit(pool, CONFIG, { draftId: draft.id, userId: person.id, files: [{ path: 'a.js', content: '' }], deps })).ok, false);
    assert.equal(await liveDrafts.forThread(pool, { userId: person.id, rootId: draft.rootId }), null);
  });

  await t.test('Propose needs an edit; Close puts a draft away', async () => {
    const root = await thread(person, project);
    const { body: { draft } } = await liveDrafts.open(pool, CONFIG, { user: person, rootId: root, deps });
    await publish(draft);
    const none = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.deepEqual([none.status, none.body.error], [409, 'no_edits']);
    const closed = await liveDrafts.close(pool, { user: person, draftId: draft.id, deps });
    assert.equal(closed.body.draft.state, 'closed');
    assert.equal((await liveDrafts.close(pool, { user: person, draftId: draft.id, deps })).status, 404);
  });
});
