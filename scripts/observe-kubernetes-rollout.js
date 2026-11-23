'use strict';

const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { connectRegistry } = require('./promote-kubernetes-chart');

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function recordArgo(timing, application, repository, digest, observedAt) {
  const source = application?.spec?.sources?.findIndex(entry =>
    entry.repoURL === `oci://ghcr.io/${repository}` && entry.targetRevision === 'release');
  if (source == null || source < 0) return;

  const status = application.status;
  const operation = status?.operationState;
  const compared = status?.sync?.revisions?.[source] === digest;
  if (compared) timing.comparison ??= observedAt;

  // The sync can report its requested revision before it has a result.
  const requested = operation?.operation?.sync?.revisions?.[source];
  const resolved = operation?.syncResult?.revisions?.[source];
  const requestedMatches = (requested ?? resolved) === digest;
  const resultMatches = requestedMatches && resolved === digest;
  if (requestedMatches) {
    timing.syncStarted ??= operation.startedAt;
    if (resultMatches) {
      const migration = operation.syncResult.resources?.find(resource => resource.kind === 'Job'
        && resource.syncPhase === 'Sync' && resource.name?.endsWith('-migrate'));
      if (migration?.hookPhase === 'Succeeded') timing.migration ??= observedAt;
      if (operation.phase === 'Succeeded') timing.syncFinished ??= operation.finishedAt;
    }
  }

  // Retained history can recover exact sync timestamps after another
  // operation starts. It has no timestamps for individual hooks or traffic.
  const history = status?.history?.find(entry => entry.revisions?.[source] === digest);
  timing.syncStarted ??= history?.deployStartedAt;
  timing.syncFinished ??= history?.deployedAt;
  if (compared && status.sync.status === 'Synced' && status.health?.status === 'Healthy'
      && operation?.phase === 'Succeeded' && resultMatches && application.operation == null) {
    timing.healthy ??= observedAt;
  }
}

async function observeRollout({ repository, digest, sha, readArgo, readVersion,
  now = Date.now, wait = sleep, limit = 240_000 }) {
  const deadline = now() + limit;
  const timing = {};
  while (now() < deadline) {
    const nextPoll = now() + 10_000;
    const [application, version] = await Promise.all([
      readArgo().catch(() => null),
      timing.serving ? null : readVersion().catch(() => null),
    ]);
    const observedAt = new Date(now()).toISOString();
    recordArgo(timing, application, repository, digest, observedAt);
    if (version?.sha === sha) timing.serving = observedAt;
    if (timing.healthy && timing.serving) break;
    const pause = Math.min(deadline, nextPoll) - now();
    if (pause > 0) await wait(pause);
  }
  return timing;
}

async function readJson(url, headers) {
  const response = await fetch(url, {
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  return response.json();
}

function renderTiming({ version, sha, digest, promotedAt, timing }) {
  const summary = [`### Rollout of ${version}`, '',
    `Source \`${sha}\`, chart \`${digest}\``, '',
    '| Milestone | UTC | Seconds after promotion step |',
    '| --- | --- | ---: |'];
  const start = Date.parse(promotedAt);
  for (const [label, value] of [
    ['Promotion step completed', promotedAt],
    ['Compared digest first observed in Argo', timing.comparison],
    ['Argo sync started', timing.syncStarted],
    ['Migration success first observed in Argo', timing.migration],
    ['Argo sync finished', timing.syncFinished],
    ['Synced and healthy first observed in Argo', timing.healthy],
    ['Exact source SHA first served by Homeroom', timing.serving],
  ]) {
    const at = Date.parse(value);
    summary.push(Number.isFinite(at)
      ? `| ${label} | ${new Date(at).toISOString()} | ${Math.round((at - start) / 1000)} |`
      : `| ${label} | Unobserved | |`);
  }
  summary.push('', 'Observations are sampled every 10 seconds. Argo records sync start and finish directly.', '');
  return summary.join('\n');
}

async function main(env) {
  const { ARGOCD_REFRESH_TOKEN: token, REGISTRY_OWNER: owner, SOURCE_SHA: sha,
    RELEASE_RUN_NUMBER: number, RELEASE_ATTEMPT: attempt, PROMOTED_AT: promotedAt } = env;
  if (!token) {
    console.log('Rollout timing unavailable because the Argo read token is missing.');
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner || '') || !shaPattern.test(sha || '')
      || !/^[1-9]\d*$/.test(number || '') || !/^[1-9]\d*$/.test(attempt || '')
      || !Number.isFinite(Date.parse(promotedAt))) {
    throw new Error('Invalid rollout observation inputs');
  }

  const repository = `${owner.toLowerCase()}/charts/social-vibecoding-platform`;
  const version = `0.1.${BigInt(number) * 1000n + BigInt(attempt)}`;
  const registry = await connectRegistry(repository);
  const chart = await registry.manifest(version);
  if (chart?.version !== version || !digestPattern.test(chart?.digest || '')) {
    throw new Error('Could not identify the immutable promoted chart');
  }
  const config = await registry.config(chart.configDigest);
  if (config.appVersion !== sha || config.version !== version) {
    throw new Error('Published chart does not match the workflow revision');
  }

  const digest = chart.digest;
  const timing = await observeRollout({
    repository, digest, sha,
    readArgo: () => readJson('https://argocd.platform.beta.usernodelabs.org/api/v1/applications/social-vibecoding-platform',
      { Authorization: `Bearer ${token}` }),
    readVersion: () => readJson('https://app.onhomeroom.com/api/version'),
  });
  const summary = renderTiming({ version, sha, digest, promotedAt, timing });
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}

if (require.main === module) {
  main(process.env).catch(error => {
    console.error(`Rollout observation unavailable: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { observeRollout, renderTiming };
