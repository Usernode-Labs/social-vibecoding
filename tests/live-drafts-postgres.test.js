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
const draftBot = require('../src/services/live-draft-bot');
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

// #6961: the one rule open() and the thread's GET share.
test('draftableFor: every project, and Homeroom itself only to its admins', () => {
  const member = { id: 1 };
  const admin = { id: 2, isAdmin: true };
  assert.deepEqual(liveDrafts.draftableFor(CONFIG, { slug: 'gym', self_hosted: false }, member), { ok: true });
  assert.deepEqual(liveDrafts.draftableFor(CONFIG, { slug: 'gym', self_hosted: false }, admin), { ok: true });
  const refused = liveDrafts.draftableFor(CONFIG, { slug: 'usernode-self', self_hosted: true }, member);
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 403, 'admins_only']);
  assert.equal(refused.message, "Only Homeroom's admins can open a live draft of Homeroom itself. You can file a request for it instead.");
  assert.deepEqual(liveDrafts.draftableFor(CONFIG, { slug: 'usernode-self', self_hosted: true }, admin), { ok: true });
  // The platform is known by its slug, whether or not the row says self_hosted.
  assert.deepEqual(liveDrafts.draftableFor(CONFIG, { slug: 'usernode-self', self_hosted: false }, admin), { ok: true });
  assert.equal(liveDrafts.draftableFor(CONFIG, { slug: 'usernode-self' }, member).code, 'admins_only');
  // Any other self-hosted app keeps its refusal, admins included.
  assert.equal(liveDrafts.draftableFor(CONFIG, { slug: 'another-self', self_hosted: true }, admin).code, 'not_supported');
  // With no platform named, nothing is the self app.
  assert.equal(liveDrafts.draftableFor({}, { slug: 'usernode-self', self_hosted: true }, admin).code, 'not_supported');
  assert.equal(liveDrafts.draftableFor(CONFIG, null, admin).code, 'no_project');
});

// #6961: the platform's image runs some of its files from source and some
// only as their built result.
test('platformRunsInPlace: Homeroom\'s server code runs in place; its built screens do not', () => {
  assert.equal(liveDrafts.platformRunsInPlace(['src/services/x.js']), true);
  assert.equal(liveDrafts.platformRunsInPlace(['server.js', 'worker/run.js', 'app-templates/a/x.js', 'dapp.json']), true);
  assert.equal(liveDrafts.platformRunsInPlace(['src/db/migrations/a.sql']), false);
  assert.equal(liveDrafts.platformRunsInPlace(['frontend/src/x.tsx']), false);
  assert.equal(liveDrafts.platformRunsInPlace(['public/css/app.css']), false);
  assert.equal(liveDrafts.platformRunsInPlace(['styles/tailwind-input.css']), false);
  assert.equal(liveDrafts.platformRunsInPlace(['src/services/x.js', 'frontend/src/x.tsx']), false, 'one built file means one build');
  assert.equal(liveDrafts.platformRunsInPlace([]), true);
});

