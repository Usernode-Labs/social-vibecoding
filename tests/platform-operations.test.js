'use strict';

// Privileged operations (services/platform-operations.js): what the event
// carries, what a route answers, when the conductor reads authority again,
// and that a retried request finishes from its steps instead of writing
// twice. The machine against PostgreSQL is
// tests/platform-operation-workflow-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { requested, MAX_INPUT_BYTES } = require('../src/workflow/platform-operation/machine.ts');
const kernelSteps = require('../src/workflow/kernel/steps.ts');
const operations = require('../src/services/platform-operations');

// A work item's steps over an in-memory checkpoint: `next()` is the same
// item tried again, resuming from what the last try saved.
function checkpointed() {
  let saved = null;
  const make = (attempt) => kernelSteps.steps({ resumeFrom: saved, attempt, checkpoint: async (v) => { saved = v; } });
  let attempt = 0;
  return { next: () => make(++attempt), saved: () => saved };
}

test('the event names a known operation, its request, requester and project, and a bounded input', () => {
  const ok = { op: 'manifest.propose', requestId: randomUUID(), appId: 3, userId: 7, input: { flavor: 'rename', args: {} } };
  assert.deepEqual(requested(ok), ok);
  assert.deepEqual(requested({ ...ok, appId: null }).appId, null);
  for (const [why, bad] of [
    ['an operation that is not area.verb', { ...ok, op: 'shell; exec' }],
    ['no operation', { ...ok, op: undefined }],
    ['no request id', { ...ok, requestId: 'x' }],
    ['no requester', { ...ok, userId: null }],
    ['a project that is not an id', { ...ok, appId: '3' }],
    ['an input that is not an object', { ...ok, input: ['a'] }],
    ['an oversized input', { ...ok, input: { blob: 'x'.repeat(MAX_INPUT_BYTES) } }],
    ['a preview project\'s step without its preview', { ...ok, op: 'previewProject.build', input: { projectId: 4 } }],
    ['a preview project\'s step without its project', { ...ok, op: 'previewProject.remove', input: { sessionId: 9 } }],
  ]) assert.throws(() => requested(bad), Error, why);
  // One this build does not know is still a request: its work waits for a
  // conductor that knows it, instead of an older one refusing it in a rollout.
  assert.equal(requested({ ...ok, op: 'later.operation' }).op, 'later.operation');
  const step = { ...ok, appId: null, op: 'previewProject.deploy', input: { sessionId: 9, projectId: 4 } };
  assert.deepEqual(requested(step), step, 'a preview project\'s step names its preview and project, never the files or env it runs with');
});

test('a route answers the operation, a refusal, a pending request or a failure', () => {
  const answer = operations._answerForTests;
  assert.deepEqual(answer({ status: 'done', requestId: 'r', result: { ok: true, prUrl: 'u' } }), { ok: true, prUrl: 'u', requestId: 'r' });
  assert.deepEqual(answer({ status: 'done', requestId: 'r', result: { ok: false, status: 409, error: 'e' } }),
    { ok: false, status: 409, error: 'e', requestId: 'r' });
  // Never a success: the caller would show what has not happened yet.
  const pending = answer({ status: 'pending', requestId: 'r' });
  assert.equal(pending.status, 503); assert.equal(pending.code, 'operation_pending');
  assert.equal(pending.pending, true); assert.equal(pending.ok, false);
  assert.equal(answer({ status: 'refused', requestId: 'r', reason: 'not_authorized' }).status, 403);
  assert.equal(answer({ status: 'refused', requestId: 'r', reason: 'not_found' }).status, 404);
  const unavailable = answer({ status: 'refused', requestId: 'r', reason: 'operation_unavailable' });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.code, 'operation_unavailable');
  assert.deepEqual(answer({ status: 'failed', requestId: 'r', error: { message: 'host down' } }),
    { ok: false, status: 500, error: 'host down' });
});

test('only a finished instance answers a route; one still queued when the wait runs out is pending', () => {
  const { operationOutcome } = require('../src/workflow/platform.ts');
  assert.deepEqual(operationOutcome('r', { state: 'queued', data: null }), { status: 'pending', requestId: 'r' });
  assert.deepEqual(operationOutcome('r', null), { status: 'pending', requestId: 'r' });
  assert.deepEqual(operationOutcome('r', { state: 'done', data: { ok: true } }), { status: 'done', requestId: 'r', result: { ok: true } });
  assert.deepEqual(operationOutcome('r', { state: 'failed', data: { error: { message: 'x', code: null } } }),
    { status: 'failed', requestId: 'r', error: { message: 'x', code: null } });
});

