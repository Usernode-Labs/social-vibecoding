'use strict';

// An outside coding agent's change to an app on Homeroom's own git host, end
// to end: prepare_work, the agent's patch, a native proposal, then an update
// to it and an update refused because the proposal moved.
//
// Real PostgreSQL (the whole schema), real git: a bare repository over
// file:// stands in for Forgejo, as in native-pulls-postgres.test.js, and the
// real mirror (services/repo-mirror.js), patch apply
// (services/external-agent-patch.js), native pull requests
// (services/native-pulls.js) and update route (services/proposal-update.js)
// run against it. Stubbed: the pr-import loopback (it writes the session row
// the route would) and the imported-head sync after an update. No GitHub
// link exists at all, and no GitHub request is ever made.
//
// TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-host-'));
process.env.USERNODE_MIRROR_ROOT = path.join(root, 'mirrors');
fs.mkdirSync(process.env.USERNODE_MIRROR_ROOT);

const github = require('../src/services/github');
const gitHost = require('../src/services/git-host');
const requests = require('../src/services/requests');
const svc = require('../src/services/external-agent-tasks');
const proposalUpdate = require('../src/services/proposal-update');
const patchUploads = require('../src/services/external-agent-patch-upload');
const commitIdentity = require('../src/services/commit-identity');

const ORIGIN = 'https://usernode.example';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.test', ...args])
    .toString().trim();
}

// A deployment with no GitHub OAuth app, and no link to read: none is needed.
const noLink = {
  isEnabled: () => false,
  linkStatus: async () => { throw new Error('a git-host app never reads the GitHub link'); },
};
const okLimits = { checkOpenWorkOrders: async () => null, checkPromotedCap: async () => null };

