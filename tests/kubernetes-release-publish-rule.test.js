'use strict';

// The release job's "Check branch tip before publishing" step, run as it is
// written in .github/workflows/build-kubernetes-images.yml, against stand-ins
// for git, gh, helm, date and sleep (a fake clock, so a ten-minute wait takes
// no time).
//
// On 5 October 2026 merges landed every two to four minutes while each run
// took three to twelve. Runs are queued one at a time, so every run found a
// newer tip, skipped publishing, and nothing deployed from 16:12 to about
// 17:50 UTC. The tip still always publishes. A stable run behind the tip now
// publishes too, when the branch contains it, the newest release in the
// registry is older and numbered below it, and that release's revision was
// merged at least RELEASE_EVERY_MINUTES before this one. An older revision
// must never publish over a newer one: Argo CD runs the highest 0.1.* chart.
//
// On 7 October the tip published every time it was the tip, and the platform
// rolled out four times in sixteen minutes (21:41:57 to 21:57:49 UTC). A
// stable release now goes out no sooner than RELEASE_MIN_GAP_MINUTES after
// the run that published the one before it finished: the tip waits out the
// rest of the gap, a newer merge or a dispatched run ends the wait, and a
// run behind the tip skips inside it.

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
const NOW = T0 + 3 * 3600; // the fake clock when the step starts
const MIN = 60;
const GAP = Number(step && step.env.RELEASE_MIN_GAP_MINUTES) * MIN;

// gh answers from lines of `<key> <value>`; a line written `@<epoch> <key>
// <value>` holds only from that time on the fake clock, and the last line that
// holds wins. The tip is read the same way from `[epoch, sha]` pairs.
const STUBS = {
  git: `#!/usr/bin/env bash
[ "$1" = ls-remote ] || exit 2
now="$(cat "$STUB_CLOCK")"
tip=
while read -r at value; do
  [ "$at" -le "$now" ] && tip="$value"
done < "$STUB_TIPS"
printf '%s\\t%s\\n' "$tip" "$5"
`,
  gh: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_GH_LOG"
path="$2"
case "$path" in
  */compare/*) pair="\${path##*/compare/}"; key="compare \${pair%%...*} \${pair##*...}";;
  */commits/*) key="date \${path##*/commits/}";;
  */runs\\?head_sha=*) q="\${path##*head_sha=}"; key="finished \${q%%&*}";;
  */runs\\?event=workflow_dispatch*) key="dispatched";;
  *) exit 2;;
esac
now="$(cat "$STUB_CLOCK")"
value=
while read -r line; do
  at=0
  case "$line" in @*) at="\${line%% *}"; at="\${at#@}"; line="\${line#* }";; esac
  [ "$at" -le "$now" ] || continue
  case "$line" in "$key "*) value="\${line##* }";; esac
done < "$STUB_GH"
[ -n "$value" ] || exit 1
echo "$value"
`,
  helm: `#!/usr/bin/env bash
[ -s "$STUB_HELM" ] || exit 1
cat "$STUB_HELM"
`,
  date: `#!/usr/bin/env bash
if [ "$*" = +%s ]; then cat "$STUB_CLOCK"; else exec /bin/date "$@"; fi
`,
  sleep: `#!/usr/bin/env bash