test('authority is read again on every attempt, so one revoked after a write stops what is left', async (t) => {
  const user = { id: 7, username: 'maya', is_admin: false, admin_readonly: false, has_platform_access: true, private_member_since: null, anonymised_at: null };
  let row = user;
  const pool = { query: async () => ({ rows: row ? [row] : [] }) };
  let allowed = true; const asked = []; const wrote = []; const abandoned = [];
  operations.OPERATIONS.set('test.write', () => ({
    authorize: async (_d, _r, u, { steps }) => { asked.push([u.id, steps.has('write')]); return allowed ? null : { status: 403, error: 'no' }; },
    abandon: async () => { abandoned.push(true); },
    run: async (_d, _r, _u, steps) => {
      await steps.once('write', async () => { wrote.push('write'); return true; });
      if (!steps.has('second')) { await steps.set('second', true); throw new Error('reply lost'); }
      await steps.once('write2', async () => { wrote.push('write2'); return true; });
      return { made: true };
    },
  }));
  t.after(() => operations.OPERATIONS.delete('test.write'));
  const request = { op: 'test.write', userId: 7, appId: 1, input: {} };

  // A retry carries on from its steps, and reads authority again first.
  const item = checkpointed();
  await assert.rejects(operations.run({ pool }, request, item.next()), /reply lost/);
  assert.deepEqual(await operations.run({ pool }, request, item.next()), { ok: true, made: true });
  assert.deepEqual(asked, [[7, false], [7, true]]);
  assert.deepEqual(wrote, ['write', 'write2'], 'no write is made twice');

  // Revoked after the first write: nothing more is written, and what a
  // started request holds is given back.
  wrote.length = 0;
  const revoked = checkpointed();
  await assert.rejects(operations.run({ pool }, request, revoked.next()), /reply lost/);
  allowed = false;
  assert.deepEqual(await operations.run({ pool }, request, revoked.next()), { ok: false, status: 403, error: 'no' });
  assert.deepEqual(wrote, ['write']);
  assert.deepEqual(abandoned, [true]);

  // A request whose authority is gone before any write is refused, and so
  // is one from an account erased or shut out since; whatever refuses it,
  // what it holds is given back.
  assert.deepEqual(await operations.run({ pool }, request, checkpointed().next()), { ok: false, status: 403, error: 'no' });
  allowed = true;
  abandoned.length = 0;
  const shutOut = checkpointed();
  await assert.rejects(operations.run({ pool }, request, shutOut.next()), /reply lost/);
  row = { ...user, has_platform_access: false };
  assert.equal((await operations.run({ pool }, request, shutOut.next())).status, 403);
  assert.deepEqual(abandoned, [true], 'a requester refusal gives back the claim too');
  row = { ...user, anonymised_at: new Date() };
  assert.equal((await operations.run({ pool }, request, checkpointed().next())).status, 403);
  row = { ...user, has_platform_access: false };
  assert.equal((await operations.run({ pool }, request, checkpointed().next())).status, 403);
  row = null;
  assert.equal((await operations.run({ pool }, request, checkpointed().next())).status, 403);
  await assert.rejects(operations.run({ pool }, { ...request, op: 'nope' }), (err) => err.permanent === true);
});