test('sendToPreview: a built file on Homeroom itself builds the preview again, never writes it in place (#6961)', async () => {
  const head = SHA('a');
  const at = SHA('b');
  const asked = [];
  const sent = [];
  const draft = {
    id: 7, session_id: 70, app_slug: 'usernode-self', head_sha: at, staging_commit_sha: at,
    staging_runtime_kind: 'docker', staging_runtime_name: 'usernode-staging-s70',
  };
  const pool = {
    async query(sql) {
      if (/SELECT \* FROM chat_sessions/.test(sql)) return { rows: [{ id: 70 }] };
      return { rows: [] };
    },
  };
  const deps = {
    previewWorkflow: { async request(args) { asked.push(args); return { status: 'accepted' }; } },
    fetch: async (href, init = {}) => {
      sent.push({ href, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      return { status: 200, json: async () => ({ ok: true, head: at }) };
    },
  };
  const out = await liveDrafts.sendToPreview(pool, CONFIG, {
    draft, files: [{ path: 'frontend/src/App.tsx', content: 'x' }], since: at, head, deps,
  });
  assert.deepEqual([out.ok, out.rebuilding, out.why], [true, true, 'built_files']);
  assert.equal(asked.length, 1, 'the preview machine builds it again');
  assert.ok(!sent.some((c) => c.method === 'POST'), 'nothing is written into the running preview');
  // Its server code still restarts in place, in seconds.
  const live = await liveDrafts.sendToPreview(pool, CONFIG, {
    draft, files: [{ path: 'src/services/x.js', content: 'x' }], since: at, head, deps,
  });
  assert.equal(live.ok, true);
  assert.equal(asked.length, 1);
  const written = sent.find((c) => c.method === 'POST');
  assert.ok(written, 'written in place');
  assert.deepEqual(written.body.files, [{ path: 'src/services/x.js', content: 'x' }]);
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
  // C: a branch made from another change's starts at that one's head.
  const branchHeads = new Map();
  const github = {
    async getBranchSha(owner, repo, branch) { return branchHeads.get(branch) || SHA('1'); },
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
    async ensureSessionBranch({ pool: p, sessionId, fromSessionId = null }) {
      const branchName = `dev/draft-${sessionId}`;
      await p.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [sessionId, branchName]);
      if (fromSessionId) {
        const { rows: [d] } = await p.query('SELECT head_sha FROM live_drafts WHERE session_id = $1', [fromSessionId]);
        calls.branchFrom = { sessionId, fromSessionId };
        branchHeads.set(branchName, d.head_sha);
      }
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
  // C: Update proposal's conductor operation, recorded.
  let operationReply = { ok: true, updated: true, rebuilding: true };
  const platformOperations = { async request(args) { calls.operations = [...(calls.operations || []), args]; return operationReply; } };
  // C: the line a draft's thread is told when it closes on its own.
  const said = [];
  const dm = { async botAccount() { return { id: 1 }; }, async sendDm(_p, args) { said.push(args); return { messageId: 1 }; } };
  const deps = {
    github, sessionLifecycle: lifecycle, previewWorkflow, fetch: fakeFetch, ws, platform, platformOperations, dm,
    appAccess: { ...require('../src/services/app-access'), checkAppAccess: async () => true },
    communities: { appNeedsJoin: async () => null },
  };
  // The preview machine published the draft's preview (services/staging.js does this on deploy).
  const publish = (draft, head = SHA('1')) => pool.query(
    `UPDATE chat_sessions SET staging_url = 'https://x--s1.example', staging_runtime_kind = 'docker',
       staging_runtime_name = $2, staging_commit_sha = $3 WHERE id = $1`, [draft.sessionId, `usernode-staging-s${draft.sessionId}`, head]);

  const person = await user();
  const project = await app();
  // #6961: Homeroom itself, and public to collaborate on, so only the admin
  // gate can refuse a non-admin (the stand-in app-access says yes to all).
  const selfApp = await app({ slug: 'usernode-self' });
  await pool.query("UPDATE apps SET collab_visibility = 'public' WHERE id = $1", [selfApp.id]);
  const adminUser = async () => (await pool.query(
    `INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', TRUE)
     RETURNING id, username, is_admin AS "isAdmin"`, [`ld_admin_${++seq}`])).rows[0];

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
    const selfRoot = await thread(person, selfApp);
    // #6961: Homeroom's own app, so a non-admin is refused for that alone.
    assert.equal((await liveDrafts.open(pool, CONFIG, { user: person, rootId: selfRoot, deps })).body.error, 'admins_only');
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

  await t.test('Propose is the person\'s own promote, as a change of its own: the draft stays (C)', async () => {
    const draft = await theDraft();
    promoteReply = { status: 409, body: { error: 'promoted_cap' } };
    const refused = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.equal(refused.status, 409);
    assert.equal((await liveDrafts.byId(pool, draft.id)).state, 'open', 'a refused promote leaves it open');
    const { rows: [{ n: left }] } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM chat_sessions WHERE app_id = $1 AND session_title = 'Fix'", [project.id]);
    assert.equal(left, 0, 'and leaves no proposal behind');
    promoteReply = { status: 200, body: { ok: true, status: 'promoted' } };
    const out = await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.draft.state, 'proposed');
    // The proposal is a change of its own, its branch made from the draft's.
    const asked = calls.promote[calls.promote.length - 1];
    assert.notEqual(asked.sessionId, draft.sessionId);
    assert.deepEqual([asked.userId, asked.from, asked.pr], [person.id, 'paused', null]);
    assert.deepEqual(calls.branchFrom, { sessionId: asked.sessionId, fromSessionId: draft.sessionId });
    const { rows: [s] } = await pool.query('SELECT session_title FROM chat_sessions WHERE id = $1', [asked.sessionId]);
    assert.equal(s.session_title, 'Fix');
    const { rows: msgs } = await pool.query('SELECT role, content FROM chat_session_messages WHERE session_id = $1', [asked.sessionId]);
    assert.match(msgs[msgs.length - 1].content, /- Bigger start button\n- Notes field/);
    const head = (await liveDrafts.byId(pool, draft.id)).head_sha;
    assert.deepEqual(out.body.draft.proposal, { sessionId: asked.sessionId, prNumber: null, open: true, pending: 0, headSha: head });
    // Still this thread's draft: editable, its supervisor kept, and a second Propose is refused.
    assert.equal(out.body.draft.editable, true);
    assert.equal((await liveDrafts.forThread(pool, { userId: person.id, rootId: draft.rootId, deps })).id, draft.id);
    assert.deepEqual((await liveDrafts.propose(pool, CONFIG, { user: person, draftId: draft.id, deps })).body.error, 'already_proposed');
    // Opened again (open_app_preview), the same draft: never a second one from main.
    const again = await liveDrafts.open(pool, CONFIG, { user: person, rootId: draft.rootId, deps });
    assert.deepEqual([again.body.reused, again.body.draft.id, again.body.draft.state], [true, draft.id, 'proposed']);
    // Nothing new yet: Update proposal has nothing to move.
    assert.equal((await liveDrafts.updateProposal(pool, CONFIG, { user: person, draftId: draft.id, deps })).body.error, 'nothing_new');
  });

  await t.test('an edit after Propose stays on the draft until Update proposal moves the proposal (C)', async () => {
    const draft = liveDrafts.describe(await liveDrafts.forThread(pool, {
      userId: person.id, rootId: (await pool.query("SELECT root_message_id FROM live_drafts WHERE state = 'proposed'")).rows[0].root_message_id, deps,
    }));
    await pool.query("UPDATE chat_sessions SET status = 'promoted', pr_number = 142 WHERE id = $1", [draft.proposal.sessionId]);
    preview = { status: { head: draft.headSha }, apply: () => [200, { ok: true, bootMs: 50 }] };
    const out = await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'public/index.html', content: '<p>wider rows</p>' }], summary: 'Wider rows', deps,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const now = liveDrafts.describe(await liveDrafts.byId(pool, draft.id));
    assert.deepEqual([now.proposal.pending, now.prNumber, now.proposal.open], [1, 142, true], '1 change not in the proposal yet');
    calls.operations = [];
    const updated = await liveDrafts.updateProposal(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(calls.operations.map((o) => [o.op, o.input]), [['draft.update', {
      draftId: draft.id, sessionId: draft.proposal.sessionId, head: out.head,
    }]]);
    // The operation moves proposed_head_sha on the conductor; stand in for it.
    await pool.query('UPDATE live_drafts SET proposed_head_sha = $2 WHERE id = $1', [draft.id, out.head]);
    assert.equal(liveDrafts.describe(await liveDrafts.byId(pool, draft.id)).proposal.pending, 0);
    // A refusal on the conductor is said, not swallowed.
    await liveDrafts.applyEdit(pool, CONFIG, {
      draftId: draft.id, userId: person.id, files: [{ path: 'server.js', content: 'v5' }], summary: 'Hover tint', deps,
    });
    operationReply = { ok: false, status: 409, code: 'branch_moved', error: 'The proposal changed since this draft was proposed.' };
    const moved = await liveDrafts.updateProposal(pool, CONFIG, { user: person, draftId: draft.id, deps });
    assert.deepEqual([moved.status, moved.body.error], [409, 'branch_moved']);
    operationReply = { ok: true, updated: true, rebuilding: true };
  });

  await t.test('a draft closes when its proposal goes live or is withdrawn, and when it sat idle with no edits (C)', async () => {
    const { rows: [row] } = await pool.query("SELECT id, root_message_id, proposal_session_id FROM live_drafts WHERE state = 'proposed'");
    said.length = 0;
    await pool.query("UPDATE chat_sessions SET status = 'merged' WHERE id = $1", [row.proposal_session_id]);
    assert.equal(await liveDrafts.forThread(pool, { userId: person.id, rootId: row.root_message_id, deps }), null);
    assert.equal((await liveDrafts.byId(pool, row.id)).state, 'closed');
    assert.equal(said.length, 1, 'its thread is told in one line');
    assert.equal(said[0].threadRootId, Number(row.root_message_id));
    assert.match(said[0].content, /went live/);

    // A draft with no edits that nobody touched for IDLE_CLOSE_MS frees its slot.
    const root = await thread(person, project);
    const { body: { draft: idle } } = await liveDrafts.open(pool, CONFIG, { user: person, rootId: root, deps });
    const later = { ...deps, now: () => Date.now() + liveDrafts.IDLE_CLOSE_MS + 60_000 };
    assert.equal(await liveDrafts.forThread(pool, { userId: person.id, rootId: root, deps: later }), null);
    assert.equal((await liveDrafts.byId(pool, idle.id)).state, 'closed');
    assert.match(said[said.length - 1].content, /closed after two hours/);
    // closeReason is pure: an edited draft never idles out.
    assert.equal(liveDrafts.closeReason({ state: 'open', edits: 2, updated_at: new Date(0) }), null);
    assert.equal(liveDrafts.closeReason({ state: 'proposed', proposal_session_id: 3, proposal_status: 'closed' }), 'proposal_ended');
  });

  await t.test('a comment pinned on the preview is checked against the thread\'s draft (J)', async () => {
    const { body: { draft } } = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, project), deps });
    const ok = await liveDrafts.pinFor(pool, {
      user: person, threadRootId: draft.rootId, deps,
      pin: { draftId: draft.id, x: 0.42, y: 0.183333, route: '/workouts?x=1', viewport: { width: 390, height: 844 },
        element: { tag: 'button', id: 'del', text: 'Delete   workout' } },
    });
    assert.deepEqual(ok, {
      draftId: draft.id, x: 0.42, y: 0.1833, route: '/workouts?x=1', viewport: { width: 390, height: 844 },
      element: { tag: 'button', id: 'del', text: 'Delete workout' },
    });
    assert.equal(await liveDrafts.pinFor(pool, { user: person, threadRootId: draft.rootId, pin: { draftId: draft.id + 99, x: 0.5, y: 0.5 }, deps }), null);
    assert.equal(await liveDrafts.pinFor(pool, { user: person, threadRootId: draft.rootId, pin: { draftId: draft.id, x: 2, y: 0.5 }, deps }), null);
    const loose = await liveDrafts.pinFor(pool, { user: person, threadRootId: draft.rootId, pin: { draftId: draft.id, x: 0, y: 1, route: '//evil.example', viewport: { width: 9, height: 9 } }, deps });
    assert.deepEqual(loose, { draftId: draft.id, x: 0, y: 1 }, 'a route that is not the app\'s, and a size that is not a view, are left out');
    assert.match(liveDrafts.pinLine({ content: 'make this red', pin: ok }), /^\[Pinned on the app's live preview, 42% across and 18% down of a 390x844 view, on \/workouts\?x=1, on <button> "Delete workout"\. .*\] make this red$/);
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

  await t.test('a draft says Homeroom\'s failures as Homeroom\'s, and an app that stopped as the app\'s', async () => {
    const root = await thread(person, project);
    const opened = await liveDrafts.open(pool, CONFIG, { user: person, rootId: root, deps });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const draft = opened.body.draft;
    await publish(draft);
    let session = await draftBot.openSession(pool, CONFIG, { user: person, draft: await liveDrafts.byId(pool, draft.id), deps });
    assert.ok(!session.refused, session.refused);
    const applyChange = async (name) => {
      const wrote = await session.run('write_file', { path: `draft-${name}.js`, content: `// ${name}\n` });
      assert.equal(wrote.ok, true, JSON.stringify(wrote));
      return session.run('apply_changes', { summary: name });
    };
    // The supervisor answers as this draft's head, then `applyAnswer`.
    const serve = async (applyAnswer) => {
      const before = await liveDrafts.byId(pool, draft.id);
      preview = { status: { head: before.head_sha }, apply: () => applyAnswer };
    };

    // (a) The supervisor cannot be reached and the preview machine refuses
    // to build again. Both are Homeroom's, so four applies all run: none of
    // them spends a try.
    preview = null;
    const realRequest = previewWorkflow.request;
    previewWorkflow.request = async () => ({ status: 'rejected', reason: 'quota_exceeded' });
    try {
      for (let i = 0; i < 4; i += 1) {
        const out = await applyChange(`unreachable-${i}`);
        assert.equal(out.preview, 'platform', JSON.stringify(out));
        assert.match(out.note, /Homeroom had a problem on its side/);
        assert.match(out.note, /asking again in a few minutes/i);
      }
    } finally {
      previewWorkflow.request = realRequest;
    }

    // (b) The supervisor answers 500: platform words, and no try is spent.
    for (let i = 0; i < 4; i += 1) {
      await serve([500, { error: 'supervisor exploded' }]);
      const out = await applyChange(`supervisor-${i}`);
      assert.equal(out.preview, 'platform', JSON.stringify(out));
      assert.match(out.note, /Homeroom had a problem on its side/);
      assert.match(out.note, /Saved in the draft/);
    }

    // (c) The preview is refused when a draft opens: it never started, and
    // the incident is recorded for the team.
    const seen = [];
    const incidents = {
      KINDS: require('../src/services/platform-incidents').KINDS,
      async record(_p, args) { seen.push(args); return 1; },
    };
    previewWorkflow.request = async () => ({ status: 'rejected', reason: 'quota_exceeded' });
    try {
      const another = await user();
      const anotherProject = await app();
      const refused = await liveDrafts.open(pool, CONFIG, {
        user: another, rootId: await thread(another, anotherProject), deps: { ...deps, incidents },
      });
      assert.equal(refused.status, 200, JSON.stringify(refused.body));
      assert.equal(refused.body.draft.live, 'failed');
      assert.ok(seen.some((i) => i.detail.cause === 'quota_exceeded'), JSON.stringify(seen));
    } finally {
      previewWorkflow.request = realRequest;
    }

    // (d) The app stopped after an edit: its log comes back, and the try counts.
    for (let i = 0; i < 3; i += 1) {
      await serve([200, { ok: false, why: 'exited', log: 'ReferenceError: boom' }]);
      const out = await applyChange(`stopped-${i}`);
      assert.equal(out.preview, 'crashed', JSON.stringify(out));
      assert.match(out.log, /ReferenceError: boom/);
      assert.match(out.note, /did not start/);
    }
    const over = await applyChange('over');
    assert.equal(over.ok, false);
    assert.match(over.error, /That is 3 applies this turn/);

    // A new turn (its applies counted from none) for what the preview itself says.
    session = await draftBot.openSession(pool, CONFIG, { user: person, draft: await liveDrafts.byId(pool, draft.id), deps });
    assert.ok(!session.refused, session.refused);

    // (e) A new install: the preview is built again, about a minute or two.
    await serve([409, { ok: false, needsRebuild: true, why: 'install' }]);
    const install = await applyChange('install');
    assert.equal(install.preview, 'rebuilding', JSON.stringify(install));
    assert.match(install.note, /minute or two/);

    // (f) The app's own build step failed: that is the app's own failure.
    await serve([409, { ok: false, needsRebuild: true, why: 'build', log: 'npm ERR! build failed' }]);
    const build = await applyChange('build');
    assert.equal(build.preview, 'crashed', JSON.stringify(build));
    assert.match(build.log, /npm ERR! build failed/);
    assert.match(build.note, /its build/);
  });

  // #6961: a live draft of Homeroom itself, for an admin who can change it.
  await t.test('Homeroom itself is draftable by its admins only, and holds a slot like any project', async () => {
    const counts = async () => ({
      sessions: (await pool.query('SELECT COUNT(*)::int AS n FROM chat_sessions')).rows[0].n,
      drafts: (await pool.query('SELECT COUNT(*)::int AS n FROM live_drafts')).rows[0].n,
    });
    // A non-admin is refused, and nothing is written for them.
    const before = await counts();
    const refused = await liveDrafts.open(pool, CONFIG, { user: person, rootId: await thread(person, selfApp), deps });
    assert.deepEqual([refused.status, refused.body.error], [403, 'admins_only']);
    assert.match(refused.body.message, /Only Homeroom's admins can open a live draft of Homeroom itself/);
    assert.deepEqual(await counts(), before, 'no change and no draft for them');

    // An admin gets one, as any project's.
    const admin = await adminUser();
    const first = await liveDrafts.open(pool, CONFIG, { user: admin, rootId: await thread(admin, selfApp), deps });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.draft.app.slug, 'usernode-self');

    // Another self-hosted app is still refused, admins included.
    const otherSelf = await app({ slug: 'another-self' });
    await pool.query('UPDATE apps SET self_hosted = TRUE WHERE id = $1', [otherSelf.id]);
    const notSupported = await liveDrafts.open(pool, CONFIG, { user: admin, rootId: await thread(admin, otherSelf), deps });
    assert.deepEqual([notSupported.status, notSupported.body.error], [409, 'not_supported']);

    // Two open at once, as across all projects: the Homeroom draft counts.
    const second = await liveDrafts.open(pool, CONFIG, { user: admin, rootId: await thread(admin, project), deps });
    assert.equal(second.status, 200);
    const third = await liveDrafts.open(pool, CONFIG, { user: admin, rootId: await thread(admin, selfApp), deps });
    assert.deepEqual([third.status, third.body.error], [409, 'too_many']);
    await liveDrafts.close(pool, { user: admin, draftId: first.body.draft.id, deps });
    await liveDrafts.close(pool, { user: admin, draftId: second.body.draft.id, deps });
  });
});
