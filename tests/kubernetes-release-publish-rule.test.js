'use strict';

// Release policy and its connections to the registry, Argo and Actions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { promoteChart } = require('../scripts/promote-kubernetes-chart');
const { chooseRelease, argoHasRolledOut, BATCH_WAIT_MS, ARGO_WAIT_MS, MAX_UNRELEASED_MS } =
  require('../scripts/choose-kubernetes-release');

const ROOT = path.join(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
const step = workflow.jobs.release.steps.find((s) => s.name === 'Check branch tip before publishing');

test('the Argo refresh skips only the published attempt that Argo is already syncing or has synced', t => {
  if (spawnSync('jq', ['--version']).status !== 0) return t.skip('jq is required to run the refresh step locally');
  const refreshWorkflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/refresh-kubernetes-release.yml'), 'utf8'));
  const refreshStep = refreshWorkflow.jobs.refresh.steps.find(s => s.name === 'Ask Argo CD to refresh the release');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh
for url do :; done
case "$url" in
  *'?refresh=hard') printf '200';;
  https://ghcr.io/token*) printf '{"token":"fixture"}';;
  https://ghcr.io/v2/*/manifests/release) printf 'Docker-Content-Digest: %s\\r\\n' "$FIXTURE_DIGEST";;
  *) printf '%s' "$FIXTURE_APPLICATION";;
esac
`, { mode: 0o755 });

  const chart = '0.1.5482002';
  const previousChart = '0.1.5482001';
  const digest = `sha256:${'a'.repeat(64)}`;
  const oldDigest = `sha256:${'b'.repeat(64)}`;
  const ociSpec = { sources: [{ repoURL: 'oci://ghcr.io/usernode-labs/charts/social-vibecoding-platform', targetRevision: 'release' }] };
  const operation = (phase, target, result = target, spec = {}) => JSON.stringify({ spec, status: { operationState: {
    phase, operation: { sync: { revisions: [target, 'values-revision'] } }, syncResult: { revisions: [result] },
  } } });
  const summary = path.join(dir, 'summary');
  for (const [description, response, skipped] of [
    ['exact chart running', operation('Running', chart, previousChart), `chart ${chart}`],
    ['exact chart succeeded', operation('Succeeded', chart), `chart ${chart}`],
    ['previous attempt is the active target', operation('Running', previousChart, chart)],
    ['exact chart failed', operation('Failed', chart)],
    ['OCI channel digest running', operation('Running', digest, oldDigest, ociSpec), `OCI release ${digest}`],
    ['OCI channel advanced beyond the active digest', operation('Succeeded', oldDigest, oldDigest, ociSpec)],
    ['digest from a different source', operation('Running', digest)],
    ['Argo status unavailable', ''],
  ]) {
    fs.writeFileSync(summary, '');
    const result = spawnSync('bash', ['-e', '-c', refreshStep.run], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        RELEASE_RUN_NUMBER: '5482', RELEASE_ATTEMPT: '2', FIXTURE_APPLICATION: response,
        REGISTRY_OWNER: 'Usernode-Labs', FIXTURE_DIGEST: digest,
        ARGOCD_REFRESH_TOKEN: 'fixture-only', ARGOCD_SERVER: 'argo.example.test',
        ARGOCD_APPLICATION: 'platform', GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(summary, 'utf8').trim(), skipped
      ? `Argo CD already started syncing ${skipped}.`
      : 'Argo CD re-read the chart registry and compared platform.', description);
  }
});

test('chart promotion advances only to an eligible verified digest and retries idempotently', async () => {
  const version = '0.1.100';
  const revision = 'a'.repeat(40);
  const candidate = { version, digest: 'candidate-digest', bytes: Buffer.from('candidate'), configDigest: 'candidate-config' };
  const newer = { version: '0.1.101', digest: 'newer-digest' };
  let active = null;
  let rejectedWrite = false;
  let revisionOnRegistry = revision;
  const writes = [];
  const registry = {
    manifest: async reference => reference === 'release' ? active : candidate,
    config: async () => ({ name: 'social-vibecoding-platform', version, appVersion: revisionOnRegistry }),
    putRelease: async bytes => {
      writes.push(bytes);
      if (!rejectedWrite) active = candidate;
    },
  };
  const promote = (latest = version) => promoteChart({ version, revision, registry, newestVersion: async () => latest });
  await assert.rejects(promote(newer.version), /initialize.*older chart/);
  active = newer;
  assert.deepEqual(await promote(), { version: newer.version, digest: newer.digest, updated: false });
  active = { ...candidate, digest: 'different-digest' };
  await assert.rejects(promote(), /different digest/);
  active = null;
  revisionOnRegistry = 'b'.repeat(40);
  await assert.rejects(promote(), /config does not match/);
  assert.deepEqual(writes, []);
  revisionOnRegistry = revision;
  rejectedWrite = true;
  await assert.rejects(promote(), { retryable: true });
  rejectedWrite = false;
  assert.deepEqual(await promote(), { version, digest: candidate.digest, updated: true });
  assert.deepEqual(await promote(), { version, digest: candidate.digest, updated: false });
  assert.deepEqual(writes, [candidate.bytes, candidate.bytes]);
});

const OLD = '9a412e74dfbe9cbbe0da01c3ef7a715b564dd90b'; // #6945, healthy before the burst
const EARLIER = '142aa57f100c700d4fef1815218dc993966ea3d1'; // #6940
const LATEST = 'f8ef76bf71278dbb45f8ca31c7618ffdc5699a4b'; // #6942
const DIGEST = 'sha256:4f4e5eb4af1a1656d8c028befc02544c515b01535f94c5bb80e831c7dbbf44da';
const REPO = 'usernode-labs/charts/social-vibecoding-platform';
const earliestMerge = Date.parse('2026-11-20T18:27:17Z');
const firstDecision = Date.parse('2026-11-20T18:32:16Z');
const earlier = { sha: EARLIER, version: '0.1.5504001', number: 5504 };
const latest = { sha: LATEST, version: '0.1.5505001', number: 5505 };
const last = { revision: OLD, digest: DIGEST, version: '0.1.5503001' };
const latestRun = { id: 44792978955, event: 'push', head_sha: LATEST, run_number: 5505, status: 'in_progress' };
const checkedJobs = ['Plan image release', 'Resolve platform image', 'Resolve worker image', 'Resolve capture image',
  'Preview schema compatibility (PostgreSQL 17/18) / PostgreSQL 17 and 18']
  .map(name => ({ name, conclusion: 'success', status: 'completed' }));
const waitingPublisher = { name: 'Publish atomic Helm release', status: 'queued' };

function argoStatus({ digest = DIGEST, health = 'Healthy', sync = 'Synced', phase = 'Succeeded',
  result = digest, operation = null, chart = REPO } = {}) {
  // Real production has the chart and a separate Git source for Helm values.
  return {
    spec: { sources: [{ repoURL: `oci://ghcr.io/${chart}`, targetRevision: 'release' }, { repoURL: 'values-repo' }] },
    operation,
    status: {
      sync: { status: sync, revisions: [digest, 'values-sha'] },
      health: { status: health },
      operationState: { phase, syncResult: { revisions: [result, 'values-sha'] } },
    },
  };
}

