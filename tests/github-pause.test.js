'use strict';

// The GitHub pause (services/github-pause.js).
//
// On 25 Oct 2026 GitHub suspended the account behind GITHUB_BOT_TOKEN and
// nothing noticed: the clocks and the Homeroom bot kept calling the dead
// token about 2,000 times an hour. Pinned here:
//
//   1. The two ways in: the `github_paused` platform setting, and the bot
//      token refused as dead (401, or a 403 saying the account was
//      suspended), which only the bot token can trigger.
//   2. While paused nothing reaches GitHub: an instrumented Octokit client
//      and the raw fetch path refuse before sending, and the first dead
//      answer stops the next request.
//   3. Background work is held (github-budget.js backgroundHold).
//   4. Every process reads the setting before GitHub's client starts.
//
// Never calls GitHub: Octokit gets a fake fetch, the raw path a stubbed
// global fetch.
//
// Run with: node --test tests/github-pause.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loggerId = require.resolve('../src/services/logger');
const logged = [];
require.cache[loggerId] = {
  id: loggerId,
  filename: loggerId,
  loaded: true,
  paths: [],
  exports: {
    info: (...a) => logged.push(['info', ...a]),
    debug() {},
    warn: (...a) => logged.push(['warn', ...a]),
    error: (...a) => logged.push(['error', ...a]),
  },
};

const pause = require('../src/services/github-pause');
const budget = require('../src/services/github-budget');
const github = require('../src/services/github');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function settingPool(value) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^SELECT/.test(sql)) return { rows: value === null ? [] : [{ value, updated_at: new Date('2026-10-26T12:00:00Z') }] };
      return { rows: [] };
    },
  };
}

// A fetch that answers from a list, counting what was sent.
function fakeFetch(answers) {
  const sent = [];
  const fn = async (url, init) => {
    sent.push({ url: String(url), init });
    const a = answers[Math.min(sent.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status, headers: { 'content-type': 'application/json', ...(a.headers || {}) },
    });
  };
  fn.sent = sent;
  return fn;
}

async function octokitOn(fetchImpl, credential = 'pat') {
  const { Octokit } = await import('@octokit/rest');
  return github._instrumentForTests(new Octokit({ auth: 'test-token', request: { fetch: fetchImpl } }), credential);
}

test.beforeEach(() => {
  pause._resetForTests();
  budget._resetForTests();
  logged.length = 0;
});

test('the platform setting pauses GitHub, and turning it off resumes it', async () => {
  assert.equal(pause.isPaused(), false);
  await pause.refresh(settingPool('true'));
  assert.equal(pause.isPaused(), true);
  assert.deepEqual(pause.state(), { paused: true, reason: 'setting', since: '2026-10-26T12:00:00.000Z', detail: null });
  await pause.refresh(settingPool('false'));
  assert.equal(pause.isPaused(), false);
  await pause.refresh(settingPool(null));
  assert.equal(pause.isPaused(), false, 'no row is not paused');
});

test('a failed read of the setting keeps the last value instead of flipping', async () => {
  await pause.refresh(settingPool('on'));
  await pause.refresh({ async query() { throw new Error('connection reset'); } });
  assert.equal(pause.isPaused(), true);
});

test('setPaused writes the setting and applies it at once', async () => {
  const pool = settingPool('true');
  await pause.setPaused(pool, true, { userId: 7 });
  const write = pool.queries.find((q) => /INSERT INTO platform_settings/.test(q.sql));
  assert.deepEqual(write.params, ['github_paused', 'true', 7]);
  assert.equal(pause.isPaused(), true);
});

test('only the bot token, refused as dead, pauses the process', () => {
  assert.equal(pause.noteRefusal('installation:usernode-labs', { status: 401 }), false);
  assert.equal(pause.noteRefusal('anonymous', { status: 401 }), false);
  assert.equal(pause.noteRefusal('pat', { status: 403, message: 'API rate limit exceeded for user' }), false);
  assert.equal(pause.noteRefusal('pat', { status: 403, message: 'Resource not accessible by personal access token' }), false);
  assert.equal(pause.noteRefusal('pat', { status: 404 }), false);
  assert.equal(pause.isPaused(), false);
  assert.equal(pause.noteRefusal('pat', { status: 403, message: 'Sorry. Your account was suspended.' }), true);
  assert.equal(pause.isPaused(), true);
  assert.equal(pause.state().reason, 'suspended');
  assert.ok(logged.some(([level, , msg]) => level === 'error' && /refused as dead/.test(msg)));
});

test('a 401 on the bot token pauses the process (a revoked or placeholder token)', () => {
  assert.equal(pause.noteRefusal('pat', { status: 401, message: 'Bad credentials' }), true);
  assert.equal(pause.isPaused(), true);
});

