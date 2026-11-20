'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { liveReleaseMetadata } = require('./live-release');

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^0\.1\.(0|[1-9][0-9]*)$/;
const PUBLISH_JOB = 'Publish atomic Helm release';
const REQUIRED_JOBS = ['Plan image release', 'Resolve platform image', 'Resolve worker image', 'Resolve capture image'];
const QUEUED = new Set(['queued', 'pending', 'waiting', 'in_progress']);
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const BATCH_WAIT_MS = 90_000;
const MAX_UNRELEASED_MS = 15 * 60_000;
const ARGO_WAIT_MS = 6 * 60_000;
const POLL_MS = 10_000;

function argoHasRolledOut(application, repository, digest) {
  const sources = application?.spec?.sources;
  if (!Array.isArray(sources)) return false;
  const source = sources.findIndex(entry =>
    entry?.repoURL === `oci://ghcr.io/${repository}` && entry.targetRevision === 'release');
  const status = application?.status;
  return source >= 0 && DIGEST.test(digest)
    && application.operation == null && status?.sync?.status === 'Synced'
    && status.health?.status === 'Healthy' && status.sync.revisions?.[source] === digest
    && status.operationState?.phase === 'Succeeded'
    && status.operationState.syncResult?.revisions?.[source] === digest;
}

