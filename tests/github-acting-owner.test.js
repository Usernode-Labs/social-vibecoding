'use strict';

// Who Homeroom is on GitHub (services/github.js "Who Homeroom is on GitHub").
//
// GitHub suspended usernode-bot, the account behind GITHUB_BOT_TOKEN, on
// 25 Oct 2026, and Homeroom promised GitHub never to use it again. Every pod
// still sent it once after that, was refused, and paused itself. What is
// left on GitHub is the platform's own repository, and Homeroom acts on it as
// the GitHub App. Pinned here, against the real clients with a stand-in App
// and a stubbed global fetch:
//
//   1. Every client, read or write, is the App's installation on the
//      platform repository's owner, with an installation token. The bot
//      token is never sent, whatever the environment holds.
//   2. Any other owner (the bot's own account, where three apps wait for
//      GitHub's export, or anyone's) is refused as a pause before anything
//      is sent, and before the App's installations are even walked.
//   3. The platform setting still pauses everything; an App not installed on
//      the owner refuses plainly.
//   4. Nothing in the platform hands the bot token to a request any more.
//
// Never calls GitHub.
//
// Run with: node --test tests/github-acting-owner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const github = require('../src/services/github');
const pause = require('../src/services/github-pause');

const ROOT = path.join(__dirname, '..');
const INSTALLATION_TOKEN = 'ghs_test_installation_token';
const BOT_TOKEN = 'ghp_suspended_bot_token_never_sent';

// A stand-in for the GitHub App, installed on `logins`; counts its walks.
function fakeApp(logins) {
  const fake = {
    walks: 0,
    eachInstallation: {
      async *iterator() {
        fake.walks += 1;
        for (const [i, login] of logins.entries()) yield { installation: { id: 100 + i, account: { login } } };
      },
    },
    octokit: { auth: async ({ installationId }) => ({ token: `${INSTALLATION_TOKEN}_${installationId}` }) },
  };
  return fake;
}

// A global fetch answering `answer(call)`, remembering method, path and the
// Authorization header of each call.
function stubFetch(t, answer = () => ({})) {
  const calls = [];
  const prior = global.fetch;
  global.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({
      method: init.method || 'GET',
      path: new URL(String(url)).pathname,
      auth: headers.authorization || headers.Authorization || null,
    });
    const { status = 200, body = {} } = answer(calls[calls.length - 1]) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = prior; });
  return calls;
}

function setup(t, { installed = ['Usernode-Labs'] } = {}) {
  const prior = { repo: process.env.USERNODE_PLATFORM_REPO, bot: process.env.GITHUB_BOT_TOKEN };
  process.env.USERNODE_PLATFORM_REPO = 'https://github.com/Usernode-Labs/social-vibecoding';
  process.env.GITHUB_BOT_TOKEN = BOT_TOKEN;
  const app = fakeApp(installed);
  github._setAppForTests(app);
  pause._setForTests({ on: false, deadStatus: null });
  t.after(() => {
    github._setAppForTests(null);
    pause._setForTests({ on: false, deadStatus: null });
    if (prior.repo === undefined) delete process.env.USERNODE_PLATFORM_REPO; else process.env.USERNODE_PLATFORM_REPO = prior.repo;
    if (prior.bot === undefined) delete process.env.GITHUB_BOT_TOKEN; else process.env.GITHUB_BOT_TOKEN = prior.bot;
  });
  return app;
}

// ─── 1. The installation, for reads and writes ──────────────────────────

test('a read on the platform repository goes through the App installation, never the bot token', async (t) => {
  setup(t);
  const calls = stubFetch(t, (call) => (call.path.endsWith('/git/ref/heads/feature/x')
    ? { body: { object: { sha: 'b'.repeat(40) } } }
    : { body: { private: false } }));
  assert.equal(await github.getBranchSha('Usernode-Labs', 'social-vibecoding', 'feature/x'), 'b'.repeat(40));
  assert.deepEqual(await github.checkRepoPublic('usernode-labs', 'social-vibecoding'), { ok: true, private: false },
    'the owner is matched without regard to case');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.auth, new RegExp(`^token ${INSTALLATION_TOKEN}_100$`));
  }
});

test('a write on the platform repository goes through the same installation', async (t) => {
  setup(t);
  const calls = stubFetch(t, (call) => (call.method === 'GET'
    ? { body: { object: { sha: 'a'.repeat(40) } } }
    : { status: 201, body: { ref: 'refs/heads/dev/new' } }));
  await github.createBranch('Usernode-Labs', 'social-vibecoding', 'dev/new');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.ok(calls.every((c) => c.auth === `token ${INSTALLATION_TOKEN}_100`));
  assert.equal(JSON.stringify(calls).includes(BOT_TOKEN), false, 'the bot token is never sent');
});