test('an Undo retried after its push and a lost PR reply pushes nothing and opens no second PR', async (t) => {
  const github = require('../src/services/github');
  const docker = require('../src/services/docker');
  const branches = new Set(); const prs = new Map(); const git = []; const children = [];
  let failPr = true;
  t.mock.method(github, 'getInstallationToken', async () => 'ghs_revert_installation_token');
  const planted = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://planted:planted-db-secret@db.invalid/app';
  t.after(() => { if (planted === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = planted; });
  t.mock.method(github, 'getBranchSha', async (_o, _r, b) => (branches.has(b) ? 'f'.repeat(40) : null));
  t.mock.method(github, 'findOpenPrByBranch', async (_o, _r, b) => prs.get(b) || null);
  t.mock.method(github, 'createPR', async (_o, _r, { branch }) => {
    prs.set(branch, { number: 41, html_url: 'https://github.com/acme/demo/pull/41' });
    if (failPr) { failPr = false; throw new Error('socket hang up'); }
    return prs.get(branch);
  });
  t.mock.method(docker, 'execFileAsync', async (_cmd, args, opts) => {
    children.push({ args, env: opts.env });
    git.push(args.find((a) => ['clone', 'revert', 'push', 'checkout'].includes(a)) || args[0]);
    if (args.includes('push')) branches.add(args.at(-1));
    return { stdout: '' };
  });
  const { createRevertPR } = require('../src/routes/votes');
  const session = { id: 5, branch_name: 'dev/x-1', pr_number: 9, pr_title: 'A change' };
  const item = checkpointed();
  const args = { session, mergeSha: 'a'.repeat(40), repoOwner: 'acme', repoName: 'demo', deciderUsername: 'maya' };
  await assert.rejects(createRevertPR({ ...args, steps: item.next() }), /socket hang up/);
  const pushes = git.filter((g) => g === 'push').length;
  const out = await createRevertPR({ ...args, steps: item.next() });
  assert.equal(git.filter((g) => g === 'push').length, pushes, 'no second push');
  assert.equal(github.createPR.mock.callCount(), 1, 'no second PR');
  assert.equal(out.prNumber, 41); assert.match(out.branch, /^revert\/dev\/x-1-\d+$/);
  // The installation token is never an argument or in the clone's URL, and
  // only the clone and the push hold it, through git's credential helper;
  // no git child holds the process's own secrets.
  for (const { args, env } of children) {
    const sub = args.find((a) => ['clone', 'revert', 'push', 'checkout', 'config'].includes(a));
    assert.ok(!args.join(' ').includes('ghs_revert_installation_token'), `git ${sub}'s argv holds the token`);
    assert.ok(env && !JSON.stringify(env).includes('planted-db-secret'), `git ${sub} is handed the process's environment`);
    assert.equal(env.USERNODE_GIT_PASSWORD === 'ghs_revert_installation_token', ['clone', 'push'].includes(sub), `git ${sub}`);
  }
  assert.ok(children.some((c) => c.args.includes('https://github.com/acme/demo.git')), 'cloned from the bare address');
});

test('branches are made only under dev/, and a proposal start only on its requester\'s own name', () => {
  const { branchAllowed } = require('../src/services/branch-operation');
  assert.equal(branchAllowed('proposal-start', 'dev/cli-u7-abc-1', 7), true);
  assert.equal(branchAllowed('proposal-start', 'dev/cli-u8-abc-1', 7), false);
  assert.equal(branchAllowed('proposal-start', 'dev/someone-1', 7), false);
  for (const purpose of ['headless', 'clone-headless', 'session']) {
    assert.equal(branchAllowed(purpose, 'dev/auto-issue-5-fix-1', 7), true, purpose);
    for (const bad of ['main', 'revert/dev/x', 'dev/a/b', 'dev/..x', '']) assert.equal(branchAllowed(purpose, bad, 7), false, `${purpose} ${bad}`);
  }
});

test('every settings route asks for a manifest proposal the conductor knows how to recheck and open', () => {
  const { FLAVORS } = require('../src/services/manifest-proposal-operation');
  // The settings routes: routes/apps.js, and the versions' follow-pr
  // (routes/versions.js).
  const routes = ['apps.js', 'versions.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8')).join('\n');
  const asked = [...routes.matchAll(/proposeManifest\(res, app, req\.user, '([a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(asked, [...FLAVORS.keys()].sort());
  assert.doesNotMatch(routes, /renamePr\.create[A-Za-z]+PR\(|topicsPr\.createTopicsPR\(|whoDecides\.createWhoDecidesPR\(|followPr\.createFollowPR\(/,
    'no settings route writes to the code host itself');
});

test('a declared secret\'s value goes with its proposal, so one still opening keeps it', async (t) => {
  const { encrypt, decrypt } = require('../src/services/secrets');
  const dataKey = 'k'.repeat(64);
  const op = require('../src/services/manifest-proposal-operation');
  // The conductor, once the PR exists: everyone else's value is held for the
  // merge, encrypted; a full admin's lands now.
  const inserted = [];
  const pool = { query: async (sql, params) => {
    if (/INSERT INTO pending_secret_declarations/.test(sql)) { inserted.push(params); return { rows: [{ id: 1 }] }; }
    return { rows: [] };
  } };
  const args = { scope: 'app', key: 'API_TOKEN', declaration: { description: 'd' }, hasValue: true, isPrivate: true,
    valueEnc: encrypt('s3cret', dataKey) };
  const held = await op.declareValue({ config: { dataEncryptionKey: dataKey }, pool }, { id: 3 }, args, { id: 7 }, 55);
  assert.deepEqual(held, { valueApplied: false });
  assert.equal(inserted.length, 1);
  assert.equal(decrypt(inserted[0][5], dataKey), 's3cret', 'held, encrypted, for the merge');
  const appSecrets = require('../src/services/app-secrets');
  t.mock.method(appSecrets, 'setValue', async () => {});
  const applied = await op.declareValue({ config: { dataEncryptionKey: dataKey }, pool }, { id: 3 }, args, { id: 1, canAdminWrite: true }, 56);
  assert.deepEqual(applied, { valueApplied: true });
  assert.equal(appSecrets.setValue.mock.calls[0].arguments[3], 's3cret');
});
