// Unit tests for github.js's "repo name already exists" detection — the
// matcher that gates createRepo's adoptExisting path (mypage-777ed2 /
// session-2585 incident). Pure-function tests against the real module;
// no Octokit or network involved.
//
// Run with: node --test tests/github-repo-adopt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { _isRepoNameExistsError } = require('../src/services/github');

function githubError(status, { errors, message } = {}) {
  const err = new Error(message || 'boom');
  err.status = status;
  if (errors) err.response = { data: { errors } };
  return err;
}

test('matches the structured 422 shape (Repository/name errors entry)', () => {
  const err = githubError(422, {
    message: 'Repository creation failed.',
    errors: [{ resource: 'Repository', code: 'custom', field: 'name',
               message: 'name already exists on this account' }],
  });
  assert.equal(_isRepoNameExistsError(err), true);
});

test('matches on the message substring when no structured errors are attached', () => {
  const err = githubError(422, {
    message: 'Repository creation failed.: {"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"} - https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user',
  });
  assert.equal(_isRepoNameExistsError(err), true);
});

test('a 422 for a different validation failure does not match', () => {
  const err = githubError(422, {
    message: 'Validation Failed',
    errors: [{ resource: 'Repository', code: 'custom', field: 'description',
               message: 'description is too long' }],
  });
  assert.equal(_isRepoNameExistsError(err), false);
});

test('non-422 statuses never match, even with an "already exists" message', () => {
  assert.equal(_isRepoNameExistsError(githubError(503, { message: 'name already exists on this account' })), false);
  assert.equal(_isRepoNameExistsError(githubError(404, { message: 'Not Found' })), false);
});

test('null / undefined / plain errors are handled without throwing', () => {
  assert.equal(_isRepoNameExistsError(null), false);
  assert.equal(_isRepoNameExistsError(undefined), false);
  assert.equal(_isRepoNameExistsError(new Error('name already exists on this account')), false);
});
