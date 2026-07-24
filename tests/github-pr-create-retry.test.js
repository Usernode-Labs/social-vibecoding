// Tests for createPR's transient-failure hardening (2026-07-24 outage:
// GitHub answered every POST /pulls with an empty-body 500 for hours,
// which surfaced as a useless `{"err":""}` log and a misleading "re-run
// your request" user error).
//
// - 5xx / status-less network errors retry on an injectable schedule,
//   then throw a typed 'github_unavailable' error carrying the HTTP
//   status and GitHub request id.
// - The typed 422s (no_commits / pr_exists) are NEVER retried — they're
//   deterministic answers, and pr_exists specifically is how a
//   500-that-actually-created-the-PR heals on the next attempt.
// - describeGithubError produces a non-empty, log-safe shape even for
//   Octokit RequestErrors whose message is empty (empty response body).
//
// Run with: node --test tests/github-pr-create-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');

function requestError(status, { message = '', body, requestId } = {}) {
  const err = new Error(message);
  if (status != null) err.status = status;
  err.response = {
    status,
    headers: requestId ? { 'x-github-request-id': requestId } : {},
    data: body,
  };
  return err;
}

// Builds a fake octokit whose pulls.create pops one behavior per call
// from `script`: either a function that throws, or an object returned as
// the created PR.
function scriptedOctokit(script, calls) {
  return {
    rest: {
      pulls: {
        create: async (params) => {
          calls.push(params);
          const step = script.shift();
          if (typeof step === 'function') return step();
          return { data: step };
        },
      },
    },
  };
}

function withScript(script, calls) {
  github._setOctokitFactoryForTests(() => scriptedOctokit(script, calls));
  github._setCreatePrRetryDelaysForTests([1, 1]); // no real sleeping
}

function cleanup() {
  github._setOctokitFactoryForTests(null);
  github._setCreatePrRetryDelaysForTests(null);
}

test('500 twice then success → resolves with the PR after retries', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, { requestId: 'AB36:1' }); },
    () => { throw requestError(500, { requestId: 'AB36:2' }); },
    { number: 91, html_url: 'https://example/pr/91' },
  ], calls);
  try {
    const pr = await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(pr.number, 91);
    assert.equal(calls.length, 3, 'two retries after the two 500s');
  } finally {
    cleanup();
  }
});

test('500 on every attempt → typed github_unavailable with status + request id', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, { requestId: 'AB36:X' }); },
    () => { throw requestError(500, { requestId: 'AB36:Y' }); },
    () => { throw requestError(500, { requestId: 'AB36:Z' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => {
        assert.equal(err.code, 'github_unavailable');
        assert.equal(err.status, 500);
        assert.equal(err.requestId, 'AB36:Z');
        assert.match(err.message, /HTTP 500/);
        assert.match(err.message, /AB36:Z/);
        assert.match(err.message, /acme:feat\/x/);
        return true;
      }
    );
    assert.equal(calls.length, 3, 'all attempts consumed');
  } finally {
    cleanup();
  }
});

test('status-less network error is treated as transient and retried', async () => {
  const calls = [];
  withScript([
    () => { throw new Error('socket hang up'); },
    { number: 5, html_url: 'https://example/pr/5' },
  ], calls);
  try {
    const pr = await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(pr.number, 5);
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test('500 then 422 "already exists" → pr_exists surfaces (the adopt path heals a half-created PR)', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, {}); },
    () => { throw requestError(422, { message: 'Validation Failed: A pull request already exists for acme:feat/x.' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.code === 'pr_exists'
    );
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test('422 "No commits between" is thrown immediately — never retried', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(422, { message: 'Validation Failed: No commits between main and feat/x' }); },
    { number: 99, html_url: 'https://example/pr/99' }, // must never be reached
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.code === 'no_commits'
    );
    assert.equal(calls.length, 1, 'no retry on a deterministic 422');
  } finally {
    cleanup();
  }
});

test('a non-transient 4xx (e.g. 403) is neither retried nor re-typed', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(403, { message: 'Resource not accessible by integration' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.status === 403 && !err.code
    );
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('describeGithubError: empty-message empty-body 500 still describes itself', () => {
  const d = github.describeGithubError(requestError(500, { body: '', requestId: 'CD38:1' }));
  assert.equal(d.status, 500);
  assert.equal(d.requestId, 'CD38:1');
  assert.ok(d.message && d.message.length > 0, 'message is never empty');
  assert.match(d.message, /HTTP 500/);
});

test('describeGithubError: plain errors and nullish input are handled', () => {
  const plain = github.describeGithubError(new Error('boom'));
  assert.equal(plain.status, null);
  assert.equal(plain.message, 'boom');
  const none = github.describeGithubError(null);
  assert.ok(none.message);
});

test('describeGithubError: long string bodies are truncated for the log', () => {
  const d = github.describeGithubError(requestError(502, { body: 'x'.repeat(5000) }));
  assert.ok(d.data.length <= 300);
});