test('the push credential is an installation token for the platform repository\'s owner', async (t) => {
  setup(t);
  assert.equal(await github.getInstallationToken('Usernode-Labs'), `${INSTALLATION_TOKEN}_100`);
  assert.equal(github.credentialClass(), 'installation');
});

// ─── 2. Every other owner is refused before anything is sent ────────────

test('the bot\'s own account and anyone else\'s are refused as a pause, sending nothing', async (t) => {
  const app = setup(t, { installed: ['Usernode-Labs', 'usernode-bot'] });
  const calls = stubFetch(t);
  for (const owner of ['usernode-bot', 'someone-else']) {
    await assert.rejects(github.getOctokit(owner), (err) => {
      assert.equal(pause.isPausedError(err), true);
      assert.equal(err.code, 'github_paused');
      assert.match(err.message, /only for its own repository/);
      return true;
    });
    await assert.rejects(github.getInstallationToken(owner), (err) => pause.isPausedError(err));
    await assert.rejects(github.getRepoHead(owner, 'dtv-610ccb'), (err) => pause.isPausedError(err));
  }
  assert.deepEqual(await github.checkRepoPublic('usernode-bot', 'dtv-610ccb'), {
    ok: false, code: 'github_paused',
    message: 'GitHub is paused for this repository: Homeroom acts on GitHub only for its own repository',
  });
  assert.equal(calls.length, 0, 'nothing reached GitHub');
  assert.equal(app.walks, 0, 'not even the App\'s installations were walked');
  assert.equal(github.canActOn('usernode-bot'), false);
});

test('creating a repository on GitHub is refused: new ones are made on the git host', async (t) => {
  setup(t);
  const calls = stubFetch(t);
  await assert.rejects(github.createRepo('Usernode-Labs', 'anything'), /made on Homeroom's git host/);
  assert.equal(calls.length, 0);
});

test('importing from GitHub, which made the bot a collaborator, is paused', async () => {
  assert.deepEqual(await github.verifyBotAccess('someone', 'their-repo'), {
    ok: false, status: 503, code: 'github_paused',
    message: 'Importing a repository from GitHub is paused while Homeroom moves off GitHub.',
  });
});

// ─── 3. The setting, and an App not installed there ─────────────────────

test('the platform setting refuses the platform repository too', async (t) => {
  setup(t);
  const calls = stubFetch(t);
  pause._setForTests({ on: true });
  await assert.rejects(github.getOctokit('Usernode-Labs'), (err) => pause.isPausedError(err));
  assert.equal(calls.length, 0);
});

test('an App not installed on the owner refuses plainly, and canActOn stays false until it is', async (t) => {
  const app = setup(t, { installed: ['someone-else'] });
  stubFetch(t);
  await assert.rejects(github.getOctokit('Usernode-Labs'), /No GitHub App installation found for owner: Usernode-Labs/);
  assert.equal(app.walks, 1);
  assert.equal(github.canActOn('Usernode-Labs'), false, 'just looked up: not asked again at once');
  assert.equal(app.walks, 1);
});

// ─── 4. Nothing hands the bot token to a request ────────────────────────

test('no request is made with the bot token: the only readers of it say whether it is set', () => {
  const allowed = {
    // Admin › Limits: whether it is configured, for the empty state.
    'src/routes/admin.js': /botToken: !!process\.env\.GITHUB_BOT_TOKEN,/,
    // The platform-limit alert for its budget, which nothing spends now.
    'src/services/platform-limit-alerts.js': /enabled: \(\) => !!process\.env\.GITHUB_BOT_TOKEN,/,
    // A remix on GitHub, reached only without a git host, and then refused
    // by createRepo before the push (pinned above).
    'src/services/app-forker.js': /const botToken = hosted \? '' : \(process\.env\.GITHUB_BOT_TOKEN \|\| ''\);/,
  };
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(js|ts)$/.test(e.name) ? [full] : [];
  });
  const readers = walk(path.join(ROOT, 'src'))
    .filter((f) => /process\.env\.GITHUB_BOT_TOKEN/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(readers, Object.keys(allowed).sort());
  for (const [file, use] of Object.entries(allowed)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal((src.match(/process\.env\.GITHUB_BOT_TOKEN/g) || []).length, 1, file);
    assert.match(src, use, file);
  }
});