function replay(options = {}) {
  let now = options.at ?? firstDecision;
  const start = now;
  const clock = () => now - start;
  const order = [OLD, EARLIER, LATEST];
  return {
    clock,
    decide: candidate => chooseRelease(candidate, {
      tip: async () => options.tip?.(clock()) ?? LATEST,
      previous: async () => options.previous ? options.previous() : last,
      async compare(base, head) {
        const before = order.indexOf(base);
        const after = order.indexOf(head);
        return {
          status: before < 0 || after < 0 ? 'diverged' : before < after ? 'ahead' : 'behind',
          commits: [{ commit: { committer: { date: new Date(earliestMerge).toISOString() } } }],
        };
      },
      peers: async () => options.peers ? options.peers(clock()) : [latestRun],
      jobs: async run => options.jobs ? options.jobs(clock(), run) : [...checkedJobs, waitingPublisher],
      healthy: async digest => argoHasRolledOut(options.argo ? options.argo(clock()) : argoStatus(), REPO, digest),
      now: () => now,
      wait: async milliseconds => { now += milliseconds; },
      log: () => {},
    }),
  };
}

test('the workflow grants Actions read access and calls the gated publisher only after verification', () => {
  assert.equal(step.run, 'node scripts/choose-kubernetes-release.js');
  assert.equal(step.env.ARGOCD_REFRESH_TOKEN, '${{ secrets.ARGOCD_REFRESH_TOKEN }}');
  assert.equal(workflow.jobs.release.permissions.actions, 'read');
  assert.match(workflow.jobs.release.if, /needs\.build\.result == 'success'/);
  assert.match(workflow.jobs.release.if, /result == 'skipped' && needs.plan.outputs.postgres_verified == 'true'/);
  assert.ok(step['timeout-minutes'] * 60_000 > ARGO_WAIT_MS);
});

test('replay #6940/#6942 using the published production job timestamps: only #6942 ships', async () => {
  // Runs 44792913479 and 44792978955. The merges were 27 seconds apart.
  // #6942 was verified at 18:31:56Z. At #6940's 18:32:16Z decision it
  // had all its digests and could enter the publisher as soon as the lock freed.
  const fixture = replay();
  const first = await fixture.decide(earlier);
  assert.equal(first.publish, false);
  assert.match(first.reason, /Verified run 5505/);
  const second = await fixture.decide(latest);
  assert.equal(second.publish, true);
  assert.equal(fixture.clock(), 0, 'the already healthy chart allows immediate publication');
  assert.deepEqual([first, second].filter(decision => decision.publish), [second]);
});

