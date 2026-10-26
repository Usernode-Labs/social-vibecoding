'use strict';

// The workflow's pure parser for a stored repository address
// (src/workflow/rules/github-url.ts parseRepoAddress): GitHub's spellings as
// parseGithubUrl reads them, and any host's https://<host>/<owner>/<repo>,
// since app repositories live on Homeroom's git host.
//
// Run with: node --test tests/repo-address-rule.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRepoAddress, parseGithubUrl } = require('../src/workflow/rules/github-url.ts');

test('a stored address on either host gives its owner and name', () => {
  assert.deepEqual(parseRepoAddress('https://git.onhomeroom.com/apps/todo-list-b91765'), { owner: 'apps', repo: 'todo-list-b91765' });
  assert.deepEqual(parseRepoAddress('http://forgejo-http.forgejo:3000/apps/x.git'), { owner: 'apps', repo: 'x' });
  assert.deepEqual(parseRepoAddress('https://github.com/Usernode-Labs/social-vibecoding'), { owner: 'Usernode-Labs', repo: 'social-vibecoding' });
  assert.deepEqual(parseRepoAddress('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
});

test('anything else is no repository', () => {
  for (const bad of ['', null, 42, 'https://git.onhomeroom.com/apps', 'https://git.onhomeroom.com/apps/x/extra', 'ftp://h/o/r', 'https://h/o/r?x=1']) {
    assert.equal(parseRepoAddress(bad), null, String(bad));
  }
});

test('a person\'s import input is still GitHub only', () => {
  assert.equal(parseGithubUrl('https://git.onhomeroom.com/apps/x'), null);
});
