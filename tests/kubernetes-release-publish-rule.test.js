'use strict';

// The release job's "Check branch tip before publishing" step, run as it is
// written in .github/workflows/build-kubernetes-images.yml, against stand-ins
// for git, gh and helm.
//
// On 5 October 2026 merges landed every two to four minutes while each run
// took three to twelve. Runs are queued one at a time, so every run found a
// newer tip, skipped publishing, and nothing deployed from 16:12 to about
// 17:50 UTC. The tip still always publishes. A stable run behind the tip now
// publishes too, when the branch contains it, the newest release in the
// registry is older and numbered below it, and that release's revision was
// merged at least RELEASE_EVERY_MINUTES before this one. An older revision
// must never publish over a newer one: Argo CD runs the highest 0.1.* chart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
const step = workflow.jobs.release.steps.find((s) => s.name === 'Check branch tip before publishing');

const sha = (c) => c.repeat(40);
const OLD = sha('a'); // the newest release's revision
const MINE = sha('b'); // this run's revision
const TIP = sha('c'); // the branch tip now
const T0 = 1_791_200_000; // when OLD merged (epoch seconds)

const STUBS = {
  git: `#!/usr/bin/env bash
[ "$1" = ls-remote ] || exit 2
printf '%s\\t%s\\n' "$STUB_TIP" "$5"
`,
  gh: `#!/usr/bin/env bash
path="$2"
case "$path" in
  */compare/*) pair="\${path##*/compare/}"; key="compare \${pair%%...*} \${pair##*...}";;
  */commits/*) key="date \${path##*/commits/}";;
  *) exit 2;;
esac
line="$(grep -F -- "$key " "$STUB_GH" | head -n 1)" || exit 1
echo "\${line##* }"
`,
  helm: `#!/usr/bin/env bash
[ -s "$STUB_HELM" ] || exit 1
cat "$STUB_HELM"
`,
};

function run({
  channel = 'stable', chartVersion = '0.1.1600001', tip = TIP,
  gh = [], helm = `apiVersion: v2\nappVersion: ${OLD}\nname: social-vibecoding-platform\nversion: 0.1.1545001\n`,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-rule-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  const files = {
    gh: path.join(dir, 'gh.txt'),
    helm: path.join(dir, 'helm.txt'),
    output: path.join(dir, 'output'),
    summary: path.join(dir, 'summary'),
    script: path.join(dir, 'step.sh'),
  };
  fs.writeFileSync(files.gh, gh.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(files.helm, helm || '');
  fs.writeFileSync(files.output, '');
  fs.writeFileSync(files.summary, '');
  fs.writeFileSync(files.script, step.run);
  const res = spawnSync('bash', ['-e', files.script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      GITHUB_SHA: MINE,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'Usernode-Labs/social-vibecoding',
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      GH_TOKEN: 'test',
      RELEASE_CHANNEL: channel,
      CHART_VERSION: chartVersion,
      CHART_REF: 'oci://ghcr.io/usernode-labs/charts/social-vibecoding-platform',
      RELEASE_EVERY_MINUTES: String(step.env.RELEASE_EVERY_MINUTES),
      STUB_TIP: tip,
      STUB_GH: files.gh,
      STUB_HELM: files.helm,
    },
  });
  const output = fs.readFileSync(files.output, 'utf8');
  const summary = fs.readFileSync(files.summary, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, 0, `the step must not fail the run: ${res.stderr}`);
  assert.equal(output.split('\n').filter((l) => l.startsWith('publish=')).length, 1, 'exactly one decision');
  return { publish: /publish=true/.test(output), summary };
}

// A burst: this run is behind the tip, the tip contains it, and the newest
// release is older, numbered below it, merged `minutes` before it.
const behind = (minutes) => [
  `compare ${MINE} ${TIP} ahead`,
  `compare ${OLD} ${MINE} ahead`,
  `date ${OLD} ${T0}`,
  `date ${MINE} ${T0 + minutes * 60}`,
];

test('the step reads its batching interval from the workflow, and it is 15 minutes', () => {
  assert.ok(step, 'the release job keeps its check step');
  assert.equal(String(step.env.RELEASE_EVERY_MINUTES), '15');
});

test('the branch tip always publishes, as before', () => {
  assert.equal(run({ tip: MINE, helm: '' }).publish, true, 'whatever the registry says');
  assert.equal(run({ tip: MINE, channel: 'candidate' }).publish, true);
});

test('a run behind the tip publishes once the newest release is RELEASE_EVERY_MINUTES older (5 October)', () => {
  const r = run({ gh: behind(66) });
  assert.equal(r.publish, true);
  assert.match(r.summary, /ahead of refs\/heads\/main's tip .*66 minutes older/);
  assert.equal(run({ gh: behind(15) }).publish, true, 'at the interval itself');
});

test('a burst is batched: a release under RELEASE_EVERY_MINUTES old waits for a later run', () => {
  const r = run({ gh: behind(5) });
  assert.equal(r.publish, false);
  assert.match(r.summary, /less than 15 minutes older; a later run releases it/);
});

test('an older revision never publishes over a newer one', () => {
  // The newest release already contains this revision (queued out of order).
  assert.equal(run({ gh: [`compare ${MINE} ${TIP} ahead`, `compare ${OLD} ${MINE} behind`, `date ${OLD} ${T0}`, `date ${MINE} ${T0 + 3600}`] }).publish, false);
  assert.equal(run({ gh: [`compare ${MINE} ${TIP} ahead`, `compare ${OLD} ${MINE} identical`] }).publish, false);
  // Or it is numbered at or above this run's chart.
  assert.equal(run({ gh: behind(66), chartVersion: '0.1.1545001' }).publish, false);
  assert.equal(run({ gh: behind(66), chartVersion: '0.1.1500001' }).publish, false);
});

test('a revision the branch no longer contains is not published', () => {
  assert.equal(run({ gh: [`compare ${MINE} ${TIP} diverged`, ...behind(66).slice(1)] }).publish, false);
});

test('a feature-branch candidate behind its tip still waits for the tip', () => {
  assert.equal(run({ channel: 'candidate', gh: behind(66) }).publish, false);
});

test('anything that cannot be read falls back to the exact tip: no publish', () => {
  assert.equal(run({ gh: behind(66), helm: '' }).publish, false, 'registry unreadable');
  assert.equal(run({ gh: behind(66), helm: 'apiVersion: v2\nversion: 0.1.1545001\n' }).publish, false, 'no appVersion');
  assert.equal(run({ gh: [] }).publish, false, 'GitHub API unreadable');
  assert.equal(run({ gh: behind(66).slice(0, 2) }).publish, false, 'merge times unreadable');
});