test('a dead token outlives the setting being turned off', async () => {
  pause.noteRefusal('pat', { status: 401 });
  await pause.refresh(settingPool('false'));
  assert.equal(pause.isPaused(), true);
});

test('while paused an instrumented Octokit client refuses before sending anything', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { login: 'x' } }]);
  const octokit = await octokitOn(fetchImpl);
  pause._setForTests({ on: true });
  await assert.rejects(octokit.request('GET /user'), (err) => {
    assert.equal(err.code, 'github_paused');
    assert.equal(err.status, 503);
    assert.equal(pause.isPausedError(err), true);
    return true;
  });
  assert.equal(fetchImpl.sent.length, 0, 'nothing reached GitHub');
});

test('the first "account was suspended" answer stops the next request', async () => {
  const fetchImpl = fakeFetch([{ status: 403, body: { message: 'Sorry. Your account was suspended.' } }]);
  const octokit = await octokitOn(fetchImpl);
  await assert.rejects(octokit.request('GET /repos/{owner}/{repo}', { owner: 'usernode-bot', repo: 'x' }), (err) => err.status === 403);
  assert.equal(pause.isPaused(), true);
  await assert.rejects(octokit.request('GET /user'), (err) => err.code === 'github_paused');
  assert.equal(fetchImpl.sent.length, 1, 'the second request never left the process');
});

test('an installation client refused as suspended does not pause the process', async () => {
  const fetchImpl = fakeFetch([{ status: 403, body: { message: 'Sorry. Your account was suspended.' } }]);
  const octokit = await octokitOn(fetchImpl, 'installation:someone');
  await assert.rejects(octokit.request('GET /user'));
  assert.equal(pause.isPaused(), false);
});

test('the raw fetch path refuses while paused and pauses on a dead answer', async (t) => {
  const prior = global.fetch;
  t.after(() => { global.fetch = prior; });
  global.fetch = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
  const resp = await github.githubFetch('pat', 'https://api.github.com/user', {});
  assert.equal(resp.status, 401);
  assert.equal(await resp.text(), JSON.stringify({ message: 'Bad credentials' }), 'the caller can still read the body');
  assert.equal(pause.isPaused(), true);
  await assert.rejects(github.githubFetch('pat', 'https://api.github.com/user', {}), (err) => err.code === 'github_paused');
  assert.equal(global.fetch.sent.length, 1);
});

test('a raw 403 for a suspended account is read from a clone of the response', async (t) => {
  const prior = global.fetch;
  t.after(() => { global.fetch = prior; });
  global.fetch = fakeFetch([{ status: 403, body: { message: 'Sorry. Your account was suspended.' } }]);
  const resp = await github.githubFetch('pat', 'https://api.github.com/repos/a/b/issues', {});
  assert.equal(pause.isPaused(), true);
  assert.match(await resp.text(), /suspended/, 'the body is still unread for the caller');
});

test('background GitHub work is held while paused, and not otherwise', () => {
  assert.equal(budget.backgroundHold(), null);
  assert.equal(budget.budgetAllows('background'), true);
  pause._setForTests({ on: true });
  const hold = budget.backgroundHold({ now: 1000 });
  assert.equal(hold.paused, true);
  assert.equal(hold.retryInMs, 60 * 1000);
  assert.equal(budget.budgetAllows('background'), false);
  assert.equal(budget.budgetAllows('person'), true, 'a person\'s request is not held by the budget; the client refuses it');
});

test('every workflow process reads the pause before GitHub\'s client starts', () => {
  const src = read('src/workflow/setup.ts');
  const startAt = src.indexOf("legacy('services/github-pause').start(");
  const initAt = src.indexOf("legacy('services/github').init(config)");
  assert.ok(startAt > 0 && initAt > startAt);
});

test('App-level calls that skip the request hook check the pause themselves', () => {
  const src = read('src/services/github.js');
  const body = (fn, kind = 'async function') => {
    const start = src.indexOf(`${kind} ${fn}(`);
    return src.slice(start, src.indexOf('\n}\n', start));
  };
  for (const fn of ['getInstallationToken', 'getBotUsername']) {
    assert.match(body(fn), /pause\.assertNotPaused\(\)/, fn);
  }
  // The installation walk checks the pause and the owner together.
  assert.match(body('resolveInstallationId'), /assertActingOwner\(owner\)/);
  assert.match(body('assertActingOwner', 'function'), /pause\.assertNotPaused\(\)/);
  assert.equal((src.match(/(^|[^A-Za-z.])fetch\(/gm) || []).length, 1, 'githubFetch is the only raw fetch in the client');
});