async function chooseRelease(candidate, { previous, tip, compare, peers, jobs, healthy,
  now = Date.now, wait = sleep, log = console.log }) {
  const started = now();
  const { sha, version, number, manual } = candidate;
  const active = await previous();
  if (!active) throw new Error('Could not read the promoted OCI chart. Retry after the registry is available.');
  if (BigInt(active.version.split('.').at(-1)) >= BigInt(version.split('.').at(-1))) {
    return { publish: false, reason: `The promoted chart (${active.version}) is numbered at or above ${version}.` };
  }
  const sinceActive = active.revision === sha ? null : await compare(active.revision, sha);
  if (sinceActive && !sinceActive.status) throw new Error('Could not compare with the promoted revision.');
  if (sinceActive && sinceActive.status !== 'ahead') {
    return { publish: false, reason: `This revision does not advance the promoted revision (${active.revision}).` };
  }
  const oldest = Date.parse(sinceActive?.commits?.[0]?.commit?.committer?.date);
  let branch;
  let branchContainsCandidate = false;
  let waitingFor = '';

  while (true) {
    const currentTip = await tip();
    if (branch !== currentTip) {
      branch = currentTip;
      const relation = branch === sha ? 'identical' : (await compare(sha, branch)).status;
      if (!relation) throw new Error('Could not compare with the tip of main.');
      branchContainsCandidate = relation === 'identical' || relation === 'ahead';
    }
    if (!branchContainsCandidate) {
      return { publish: false, reason: `The tip of main (${branch}) does not contain this revision.` };
    }
    if (manual) return { publish: true, reason: 'This verified release was dispatched by hand.' };

    const due = Number.isFinite(oldest) && now() - oldest >= MAX_UNRELEASED_MS;
    const runs = await peers();
    // A push can be visible on main just before Actions creates its run.
    let pending = branch !== sha && !runs?.some(run => run.head_sha === branch && run.run_number > number);
    const descendants = (runs || []).filter(run => run.run_number > number && run.status !== 'completed');
    for (const run of descendants) {
      const revision = run.head_sha;
      const dispatched = run.event === 'workflow_dispatch';
      if (!dispatched && (due || revision === sha)) continue;
      if (revision !== branch && revision !== sha) {
        if ((await compare(sha, revision)).status !== 'ahead'
            || (await compare(revision, branch)).status !== 'ahead') continue;
      }
      const steps = await jobs(run);
      const publisher = steps?.find(job => job.name === PUBLISH_JOB);
      if (steps?.some(job => FAILED.has(job.conclusion)) || publisher?.status === 'completed') continue;
      const postgres = steps?.find(job => job.name.startsWith('Preview schema compatibility (PostgreSQL 17/18)'));
      // The publication job's needs enforce exact-tree evidence if
      // the standalone PostgreSQL job was skipped.
      if (QUEUED.has(publisher?.status) && ['success', 'skipped'].includes(postgres?.conclusion)
          && REQUIRED_JOBS.every(name => steps.some(job => job.name === name && job.conclusion === 'success'))) {
        return { publish: false, reason: `Verified run ${run.run_number} (${revision}) can publish from the release queue.` };
      }
      if (revision !== sha) pending = true;
    }

    const rolledOut = await healthy(active.digest);
    if (rolledOut && (due || !pending || now() - started >= BATCH_WAIT_MS)) {
      return { publish: true, reason: `Argo CD reports the promoted chart ${active.digest} synced and healthy.` };
    }
    if (now() - started >= ARGO_WAIT_MS) {
      throw new Error(`Argo CD did not report the promoted chart ${active.digest} synced and healthy within ${ARGO_WAIT_MS / 60_000} minutes. Inspect the rollout or use a verified manual release to recover.`);
    }
    const reason = rolledOut ? 'Waiting briefly for a newer build to finish.' : `Waiting for Argo CD to finish rolling out ${active.digest}.`;
    if (reason !== waitingFor) {
      log(reason);
      waitingFor = reason;
    }
    const deadline = started + (rolledOut ? BATCH_WAIT_MS : ARGO_WAIT_MS);
    await wait(Math.max(0, Math.min(POLL_MS, deadline - now())));
  }
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main(env) {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF: ref, GITHUB_SHA: sha, CHART_VERSION: version,
    GITHUB_RUN_NUMBER: runNumber, GITHUB_EVENT_NAME: event, GH_TOKEN: ghToken, ARGOCD_REFRESH_TOKEN: argoToken } = env;
  const manual = event === 'workflow_dispatch';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || ref !== 'refs/heads/main' || !SHA.test(sha)
      || !VERSION.test(version) || !/^[1-9][0-9]*$/.test(runNumber) || !ghToken) {
    throw new Error('Invalid Kubernetes release workflow environment.');
  }
  const owner = repo.split('/')[0].toLowerCase();
  const repository = `${owner}/charts/social-vibecoding-platform`;
  const gh = route => getJson(`https://api.github.com/repos/${repo}/${route}`, ghToken);
  const comparisons = new Map();
  const decision = await chooseRelease({ sha, version, number: Number(runNumber), manual }, {
    previous: () => liveReleaseMetadata(owner),
    async tip() {
      const { stdout } = await exec('git', ['ls-remote', '--exit-code', 'origin', ref], { timeout: 5000 });
      const tip = stdout.split(/\s+/)[0];
      if (!SHA.test(tip)) throw new Error('Could not read the current tip of main.');
      return tip;
    },
    async compare(base, head) {
      const range = `${base}...${head}`;
      if (!comparisons.has(range)) {
        const result = await gh(`compare/${range}?per_page=1&page=1`).catch(() => ({}));
        if (result.status) comparisons.set(range, result);
        return result;
      }
      return comparisons.get(range);
    },
    async peers() {
      const page = await gh('actions/workflows/build-kubernetes-images.yml/runs?branch=main&per_page=30').catch(() => null);
      return page?.workflow_runs?.filter(run => run.head_branch === 'main'
        && run.head_repository?.full_name?.toLowerCase() === repo.toLowerCase()
        && (run.event === 'push' || run.event === 'workflow_dispatch')
        && SHA.test(run.head_sha) && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt));
    },
    async jobs(run) {
      const result = await gh(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).catch(() => null);
      return result?.jobs;
    },
    async healthy(digest) {
      if (!argoToken) throw new Error('ARGOCD_REFRESH_TOKEN is required to verify the previous rollout.');
      const application = await getJson(
        'https://argocd.platform.beta.usernodelabs.org/api/v1/applications/social-vibecoding-platform', argoToken
      ).catch(() => null);
      return argoHasRolledOut(application, repository, digest);
    },
  });
  const message = `${decision.publish ? 'Publishing' : 'Skipping'} ${sha}: ${decision.reason}`;
  console.log(message);
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  fs.appendFileSync(env.GITHUB_OUTPUT, `publish=${decision.publish}\n`);
}

if (require.main === module) {
  main(process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { chooseRelease, argoHasRolledOut, BATCH_WAIT_MS, ARGO_WAIT_MS, MAX_UNRELEASED_MS };
