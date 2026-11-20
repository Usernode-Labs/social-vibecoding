'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifiedRun } = require('../scripts/reuse-kubernetes-postgres-check');

function fixture() {
  const tree = 'a'.repeat(40);
  const revision = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const revisionInfo = { repo: 'Usernode-Labs/social-vibecoding', repoId: 123, revision, tree };
  const root = `repos/${revisionInfo.repo}`;
  const runPath = `${root}/actions/runs/99`;
  const artifactName = `postgres-17-18-v1-pr19-attempt2-${tree}`;
  const pull = {
    number: 19, merged_at: '2026-11-20T12:00:00Z', merge_commit_sha: revision,
    base: { ref: 'main', repo: { id: 123 } },
    head: { sha: head, repo: { id: 456 } },
  };
  const run = {
    id: 99, run_attempt: 2, path: '.github/workflows/kubernetes-pr-checks.yml',
    event: 'pull_request', status: 'completed', conclusion: 'success',
    head_sha: head, head_repository: { id: 456 }, pull_requests: [],
  };
  const artifact = {
    name: artifactName, expired: false,
    workflow_run: { id: 99, head_sha: head, repository_id: 123 },
  };
  const job = {
    name: 'Preview schema compatibility (PostgreSQL 17/18) / PostgreSQL 17 and 18',
    conclusion: 'success',
    steps: [
      { name: 'Verify database identities and tenant copies', conclusion: 'success' },
      { name: 'Publish PostgreSQL check result', conclusion: 'success' },
    ],
  };
  const responses = {
    [`${root}/commits/${revision}/pulls?per_page=25`]: [pull],
    [`${root}/actions/workflows/kubernetes-pr-checks.yml/runs?event=pull_request&status=success&head_sha=${head}&per_page=3`]: { workflow_runs: [run] },
    [`${runPath}/artifacts?name=${artifactName}`]: { artifacts: [artifact] },
    [`${runPath}/attempts/2/jobs?per_page=100`]: { jobs: [job] },
  };
  const calls = [];
  return {
    result: () => verifiedRun(revisionInfo, (path) => {
      calls.push(path);
      return responses[path] ?? { artifacts: [] };
    }),
    calls, pull, run, job, artifact,
  };
}

test('a successful PostgreSQL run for the exact tree can be reused without downloading artifacts', () => {
  const f = fixture();
  assert.equal(f.result(), 99);
  assert.equal(f.calls.length, 4);
  assert.match(f.calls.at(-1), /\/attempts\/2\/jobs/);
});

test('a direct push, different merge, or different repository has no reusable result', () => {
  for (const invalidate of [
    (f) => { f.pull.merged_at = null; },
    (f) => { f.pull.merge_commit_sha = 'd'.repeat(40); },
    (f) => { f.pull.base.ref = 'candidate'; },
    (f) => { f.pull.base.repo.id = 999; },
  ]) {
    const f = fixture();
    invalidate(f);
    assert.equal(f.result(), null);
    assert.equal(f.calls.length, 1);
  }
});

test('results from the wrong workflow, commit, or fork cannot authorize release', () => {
  for (const invalidate of [
    (f) => { f.run.path = '.github/workflows/other.yml'; },
    (f) => { f.run.event = 'push'; },
    (f) => { f.run.conclusion = 'failure'; },
    (f) => { f.run.head_sha = 'd'.repeat(40); },
    (f) => { f.run.head_repository.id = 999; },
  ]) {
    const f = fixture();
    invalidate(f);
    assert.equal(f.result(), null);
    assert.equal(f.calls.length, 2);
  }
});

test('a different tree, PR, or attempt and an expired or unrelated artifact cannot be reused', () => {
  for (const invalidate of [
    (f) => { f.artifact.name = f.artifact.name.replace(/a{40}$/, 'd'.repeat(40)); },
    (f) => { f.artifact.name = f.artifact.name.replace('pr19', 'pr20'); },
    (f) => { f.run.run_attempt = 3; },
    (f) => { f.artifact.expired = true; },
    (f) => { f.artifact.workflow_run.id = 31; },
    (f) => { f.artifact.workflow_run.repository_id = 999; },
  ]) {
    const f = fixture();
    invalidate(f);
    assert.equal(f.result(), null);
    assert.equal(f.calls.length, 3);
  }
});

test('a missing, skipped, or failed PostgreSQL step requires fresh release checks', () => {
  for (const invalidate of [
    (f) => { f.job.conclusion = 'failure'; },
    (f) => { f.job.steps.pop(); },
    (f) => { f.job.steps[0].conclusion = 'skipped'; },
  ]) {
    const f = fixture();
    invalidate(f);
    assert.equal(f.result(), null);
    assert.equal(f.calls.length, 4);
  }
});
