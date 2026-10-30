'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const github = require('../src/services/github');
const reads = require('../src/services/github-read-access');
const { decrypt, encrypt } = require('../src/services/secrets');
const pause = require('../src/services/github-pause');
const { JOBS } = require('../src/workflow/clock/services.ts');
const REPO = 'https://github.com/Usernode-Labs/social-vibecoding';
const CONFIG = { githubAppId: '123', dataEncryptionKey: 'test-only-data-key', platformRepoUrl: REPO };
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

async function setup(t) {
  for (const [key, value] of Object.entries({ PROCESS_ROLE: 'conductor', USERNODE_PLATFORM_REPO: REPO })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const state = { record: null, calls: [], installations: ['Usernode-Labs'], failMint: false, permissions: null, repositories: null };
  const pool = { async query(sql, values) {
    assert.match(sql, /data->'kept'/, 'a failed refresh does not destroy still-valid read access');
    assert.deepEqual(values, ['clock:github-read-access']);
    return { rows: [{ access: state.record }] };
  } };
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const call = { path, method: init.method || 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : null };
    state.calls.push(call);
    let body = {}, status = 200;
    if (path === '/app/installations') body = state.installations.map((owner) => ({ id: 100, account: { login: owner } }));
    else if (path === '/app/installations/100/access_tokens') {
      assert.deepEqual(call.body?.repositories, ['social-vibecoding']);
      assert.deepEqual(call.body?.permissions, { contents: 'read', pull_requests: 'read', metadata: 'read' });
      status = state.failMint ? 503 : 201;
      body = state.failMint ? { message: 'temporary test outage' } : {
        token: 'test-scoped-read-token', expires_at: new Date(now + 60 * 60_000).toISOString(),
        permissions: state.permissions || call.body.permissions,
        repositories: (state.repositories || ['social-vibecoding']).map((name) => ({ id: 1, name })),
        repository_selection: 'selected',
      };
    } else if (path.endsWith('/git/ref/heads/main')) body = { object: { sha: 'a'.repeat(40) } };
    else if (path.endsWith('/branches/main')) body = { commit: { sha: 'a'.repeat(40), commit: { message: 'test head' } } };
    else throw new Error('Unexpected test request: ' + path);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  t.mock.method(github, 'listActionsSecrets', async () => ({ ok: true, secrets: [{ name: 'TEST_NAME', updatedAt: '2026-10-01' }], source: 'installation' }));
  pause._setForTests({ on: false, deadStatus: null });
  await github.init({ ...CONFIG, githubPrivateKey: privateKey }, pool);
  await github.checkActingInstallation();
  t.after(async () => { github._setAppForTests(null); await reads.init(null, null); pause._resetForTests(); });
  const run = async (previous = state.record) => {
    const job = JOBS.find((j) => j.name === reads.JOB);
    assert.equal(job.newestOnly, true);
    state.record = await job.run({ input: { previous } }, { config: CONFIG, pool });
    return state.record;
  };
  const web = async () => {
    process.env.PROCESS_ROLE = 'web';
    // A stale/injected writer key must not cause any App authentication on web.
    await github.init({ ...CONFIG, githubPrivateKey: 'not-a-private-key' }, pool);
  };
  return { state, pool, run, web, advance: (ms) => { now += ms; } };
}

test('the clock mints only platform-repository read access and journals encrypted tokens', async (t) => {
  const { state, run } = await setup(t);
  const result = await run();
  assert.equal(result.installed, true);
  assert.equal(JSON.stringify(result).includes('test-scoped-read-token'), false);
  assert.equal(JSON.parse(decrypt(result.tokenEnc, CONFIG.dataEncryptionKey)).token, 'test-scoped-read-token');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 1);
  const again = await run();
  assert.equal(again.tokenEnc, result.tokenEnc, 'reuse access well before expiry');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('web reads with published access while conductor admission stays configured', async (t) => {
  const { state, run, web } = await setup(t); await run();
  // Restore the real reader entry point after the conductor's metadata pass.
  t.mock.restoreAll();
  await web();
  assert.equal(github.isEnabled(), true);
  assert.equal(github.hasApp(), false);
  assert.equal(github.hasWriteAccess(), false);
  assert.equal(github.canActOn('Usernode-Labs'), true);
  // Reinstall a minimal transport after restoring the metadata mock.
  const sent = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    sent.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    const body = new URL(String(url)).pathname === '/repos/Usernode-Labs/social-vibecoding'
      ? { private: false } : String(url).includes('/branches/')
        ? { commit: { sha: 'a'.repeat(40), commit: { message: 'head' } } }
        : { object: { sha: 'a'.repeat(40) } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(await github.getBranchSha('Usernode-Labs', 'social-vibecoding', 'main'), 'a'.repeat(40));
  assert.equal((await github.headCommit('Usernode-Labs', 'social-vibecoding')).sha, 'a'.repeat(40));
  assert.deepEqual(await github.checkRepoPublic('Usernode-Labs', 'social-vibecoding'), { ok: true, private: false });
  assert.ok(sent.every((c) => c.auth === 'token test-scoped-read-token'));
  const client = await github.getReadOctokit('Usernode-Labs');
  await assert.rejects(client.rest.git.createRef({ owner: 'Usernode-Labs', repo: 'social-vibecoding', ref: 'refs/heads/test', sha: 'a'.repeat(40) }), { code: 'github_read_only' });
  for (const call of [() => github.getInstallationToken('Usernode-Labs'), () => github.getOctokit('Usernode-Labs'), () => github.mintReadToken(100), () => reads.refresh(CONFIG)]) {
    await assert.rejects(call(), { code: 'workflow_role_required' });
  }
  await assert.rejects(github.getReadOctokit('somebody-else'), { code: 'github_paused' });
  const names = await github.listActionsSecrets('Usernode-Labs', 'social-vibecoding');
  assert.equal(names.secrets[0].name, 'TEST_NAME');
  assert.equal(sent.length, 3, 'published metadata and refused calls send nothing');
  assert.equal(state.record.installed, true);
});

test('web with no publication remains configured and refuses unavailable reads', async (t) => {
  const { web, state } = await setup(t); const before = state.calls.length;
  await web();
  assert.equal(github.isEnabled(), true);
  assert.equal(github.canActOn('Usernode-Labs'), false);
  await assert.rejects(github.getReadOctokit('Usernode-Labs'), { code: 'github_read_unavailable' });
  assert.equal(state.calls.length, before, 'no fallback to the App on web');
});

test('read access expires even when a failed refresh leaves the prior clock result', async (t) => {
  const { state, run, web, advance } = await setup(t); await run();
  const prior = state.record;
  advance(51 * 60_000); state.failMint = true;
  await assert.rejects(run(), /temporary test outage/);
  assert.equal(state.record, prior);
  await web();
  assert.ok(await reads.token('Usernode-Labs'), 'the prior token remains valid during a short outage');
  advance(10 * 60_000);
  await assert.rejects(reads.token('Usernode-Labs'), { code: 'github_read_unavailable' });
});

test('refresh detects a removed installation and publishes no credential', async (t) => {
  const { state, run, web, advance } = await setup(t); await run();
  state.installations = []; advance(6 * 60_000);
  const result = await run();
  assert.equal(result.installed, false); assert.equal(result.tokenEnc, undefined);
  await web(); assert.equal(github.canActOn('Usernode-Labs'), false);
  await assert.rejects(reads.token('Usernode-Labs'), { code: 'github_read_unavailable' });
});

test('web rejects another scope, unreadable ciphertext and expired access', async (t) => {
  const { state, run, web } = await setup(t); const good = await run();
  for (const bad of [
    { ...good, scope: 'another-repository' },
    { ...good, tokenEnc: encrypt('unreadable access', 'another-test-key') },
    { ...good, tokenEnc: encrypt(JSON.stringify({ scope: good.scope, token: 'test', expiresAt: '2000-01-01' }), CONFIG.dataEncryptionKey) },
    { ...good, tokenEnc: encrypt(JSON.stringify({ scope: 'another-repository', token: 'test', expiresAt: good.expiresAt }), CONFIG.dataEncryptionKey) },
  ]) {
    state.record = bad; await web();
    await assert.rejects(reads.token('Usernode-Labs'), { code: 'github_read_unavailable' });
  }
});

test('read grants with unexpected permissions or repositories are refused before publication', async (t) => {
  const { state, run } = await setup(t);
  state.permissions = { contents: 'write', metadata: 'read', pull_requests: 'read' };
  await assert.rejects(run(), /repository-scoped read access/);
  assert.equal(state.record, null);
  state.permissions = null; state.repositories = ['social-vibecoding', 'another-repo'];
  await assert.rejects(run(), /repository-scoped read access/);
  assert.equal(state.record, null);
});


test('minting validates the current platform installation before requesting a grant', async (t) => {
  const { state } = await setup(t);
  const count = state.calls.length;
  await assert.rejects(github.mintReadToken(999), /platform installation changed/);
  assert.equal(state.calls.length, count, 'no grant for another installation');
  await assert.rejects(reads.refresh({ ...CONFIG, platformRepoUrl: 'https://github.com/Usernode-Labs/other' }), /matching platform repository/);
  assert.equal(state.calls.length, count);
});

test('the clock renews near-expiry access and rechecks unusable installation facts', async (t) => {
  const { state, run, advance } = await setup(t);
  const first = await run();
  advance(51 * 60_000);
  const renewed = await run();
  assert.notEqual(renewed.tokenEnc, first.tokenEnc);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt));
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 2);
  const before = state.calls.filter((c) => c.path === '/app/installations').length;
  state.record = { ...renewed, checkedAt: 'unusable date' };
  assert.ok(Number.isFinite(Date.parse((await run()).checkedAt)));
  assert.equal(state.calls.filter((c) => c.path === '/app/installations').length, before + 1);
});
