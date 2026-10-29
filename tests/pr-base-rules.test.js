'use strict';

// Where an imported pull request merges (src/workflow/rules/pr-base.ts):
// "main" is its repository's default branch as GitHub names it, and every
// value past a GitHub read is the OTHER base, null when it is that branch.
//
// Run with: node --test tests/pr-base-rules.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { otherBase, defaultBranchOf, onMain } = require('../src/workflow/rules/pr-base.ts');

const pr = (ref, defaultBranch) => ({ base: { ref, repo: defaultBranch === undefined ? { full_name: 'acme/demo' } : { default_branch: defaultBranch } } });

test('the default branch is the one GitHub names, else main', () => {
  assert.equal(defaultBranchOf(pr('x', 'master')), 'master');
  assert.equal(defaultBranchOf(pr('x')), 'main', 'a payload that does not say');
  assert.equal(defaultBranchOf(null), 'main');
});

test('the other base: null on the default branch, the branch otherwise', () => {
  assert.equal(otherBase(pr('main', 'main')), null);
  assert.equal(otherBase(pr('main')), null);
  assert.equal(otherBase(pr('master', 'master')), null, 'a repository that calls it master');
  assert.equal(otherBase(pr('main', 'master')), 'main', 'a branch called main that is not the default');
  assert.equal(otherBase(pr('claude/sec09-parent', 'main')), 'claude/sec09-parent');
  assert.equal(otherBase({ base: {} }), null, 'GitHub named none');
  assert.equal(otherBase(null), null);
});

test('onMain reads an other base', () => {
  assert.equal(onMain(null), true);
  assert.equal(onMain(''), true);
  assert.equal(onMain(undefined), true);
  assert.equal(onMain('claude/sec09-parent'), false);
});