[[ "$1" =~ ^[0-9]+$ ]] || exit 2
echo "$1" >> "$STUB_SLEEPS"
echo $(( $(cat "$STUB_CLOCK") + $1 )) > "$STUB_CLOCK"
`,
};

function run({
  channel = 'stable', chartVersion = '0.1.1600001', tip = TIP, tips = null, event = 'push',
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
    ghLog: path.join(dir, 'gh.log'),
    helm: path.join(dir, 'helm.txt'),
    tips: path.join(dir, 'tips.txt'),
    clock: path.join(dir, 'clock'),
    sleeps: path.join(dir, 'sleeps'),
    output: path.join(dir, 'output'),
    summary: path.join(dir, 'summary'),
    script: path.join(dir, 'step.sh'),
  };
  fs.writeFileSync(files.gh, gh.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(files.helm, helm || '');
  fs.writeFileSync(files.tips, (tips || [[0, tip]]).map(([at, s]) => `${at} ${s}\n`).join(''));
  fs.writeFileSync(files.clock, String(NOW));
  for (const f of ['ghLog', 'sleeps', 'output', 'summary']) fs.writeFileSync(files[f], '');
  fs.writeFileSync(files.script, step.run);
  const res = spawnSync('bash', ['-e', files.script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      GITHUB_SHA: MINE,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'Usernode-Labs/social-vibecoding',
      GITHUB_EVENT_NAME: event,
      GITHUB_RUN_NUMBER: '1600',
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      GH_TOKEN: 'test',
      RELEASE_CHANNEL: channel,
      CHART_VERSION: chartVersion,
      CHART_REF: 'oci://ghcr.io/usernode-labs/charts/social-vibecoding-platform',
      RELEASE_EVERY_MINUTES: String(step.env.RELEASE_EVERY_MINUTES),
      RELEASE_MIN_GAP_MINUTES: String(step.env.RELEASE_MIN_GAP_MINUTES),
      STUB_TIPS: files.tips,
      STUB_GH: files.gh,
      STUB_GH_LOG: files.ghLog,
      STUB_HELM: files.helm,
      STUB_CLOCK: files.clock,
      STUB_SLEEPS: files.sleeps,
    },
  });
  const output = fs.readFileSync(files.output, 'utf8');
  const summary = fs.readFileSync(files.summary, 'utf8');
  const sleeps = fs.readFileSync(files.sleeps, 'utf8').split('\n').filter(Boolean).map(Number);
  const ghCalls = fs.readFileSync(files.ghLog, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, 0, `the step must not fail the run: ${res.stderr}`);
  assert.equal(output.split('\n').filter((l) => l.startsWith('publish=')).length, 1, 'exactly one decision');
  for (const s of sleeps) assert.ok(s > 0 && s <= 30, `each wait re-reads the branch within 30 seconds, not ${s}`);
  return {
    publish: /publish=true/.test(output),
    summary,
    log: res.stdout,
    waited: sleeps.reduce((a, b) => a + b, 0),
    ghCalls,
  };
}

// A burst: this run is behind the tip, the tip contains it, and the newest
// release is older, numbered below it, merged `minutes` before it.
const behind = (minutes) => [
  `compare ${MINE} ${TIP} ahead`,
  `compare ${OLD} ${MINE} ahead`,
  `date ${OLD} ${T0}`,
  `date ${MINE} ${T0 + minutes * 60}`,
];
// The run that published the newest release finished `minutes` ago.
const releasedAgo = (minutes) => `finished ${OLD} ${NOW - minutes * MIN}`;

test('the step reads its batching interval and its release gap from the workflow: 15 and 4 minutes', () => {
  assert.ok(step, 'the release job keeps its check step');
  assert.equal(String(step.env.RELEASE_EVERY_MINUTES), '15');
  // Ten until 10 Oct 2026: a merge then read "Going live" for a median 5.6
  // and up to 16 minutes, mostly this wait, while a restart had become cheap.
  assert.equal(String(step.env.RELEASE_MIN_GAP_MINUTES), '4');
});

test('the wait is bounded well inside the step and job timeouts', () => {
  // The longest wait is the whole gap; the step's own timeout only stops a
  // hung read, and the job (GitHub's default 360 minutes) sits above it.
  assert.ok(Number(step['timeout-minutes']) >= GAP / MIN + 5,
    `the step's timeout (${step['timeout-minutes']}) must sit comfortably above the ${GAP / MIN}-minute wait`);
  const jobTimeout = Number(workflow.jobs.release['timeout-minutes'] || 360);
  assert.ok(jobTimeout > Number(step['timeout-minutes']), 'the job outlasts the step');
  // A release run that finished "in the future" (a skewed clock) waits the
  // gap and no longer.
  const r = run({ tip: MINE, gh: [`finished ${OLD} ${NOW + 5 * MIN}`] });
  assert.equal(r.publish, true);
  assert.equal(r.waited, GAP);
});

test('the release job may read its own workflow runs', () => {
  assert.equal(workflow.jobs.release.permissions.actions, 'read');
});

test('the branch tip always publishes, as before', () => {
  assert.equal(run({ tip: MINE, helm: '' }).publish, true, 'whatever the registry says');
  assert.equal(run({ tip: MINE, channel: 'candidate' }).publish, true);
});

test('the tip waits until the newest release is RELEASE_MIN_GAP_MINUTES old, then publishes (7 October)', () => {
  // No further merge arrives: the waiting tip still publishes.
  const r = run({ tip: MINE, gh: [releasedAgo(1)] });
  assert.equal(r.publish, true);
  assert.equal(r.waited, 3 * MIN, 'the rest of the gap, and no more');
  assert.match(r.summary, /^Publishing b{40}, the tip of refs\/heads\/main, after waiting 3 minutes for the newest release \(0\.1\.1545001\) to be 4 minutes old\.$/m);
  assert.match(r.log, /Waiting up to 3 more minutes.*To release now, run this workflow on refs\/heads\/main by hand/);
  // It re-reads the branch at the end of the wait: a merge landing in its
  // last seconds is still seen, and this run steps aside for it.
  const lastMoment = run({ tips: [[0, MINE], [NOW + 3 * MIN, TIP]], gh: [releasedAgo(1)] });
  assert.equal(lastMoment.publish, false);
  assert.equal(lastMoment.waited, 3 * MIN);
  const justReleased = run({ tip: MINE, gh: [releasedAgo(0)] });
  assert.equal(justReleased.publish, true);
  assert.equal(justReleased.waited, GAP);
});

