'use strict';

// The migration's linked-issues backfill (db/migrate.js) reads each
// GitHub-hosted proposal's body from GitHub. It runs only where the GitHub
// App is set up. With the git host configured, github.isEnabled() is true in
// the migration Job too, which never sets the App up and cannot reach
// GitHub; gated on isEnabled() it fetched every such proposal there, each
// one waiting out a timeout, and held the release of 26 Oct 2026 for its
// whole deadline.
//
// Run with: node --test tests/linked-issues-backfill-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');
const { backfillLinkedIssuesFromPrBodies } = require('../src/db/migrate');

function stub(t, fields) {
  const prior = {};
  for (const [k, v] of Object.entries(fields)) { prior[k] = github[k]; github[k] = v; }
  t.after(() => Object.assign(github, prior));
}

const ROW = { id: 1, pr_number: 7, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };

test('without the GitHub App the backfill reads nothing, git host or not', async (t) => {
  const fetched = [];
  const queries = [];
  stub(t, {
    isEnabled: () => true,
    hasApp: () => false,
    getPR: async (...args) => { fetched.push(args); return { body: 'Closes #3' }; },
  });
  await backfillLinkedIssuesFromPrBodies({ query: async (sql) => { queries.push(sql); return { rows: [ROW] }; } });
  assert.deepEqual(fetched, [], 'no proposal is fetched');
  assert.deepEqual(queries, [], 'and not even the candidates are read');
});

test('with the GitHub App it still backfills from the body', async (t) => {
  const updates = [];
  stub(t, {
    isEnabled: () => true,
    hasApp: () => true,
    getPR: async () => ({ body: 'Closes #3' }),
  });
  await backfillLinkedIssuesFromPrBodies({
    query: async (sql, params) => {
      if (/^\s*SELECT/.test(sql)) return { rows: [ROW] };
      updates.push(params);
      return { rows: [] };
    },
  });
  assert.deepEqual(updates, [[[3], 1]]);
});
