'use strict';

// The plan job's "Check whether this run can release" and "Select release
// work" steps, run as they are written in
// .github/workflows/build-kubernetes-images.yml against stand-ins for git, gh
// and the live chart lookup.
//
// Runs on main are queued one at a time, and a run whose commit is no longer
// main's tip used to build all three images and then skip its publish. In a
// burst of merges the run that would release waited behind builds nobody
// used. A run behind the tip that the publish step could not let release
// ahead of it now builds nothing: the newest release already contains it, or
// that release's revision merged under RELEASE_EVERY_MINUTES before it. The
// tip always builds, and anything unreadable builds, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { verifiedRun } = require('../scripts/reuse-kubernetes-postgres-check');

const ROOT = path.join(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
const plan = workflow.jobs.plan.steps;
const behindStep = plan.find((s) => s.name === 'Check whether this run can release');
const selectStep = plan.find((s) => s.name === 'Select release work');
const publishStep = workflow.jobs.release.steps.find((s) => s.name === 'Check branch tip before publishing');

const sha = (c) => c.repeat(40);
const OLD = sha('a'); // the newest release's revision
const MINE = sha('b'); // this run's revision
const TIP = sha('c'); // main's tip now
const T0 = 1_791_200_000;

const STUBS = {
  git: `#!/usr/bin/env bash
[ "$1" = ls-remote ] || exit 2
[ -s "$STUB_TIP" ] || exit 2
printf '%s\\t%s\\n' "$(cat "$STUB_TIP")" "$4"
`,
  gh: `#!/usr/bin/env bash
path="$2"
case "$path" in
  */compare/*) pair="\${path##*/compare/}"; key="compare \${pair%%...*} \${pair##*...}";;
  */commits/*) key="date \${path##*/commits/}";;
  *) exit 2;;
esac
value="$(sed -n "s/^$key //p" "$STUB_GH" | tail -n 1)"
[ -n "$value" ] || exit 1
echo "$value"
`,
  node: `#!/usr/bin/env bash
[ "$*" = 'scripts/live-release.js --metadata' ] || exit 2
echo "$*" >> "\${STUB_HELM_LOG:-/dev/null}"
sha="$(sed -n 's/^appVersion: //p' "$STUB_HELM")"
version="$(sed -n 's/^version: //p' "$STUB_HELM")"
[ -n "$sha" ] && [ -n "$version" ] || exit 1
printf '%s %s\\n' "$sha" "$version"
`,
};

function runBehind({ tip = TIP, gh = [], helm = `apiVersion: v2\nappVersion: ${OLD}\nversion: 0.1.1545001\n` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const files = {
    tip: path.join(dir, 'tip'), gh: path.join(dir, 'gh'), helm: path.join(dir, 'helm'),
    helmLog: path.join(dir, 'helm.log'), output: path.join(dir, 'output'), script: path.join(dir, 'step.sh'),
  };
  fs.writeFileSync(files.tip, tip || '');
  fs.writeFileSync(files.gh, gh.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(files.helm, helm || '');
  for (const f of ['helmLog', 'output']) fs.writeFileSync(files[f], '');
  fs.writeFileSync(files.script, behindStep.run);
  try {
    const res = spawnSync('bash', [files.script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REF: 'refs/heads/main', GITHUB_SHA: MINE, GITHUB_REPOSITORY: 'Usernode-Labs/social-vibecoding',
        GITHUB_REPOSITORY_OWNER: 'Usernode-Labs', GITHUB_OUTPUT: files.output,
        RELEASE_EVERY_MINUTES: String(behindStep.env.RELEASE_EVERY_MINUTES),
        STUB_TIP: files.tip, STUB_GH: files.gh, STUB_HELM: files.helm, STUB_HELM_LOG: files.helmLog,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = Object.fromEntries(fs.readFileSync(files.output, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { skip: out.skip === 'true', reason: out.reason || '', helmCalls: fs.readFileSync(files.helmLog, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// main moved on from this run's commit, the newest release is older than it,
// and the two revisions merged `minutes` apart.
const behind = (minutes) => [`compare ${OLD} ${MINE} ahead`, `date ${OLD} ${T0}`, `date ${MINE} ${T0 + minutes * 60}`];

test('the step runs only for pushes to main, and its interval is the publish step\'s', () => {
  assert.ok(behindStep && selectStep);
  assert.equal(workflow.jobs.plan.if, "github.ref == 'refs/heads/main'");
  assert.equal(behindStep.if, "github.event_name == 'push'");
  assert.equal(String(behindStep.env.RELEASE_EVERY_MINUTES), String(publishStep.env.RELEASE_EVERY_MINUTES));
  assert.ok(plan.indexOf(behindStep) < plan.indexOf(selectStep), 'decided before the release work is selected');
});

test('main\'s tip always builds', () => {
  assert.equal(runBehind({ tip: MINE, gh: behind(1) }).skip, false);
});

test('a run behind the tip that could not release ahead of it builds nothing', () => {
  const r = runBehind({ gh: behind(5) });
  assert.equal(r.skip, true);
  assert.match(r.reason, /^No build: main is at c{40}, whose run releases b{40}, and the newest release \(a{40}\) is under 15 minutes older/);
  assert.match(r.helmCalls, /^scripts\/live-release\.js --metadata/m,
    'the same promoted chart the publisher reads');
});

test('a run whose commit the newest release already contains builds nothing', () => {
  for (const status of ['behind', 'identical']) {
    const r = runBehind({ gh: [`compare ${OLD} ${MINE} ${status}`] });
    assert.equal(r.skip, true, status);
    assert.match(r.reason, /already contains b{40}/);
  }
});

test('a run behind the tip that may still release ahead of it builds, as the publish step allows', () => {
  assert.equal(runBehind({ gh: behind(15) }).skip, false, 'at the interval itself');
  assert.equal(runBehind({ gh: behind(66) }).skip, false);
});

test('anything that cannot be read builds, as before', () => {
  for (const [why, opts] of [
    ['tip unreadable', { tip: '', gh: behind(1) }],
    ['registry unreadable', { gh: behind(1), helm: '' }],
    ['no appVersion', { gh: behind(1), helm: 'apiVersion: v2\nversion: 0.1.1545001\n' }],
    ['compare unreadable', { gh: [`date ${OLD} ${T0}`, `date ${MINE} ${T0 + 60}`] }],
    ['diverged', { gh: [`compare ${OLD} ${MINE} diverged`, `date ${OLD} ${T0}`, `date ${MINE} ${T0 + 60}`] }],
    ['merge times unreadable', { gh: [`compare ${OLD} ${MINE} ahead`] }],
  ]) {
    assert.equal(runBehind(opts).skip, false, why);
  }
});

function runSelect(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-select-'));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  fs.writeFileSync(output, '');
  fs.writeFileSync(summary, '');
  try {
    const res = spawnSync('bash', ['-c', selectStep.run], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = fs.readFileSync(output, 'utf8');
    return { shouldRelease: /should_release=true/.test(out), lane: /^build_lane=(\d+)$/m.exec(out)?.[1], summary: fs.readFileSync(summary, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Select release work: a run that can release builds and publishes; one that cannot, neither', () => {
  const normal = runSelect({ GITHUB_EVENT_NAME: 'push', BEHIND_SKIP: 'false', GITHUB_RUN_NUMBER: '1601' });
  assert.equal(normal.shouldRelease, true);
  assert.equal(normal.lane, '1');
  const skipped = runSelect({ GITHUB_EVENT_NAME: 'push', BEHIND_SKIP: 'true', BEHIND_REASON: 'No build: main is at x.' });
  assert.equal(skipped.shouldRelease, false);
  assert.match(skipped.summary, /No build: main is at x\./);
  const dispatched = runSelect({ GITHUB_RUN_NUMBER: '1602' });
  assert.equal(dispatched.lane, '0');
  assert.equal(dispatched.shouldRelease, true, 'a run dispatched by hand is never held back');
  const claude = workflow.jobs.plan.steps.find((step) => step.id === 'claude');
  assert.equal(claude.if, "steps.release.outputs.should_release == 'true'");
  assert.ok(workflow.jobs.plan.steps.indexOf(claude) > workflow.jobs.plan.steps.indexOf(selectStep));
  assert.equal(workflow.jobs.build.if, "needs.plan.outputs.should_release == 'true'");
  assert.deepEqual([].concat(workflow.jobs.release.needs),
    ['plan', 'build', 'preview-schema-compatibility']);
});

function postgresResultFixture() {
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
  const f = postgresResultFixture();
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
    const f = postgresResultFixture();
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
    const f = postgresResultFixture();
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
    const f = postgresResultFixture();
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
    const f = postgresResultFixture();
    invalidate(f);
    assert.equal(f.result(), null);
    assert.equal(f.calls.length, 4);
  }
});