test('the release age is read from the run that published the newest release', () => {
  // Chart 0.1.1545001 is run 1545, attempt 1, of this workflow.
  const r = run({ tip: MINE, gh: [releasedAgo(4)] });
  const lookup = r.ghCalls.find((c) => c.includes('/actions/workflows/build-kubernetes-images.yml/runs?head_sha='));
  assert.ok(lookup, 'the newest release\'s run is looked up');
  assert.match(lookup, new RegExp(`runs\\?head_sha=${OLD}&`));
  assert.match(lookup, /select\(\.run_number == 1545 and \.status == "completed"\) \| \.updated_at \| fromdateiso8601/);
});

test('a tip whose newest release is already RELEASE_MIN_GAP_MINUTES old publishes at once', () => {
  for (const minutes of [4, 45]) {
    const r = run({ tip: MINE, gh: [releasedAgo(minutes)] });
    assert.equal(r.publish, true, `${minutes} minutes`);
    assert.equal(r.waited, 0, `${minutes} minutes`);
    assert.match(r.summary, new RegExp(`went out ${minutes} minutes ago`));
  }
});

test('a merge during the wait ends it: this run skips, and the newer merge\'s run publishes', () => {
  const r = run({ tips: [[0, MINE], [NOW + 2 * MIN, TIP]], gh: [releasedAgo(1)] });
  assert.equal(r.publish, false);
  assert.ok(r.waited >= 2 * MIN && r.waited <= 2 * MIN + 30, `stops within one poll of the merge, not after ${r.waited}s`);
  assert.match(r.summary, /refs\/heads\/main moved to c{40} while this run waited .* That commit's run is queued behind this one and publishes once it has built\./);
});

test('a dispatched run queued behind a waiting tip ends the wait: it publishes at once instead', () => {
  const r = run({ tip: MINE, gh: [releasedAgo(0), `@${NOW + 3 * MIN} dispatched 1`] });
  assert.equal(r.publish, false);
  assert.ok(r.waited >= 3 * MIN && r.waited <= 3 * MIN + 30, `stops within one poll of the dispatch, not after ${r.waited}s`);
  assert.match(r.summary, /dispatched by hand is queued behind this one, and it publishes refs\/heads\/main without waiting/);
  const lookup = r.ghCalls.find((c) => c.includes('runs?event=workflow_dispatch'));
  assert.match(lookup, /\.head_branch == "main" and \.status != "completed" and \.run_number > 1600/,
    'only a run dispatched on this branch after this one');
  // Already queued when the tip arrives: no wait at all.
  const queued = run({ tip: MINE, gh: [releasedAgo(2), 'dispatched 1'] });
  assert.equal(queued.publish, false);
  assert.equal(queued.waited, 0);
});

test('a dispatched run and a feature-branch candidate never wait', () => {
  const dispatched = run({ tip: MINE, event: 'workflow_dispatch', gh: [releasedAgo(1)] });
  assert.equal(dispatched.publish, true);
  assert.equal(dispatched.waited, 0);
  assert.match(dispatched.summary, /at once: it was dispatched by hand/);
  const candidate = run({ tip: MINE, channel: 'candidate', gh: [releasedAgo(1)] });
  assert.equal(candidate.publish, true);
  assert.equal(candidate.waited, 0);
});

test('when the newest release or its run cannot be read, the tip publishes at once, as before', () => {
  for (const [why, opts] of [
    ['registry unreadable', { helm: '' }],
    ['no appVersion', { helm: 'apiVersion: v2\nversion: 0.1.1545001\n' }],
    ['its run unreadable', { gh: [] }],
    ['its run not a time', { gh: [`finished ${OLD} soon`] }],
  ]) {
    const r = run({ tip: MINE, ...opts });
    assert.equal(r.publish, true, why);
    assert.equal(r.waited, 0, why);
  }
});

test('a run behind the tip publishes once the newest release is RELEASE_EVERY_MINUTES older (5 October)', () => {
  const r = run({ gh: behind(66) });
  assert.equal(r.publish, true);
  assert.match(r.summary, /ahead of refs\/heads\/main's tip .*66 minutes older/);
  assert.equal(run({ gh: behind(15) }).publish, true, 'at the interval itself');
  assert.equal(run({ gh: [...behind(66), releasedAgo(12)] }).publish, true, 'and past the release gap');
  assert.equal(run({ gh: behind(66) }).waited, 0, 'a run behind the tip never waits');
});

test('a burst is batched: a release under RELEASE_EVERY_MINUTES old waits for a later run', () => {
  const r = run({ gh: behind(5) });
  assert.equal(r.publish, false);
  assert.match(r.summary, /less than 15 minutes older; a later run releases it/);
});

test('a run behind the tip also skips inside the release gap; the tip\'s run releases it', () => {
  const r = run({ gh: [...behind(66), releasedAgo(3)] });
  assert.equal(r.publish, false);
  assert.equal(r.waited, 0);
  assert.match(r.summary, /the newest release \(0\.1\.1545001\) went out 3 minutes ago, under 4; the tip's run releases it/);
  // A dispatched run behind the tip keeps #3964's rule alone.
  assert.equal(run({ event: 'workflow_dispatch', gh: [...behind(66), releasedAgo(3)] }).publish, true);
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