test('replay a failed newer build: the earlier verified commit still ships', async () => {
  const fixture = replay({ jobs: elapsed => {
    const status = elapsed >= 20_000 ? 'failure' : null;
    return checkedJobs.map(job => job.name === 'Resolve worker image'
      ? { ...job, status: status ? 'completed' : 'in_progress', conclusion: status }
      : job);
  } });
  assert.equal((await fixture.decide(earlier)).publish, true);
  assert.equal(fixture.clock(), 20_000, 'the check failure ends the batching wait immediately');
  const failed = replay({ peers: () => [{ ...latestRun, status: 'completed', conclusion: 'failure' }] });
  assert.equal((await failed.decide(earlier)).publish, true);
  assert.equal(failed.clock(), 0);
});

test('an unfinished newer build gets a bounded chance and can still win', async () => {
  const unfinished = checkedJobs.filter(job => job.name !== 'Resolve worker image');
  const becomesReady = replay({ jobs: elapsed => elapsed >= 30_000
    ? [...checkedJobs, waitingPublisher] : [...unfinished, waitingPublisher] });
  assert.equal((await becomesReady.decide(earlier)).publish, false);
  assert.equal(becomesReady.clock(), 30_000, 'a queue entry alone is not verification');
  const neverReady = replay({ jobs: () => unfinished });
  assert.equal((await neverReady.decide(earlier)).publish, true);
  assert.equal(neverReady.clock(), BATCH_WAIT_MS);
  const unknown = replay({ peers: () => undefined });
  assert.equal((await unknown.decide(earlier)).publish, true);
  assert.equal(unknown.clock(), BATCH_WAIT_MS, 'a newer push without a visible run can still register');
});

test('the oldest unpublished merge starts the anti-starvation clock', async () => {
  const overdue = replay({ at: earliestMerge + MAX_UNRELEASED_MS });
  assert.equal((await overdue.decide(earlier)).publish, true);
  assert.equal(overdue.clock(), 0);
});

test('rollout health requires the promoted digest, successful sync and no queued operation', () => {
  assert.equal(argoHasRolledOut(argoStatus(), REPO, DIGEST), true);
  for (const overrides of [
    { digest: 'sha256:' + 'a'.repeat(64) }, { result: 'sha256:' + 'b'.repeat(64) },
    { health: 'Progressing' }, { health: 'Degraded' }, { sync: 'OutOfSync' },
    { phase: 'Running' }, { phase: 'Failed' }, { operation: {} }, { chart: 'wrong-chart' },
  ]) assert.equal(argoHasRolledOut(argoStatus(overrides), REPO, DIGEST), false, JSON.stringify(overrides));
  assert.equal(argoHasRolledOut(null, REPO, DIGEST), false);
});

test('publish as soon as the exact rollout is healthy, or fail closed if status stays unavailable', async () => {
  const progress = replay({ argo: elapsed => argoStatus({ health: elapsed < 70_000 ? 'Progressing' : 'Healthy' }) });
  assert.equal((await progress.decide(latest)).publish, true);
  assert.equal(progress.clock(), 70_000);
  const unavailable = replay({ argo: () => null });
  await assert.rejects(unavailable.decide(latest), /Argo CD did not report.*within 6 minutes/);
  assert.equal(unavailable.clock(), ARGO_WAIT_MS);
  const registryUnavailable = replay({ previous: () => null });
  await assert.rejects(registryUnavailable.decide(latest), /Could not read the promoted OCI chart/);
});

test('branch movement during an Argo wait gives the newer verified candidate the slot', async () => {
  const fixture = replay({ tip: elapsed => elapsed < 10_000 ? EARLIER : LATEST,
    peers: elapsed => elapsed < 10_000 ? [] : [latestRun], argo: () => null });
  assert.equal((await fixture.decide(earlier)).publish, false);
  assert.equal(fixture.clock(), 10_000);
});

test('manual recovery bypasses Argo health and preserves revision and chart order', async () => {
  const manual = { ...latest, manual: true };
  const fixture = replay({ argo: () => null });
  assert.equal((await fixture.decide(manual)).publish, true);
  assert.equal(fixture.clock(), 0);
  const alreadyPromoted = replay({ previous: () => ({ ...last, version: latest.version, revision: LATEST }) });
  assert.equal((await alreadyPromoted.decide(manual)).publish, false);
  const disappeared = replay({ tip: () => 'e'.repeat(40) });
  assert.equal((await disappeared.decide(manual)).publish, false);
  const behind = replay({ previous: () => ({ ...last, revision: LATEST }) });
  assert.equal((await behind.decide(earlier)).publish, false);
});

test('a verified manual dispatch for the same SHA takes over when it reaches the queue', async () => {
  const fixture = replay({
    peers: () => [{ ...latestRun, event: 'workflow_dispatch', run_number: 5506 }],
    argo: () => null,
  });
  assert.equal((await fixture.decide(latest)).publish, false);
  assert.equal(fixture.clock(), 0);
});