test('a git-host app: prepare, patch, native proposal, update, moved head', { timeout: 180000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'agent_git_host_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const env = {
    GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: `file://${root}/host`, GIT_HOST_ORG: 'apps',
    GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok', USERNODE_DOMAIN: 'usernode.example',
  };
  const prior = {};
  for (const [k, v] of Object.entries(env)) { prior[k] = process.env[k]; process.env[k] = v; }
  const realFetch = global.fetch;
  global.fetch = async (u) => { throw new Error(`no network on this path: ${u}`); };
  t.after(async () => {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    requests._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  requests._resetForTests();
  requests.setPool(pool);
  const { rows: [userRow] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id, username`);
  const user = { id: userRow.id, username: userRow.username };
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Tide Log', 'tide-log', 'https://git.example.test/apps/tide-log')
     RETURNING id, name, slug, repo_url`);

  // The git host: apps/tide-log.git with main.
  const bare = path.join(root, 'host', 'apps', 'tide-log.git');
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', '-q', bare, seed]);
  fs.writeFileSync(path.join(seed, 'index.html'), '<p>High tide</p>\n');
  fs.writeFileSync(path.join(seed, 'app.js'), 'console.log("tides");\n');
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'first'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  const main0 = sh(seed, 'rev-parse', 'HEAD');

  const deps = { pool, config: {}, gh: github, githubLink: noLink, limits: okLimits, prompts: null };

  // The pr-import loopback, as the route would answer it: the session row
  // for the native pull request, read back through github.js like the route.
  const imports = [];
  const importProposal = async (slug, prNumber, extra = {}) => {
    const pr = await github.getPR('apps', 'tide-log', prNumber);
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, source,
          imported_pr_head_sha, handoff_base_sha, imported_pr_author, imported_pr_head_repo,
          promoted_at, shared_at, linked_issues)
       VALUES ($1, $2, $3, $4, $5, $6, 'promoted', 'imported', $7, $8, $9, $10, NOW(), NOW(), $11)
       RETURNING id`,
      [app.id, user.id, pr.head.ref, pr.number, pr.html_url, pr.title, pr.head.sha, pr.base.sha,
        pr.user.login, pr.head.repo.full_name, extra.linkedIssues || []]);
    imports.push({ slug, prNumber, sessionId: row.id });
    return { ok: true, status: 200, body: { sessionId: row.id } };
  };

  // The agent's side: a clone at the base, a commit, the patch.
  const agentPatch = (dir, base, edit) => {
    if (!fs.existsSync(dir)) execFileSync('git', ['clone', '-q', bare, dir]);
    sh(dir, 'fetch', '-q', 'origin', base);
    sh(dir, 'checkout', '-q', '-B', 'work', base);
    edit(dir);
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'Bold the high tide');
    return { patch: sh(dir, 'format-patch', `${base}..HEAD`, '--stdout') + '\n', tree: sh(dir, 'rev-parse', 'HEAD^{tree}') };
  };
  const hostTree = (sha) => execFileSync('git', ['-C', bare, 'rev-parse', `${sha}^{tree}`]).toString().trim();
  const hostLog = (sha, fmt) => execFileSync('git', ['-C', bare, 'log', '-1', `--format=${fmt}`, sha]).toString().trim();

  // ── prepare_work ────────────────────────────────────────────────────
  const prepared = await svc.prepareWork(deps, {
    user, app, brief: 'Show the high tide in bold', clientName: 'Claude', origin: ORIGIN, patchUpload: true,
  });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.repoHost, 'git_host');
  assert.equal(prepared.baseSha, main0, 'the base is main on the git host');
  assert.equal(prepared.cloneUrl, 'https://git.example.test/apps/tide-log.git', 'the public clone address');
  assert.ok(prepared.workOrder.includes(`git clone ${prepared.cloneUrl} tide-log`));
  assert.ok(prepared.workOrder.includes(`git format-patch ${main0}..HEAD --stdout`));
  assert.doesNotMatch(prepared.workOrder, /git push|gh repo fork/);

  // ── submit_work with the patch: a native proposal ──────────────────
  const first = agentPatch(path.join(root, 'agent'), main0, (dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<p><b>High tide</b></p>\n');
  });
  const submitted = await svc.submitWork(deps, {
    user, taskId: prepared.taskId, patch: first.patch, agent: 'claude-code', source: 'work_order',
    title: 'Bold the high tide', importProposal,
  });
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.submittedVia, 'patch');
  assert.ok(submitted.prNumber > 0);
  assert.equal(submitted.proposalId, imports[0].sessionId);

  const pr = await github.getPR('apps', 'tide-log', submitted.prNumber);
  assert.equal(pr.state, 'open');
  assert.match(pr.head.ref, /^usernode\/patch-/);
  assert.equal(pr.html_url, `https://usernode.example/#app/tide-log/dev/changes/${submitted.prNumber}`);
  assert.equal(hostTree(pr.head.sha), first.tree, 'the head tree is the base plus the patch');
  assert.equal(hostLog(pr.head.sha, '%P'), main0);
  assert.equal(hostLog(pr.head.sha, '%an <%ae>'), 'Ada <ada@example.test>', 'the patch keeps its author');
  const homeroom = commitIdentity.homeroomAuthor();
  assert.equal(hostLog(pr.head.sha, '%cn <%ce>'), `${homeroom.name} <${homeroom.email}>`, 'Homeroom commits it');
  assert.equal(await gitHost.readRef('tide-log', 'main'), main0, 'main is untouched');
  const { rows: [task1] } = await pool.query('SELECT * FROM external_agent_tasks WHERE id = $1', [prepared.taskId]);
  assert.equal(task1.status, 'submitted');
  assert.equal(task1.submitted_via, 'patch');
  assert.equal(Number(task1.session_id), submitted.proposalId);
  const { rows: [badge] } = await pool.query('SELECT external_agent, user_id FROM chat_sessions WHERE id = $1', [submitted.proposalId]);
  assert.equal(badge.external_agent, 'claude-code');
  assert.equal(badge.user_id, user.id, 'attributed to the Homeroom user');

  // ── the same through an upload (patchUploadId) ─────────────────────
  const second = await svc.prepareWork(deps, {
    user, app, brief: 'Log each tide', clientName: 'Claude', origin: ORIGIN, patchUpload: true,
  });
  assert.equal(second.ok, true, second.message);
  const token = /Bearer (svpu_[A-Za-z0-9_-]{43})/.exec(second.workOrder)[1];
  const auth = await patchUploads.authenticateUpload(pool, { taskId: second.taskId, token });
  assert.equal(auth.ok, true, auth.message);
  const uploaded = agentPatch(path.join(root, 'agent2'), main0, (dir) => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("tides");\nconsole.log("logged");\n');
  });
  const stored = await patchUploads.storeUpload(pool, {
    taskId: second.taskId, tokenId: auth.tokenId, body: Buffer.from(uploaded.patch, 'utf8'),
  });
  assert.equal(stored.ok, true, stored.message);
  const viaUpload = await svc.submitWork(deps, {
    user, taskId: second.taskId, patchUploadId: stored.uploadId, agent: 'claude-code', importProposal,
  });
  assert.equal(viaUpload.ok, true, viaUpload.message);
  assert.notEqual(viaUpload.prNumber, submitted.prNumber);
  const pr2 = await github.getPR('apps', 'tide-log', viaUpload.prNumber);
  assert.equal(hostTree(pr2.head.sha), uploaded.tree);

  // ── a pushed branch for this app is refused with the patch call ────
  const third = await svc.prepareWork(deps, { user, app, brief: 'Something else', clientName: 'Claude', origin: ORIGIN });
  const branchShape = await svc.submitWork(deps, { user, taskId: third.taskId, branch: 'my-work', importProposal });
  assert.equal(branchShape.code, 'patch_required');

  // ── an update work order, based at the proposal's head ─────────────
  const loadSession = async (id) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [id])).rows[0];
  const update = await svc.prepareWork(deps, {
    user, app, brief: 'Italic too', clientName: 'Claude', origin: ORIGIN,
    targetProposal: await loadSession(submitted.proposalId),
  });
  assert.equal(update.ok, true, update.message);
  assert.equal(update.proposalId, submitted.proposalId);
  assert.equal(update.baseSha, pr.head.sha, 'the base is the proposal\'s head on the git host');

  // The update route's loopback, against the real service. Only the
  // imported-head sync that follows a push is stubbed.
  const syncs = [];
  const updateProposal = async (slug, id, payload) => {
    const result = await proposalUpdate.updateProposalFromForkBranch({
      pool, config: {}, gh: github, githubLink: noLink,
      prImportSync: {
        syncImportedProposal: async ({ session }) => { syncs.push(session.id); return 'updated'; },
        reconcileImportedHead: async () => null,
      },
      votes: { reconcileNativeReviewedHead: async () => null },
      busy: async () => false,
      beginOperation: () => () => {},
      lock: (p, sessionId, fn) => fn(),
    }, {
      user, session: await loadSession(id), branch: payload.branch, patch: payload.patch,
      expectedHeadSha: payload.expectedHeadSha, title: payload.title, description: payload.description,
      linkedIssues: payload.linkedIssues, origin: ORIGIN,
    });
    return result.ok
      ? { ok: true, status: 200, body: result }
      : { ok: false, status: 409, body: { error: result.code, message: result.message, headSha: result.headSha } };
  };

  const revision = agentPatch(path.join(root, 'agent'), pr.head.sha, (dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<p><b><i>High tide</i></b></p>\n');
  });
  const updated = await svc.submitWork(deps, {
    user, taskId: update.taskId, patch: revision.patch, agent: 'claude-code', updateProposal,
  });
  assert.equal(updated.ok, true, updated.message);
  assert.equal(updated.update, true);
  assert.equal(updated.proposalId, submitted.proposalId, 'the same proposal, never a second one');
  assert.equal(updated.previousHeadSha, pr.head.sha);
  assert.equal(updated.submittedVia, 'update_patch');
  assert.equal(await gitHost.readRef('tide-log', pr.head.ref), updated.headSha, 'its branch moved there');
  assert.equal(hostLog(updated.headSha, '%P'), pr.head.sha, 'on top of the head it was made from');
  assert.equal(hostTree(updated.headSha), revision.tree);
  assert.deepEqual(syncs, [submitted.proposalId], 'the imported head is re-read, which resets the votes');
  assert.equal((await github.getPR('apps', 'tide-log', submitted.prNumber)).head.sha, updated.headSha);
  const { rows: [task2] } = await pool.query('SELECT base_sha, status FROM external_agent_tasks WHERE id = $1', [update.taskId]);
  assert.equal(task2.base_sha, updated.headSha, 'the next patch starts from the head this one landed');

  // ── somebody moves the proposal meanwhile: refused, not overwritten ─
  const late = agentPatch(path.join(root, 'agent'), updated.headSha, (dir) => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("late");\n');
  });
  const other = path.join(root, 'other');
  execFileSync('git', ['clone', '-q', '-b', pr.head.ref, bare, other]);
  fs.writeFileSync(path.join(other, 'NOTES.md'), 'meanwhile\n');
  sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'meanwhile'); sh(other, 'push', '-q', 'origin', `HEAD:${pr.head.ref}`);
  const moved = sh(other, 'rev-parse', 'HEAD');
  const refused = await svc.submitWork(deps, {
    user, taskId: update.taskId, patch: late.patch, agent: 'claude-code', updateProposal,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'branch_moved');
  assert.equal(refused.headSha, moved, 'and it says where the proposal is now');
  assert.equal(await gitHost.readRef('tide-log', pr.head.ref), moved, 'nothing was overwritten');

  // ── and a branch is no way to update it either ─────────────────────
  const viaBranch = await svc.submitWork(deps, {
    user, proposalId: submitted.proposalId, branch: 'my-work', updateProposal,
  });
  assert.equal(viaBranch.code, 'patch_required');
});
