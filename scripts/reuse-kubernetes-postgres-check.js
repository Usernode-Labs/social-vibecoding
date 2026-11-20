'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const workflow = 'kubernetes-pr-checks.yml';
const databaseJob = 'Preview schema compatibility (PostgreSQL 17/18) / PostgreSQL 17 and 18';
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;

function githubApi(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }));
}

function verifiedRun({ repo, repoId, revision, tree }, read = githubApi) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !validId(repoId) || !validSha(revision) || !validSha(tree)) return null;
  const path = `repos/${repo}`;
  const pulls = read(`${path}/commits/${revision}/pulls?per_page=25`);
  const merged = pulls.filter((pr) => pr.merged_at && pr.merge_commit_sha === revision
    && pr.base?.ref === 'main' && pr.base.repo?.id === repoId);
  if (merged.length !== 1) return null;

  const pr = merged[0];
  if (!validId(pr.number) || !validSha(pr.head?.sha) || !validId(pr.head.repo?.id)) return null;
  const { workflow_runs: runs } = read(
    `${path}/actions/workflows/${workflow}/runs?event=pull_request&status=success&head_sha=${pr.head.sha}&per_page=3`
  );
  for (const run of runs) {
    if (!validId(run.id) || !validId(run.run_attempt)
        || run.path !== `.github/workflows/${workflow}` || run.event !== 'pull_request'
        || run.status !== 'completed' || run.conclusion !== 'success'
        || run.head_sha !== pr.head.sha || run.head_repository?.id !== pr.head.repo.id) continue;

    // GitHub can omit pull_requests for a fork. The artifact names the PR,
    // successful attempt, and checked-out tree. Read metadata only.
    const name = `postgres-17-18-v1-pr${pr.number}-attempt${run.run_attempt}-${tree}`;
    const runPath = `${path}/actions/runs/${run.id}`;
    const { artifacts } = read(`${runPath}/artifacts?name=${name}`);
    if (!artifacts.some((artifact) => artifact.name === name && artifact.expired === false
        && artifact.workflow_run?.id === run.id && artifact.workflow_run.repository_id === repoId
        && artifact.workflow_run.head_sha === pr.head.sha)) continue;

    const { jobs } = read(`${runPath}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const db = jobs.find((job) => job.name === databaseJob && job.conclusion === 'success');
    if (db?.steps.some((step) => step.name === 'Verify database identities and tenant copies' && step.conclusion === 'success')
        && db.steps.some((step) => step.name === 'Publish PostgreSQL check result' && step.conclusion === 'success')) return run.id;
  }
  return null;
}

function main(env) {
  let run;
  try {
    const tree = execFileSync('git', ['rev-parse', '--verify', `${env.GITHUB_SHA}^{tree}`], { encoding: 'utf8' }).trim();
    run = verifiedRun({ repo: env.GITHUB_REPOSITORY, repoId: Number(env.GITHUB_REPOSITORY_ID), revision: env.GITHUB_SHA, tree });
  } catch {
    console.log('Could not verify a prior PostgreSQL result. Running the release checks.');
  }
  fs.appendFileSync(env.GITHUB_OUTPUT, `verified=${Boolean(run)}\n`);
  const summary = run
    ? `PostgreSQL 17/18: reused a pass for this exact tree from [run ${run}](${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${run}).`
    : 'PostgreSQL 17/18: running the release checks for this tree.';
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (require.main === module) main(process.env);
module.exports = { verifiedRun };
