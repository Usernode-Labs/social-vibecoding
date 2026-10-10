'use strict';

// The calendar-sensitive suites, run again at the instants that break them.
//
// On Saturday 10 October 2026 main went red at 08:16 and every merge waited
// two hours: two tests expected a challenge card's time left to count to
// the card's own end, and on a weekend This week's clock stops at the end
// of the week instead (#4648). They had passed every run since they merged,
// all of them on weekdays, and would have passed again on Monday.
//
// This suite runs the suites in SWEPT with the clock moved
// (tests/lib/fake-clock.cjs) to the instants such code gets wrong, all UTC
// like the weeks they count: a Saturday afternoon, half an hour before a
// week ends, the first half hour of a week, and the last half hour of a
// month. A suite that passes today but would fail at one of them fails
// here, on any day, instead of on main some weekend.
//
// A suite belongs in SWEPT when what it asserts moves with the calendar: a
// week's or a month's boundary, time left, "this week". It must not compare
// against a database's NOW(): the database's clock is not moved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FAKE_CLOCK = path.join(__dirname, 'lib', 'fake-clock.cjs');
const TEST_NET = path.join(__dirname, 'lib', 'test-net.js');

const SWEPT = [
  // This week's clock: the sooner of a card's end and Monday 00:00 UTC (#4648).
  'tests/challenge-groups.test.js',
  // The same clock on the Home screen's challenge panel (#4648, and one
  // assertion that read "23h left" at Sunday 23:30, found by this sweep).
  'tests/home-panels-render.test.js',
  // Weekly windows that open on Monday 00:00 UTC.
  'tests/kudos.test.js',
  'tests/limits-week-boundary.test.js',
  'tests/leaderboard-users-issues.test.js',
  'tests/leaderboard-users-service.test.js',
  'tests/challenge-scoring.test.js',
  // Allowance resets worded in the viewer's clock.
  'tests/reset-time.test.js',
  // A sketch's dates held to the calendar.
  'tests/sketch-dates.test.js',
];

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// The instants, each the next one after `nowMs`, so a fixture dated "a few
// days from now" still reads as the future.
function instants(nowMs) {
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const next = (weekday, hours) => {
    for (let i = 1; i <= 7; i += 1) {
      const day = today + i * DAY;
      if (new Date(day).getUTCDay() === weekday) return day + hours * HOUR;
    }
    return null;
  };
  let monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 30);
  if (monthEnd <= nowMs) monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 30);
  return [
    { label: 'Saturday 12:00 UTC', at: next(6, 12) },
    { label: 'Sunday 23:30 UTC, half an hour before the week ends', at: next(0, 23.5) },
    { label: 'Monday 00:30 UTC, half an hour into a week', at: next(1, 0.5) },
    { label: 'the last half hour of a month', at: monthEnd },
  ];
}

// The failing tests of a TAP run, as `name (file)` lines.
function failures(tap) {
  const lines = String(tap).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m || /#\s*(SKIP|TODO)\b/i.test(m[1])) continue;
    let where = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const loc = /location: '([^']+)'/.exec(lines[j]);
      if (loc) { where = ` (${path.relative(ROOT, loc[1])})`; break; }
    }
    out.push(`${m[1]}${where}`);
  }
  return out;
}

// Run `files` with the clock at `at`; resolves `{ code, failed }`.
function runAt(files, at, { concurrency = 2, timeoutMs = 150000 } = {}) {
  // A runner that inherits NODE_TEST_CONTEXT takes itself for one of this
  // run's own children and runs nothing.
  const env = { ...process.env, FAKE_NOW: new Date(at).toISOString() };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--require', TEST_NET, '--require', FAKE_CLOCK,
      '--test', '--test-force-exit', '--test-timeout=60000', '--test-reporter=tap',
      `--test-concurrency=${concurrency}`, ...files,
    ], { cwd: ROOT, env });
    let tap = '';
    child.stdout.on('data', (b) => { tap += b; });
    child.stderr.on('data', (b) => { tap += b; });
    const timer = setTimeout(() => { tap += '\nnot ok 0 - the sweep run did not finish in time'; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, failed: failures(tap) });
    });
  });
}

test('every swept suite exists and runs under the plain clock too', () => {
  for (const file of SWEPT) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  assert.equal(new Set(SWEPT).size, SWEPT.length);
});

test('the instants are the next ones, a weekend, both edges of a week, and a month end', () => {
  // Wednesday 14 October 2026, 09:00 UTC.
  const at = instants(Date.UTC(2026, 9, 14, 9)).map((i) => new Date(i.at).toISOString());
  assert.deepEqual(at, [
    '2026-10-17T12:00:00.000Z',
    '2026-10-18T23:30:00.000Z',
    '2026-10-19T00:30:00.000Z',
    '2026-10-31T23:30:00.000Z',
  ]);
  // Past this month's last half hour, the next month's.
  assert.equal(new Date(instants(Date.UTC(2026, 9, 31, 23, 45))[3].at).toISOString(), '2026-11-30T23:30:00.000Z');
});

test('the sweep fails a test that only holds on weekdays, and passes it on a Monday', async () => {
  // tests/fixtures/clock-sweep: the shape of the bug #4648 fixed, loaded
  // into a vm context the way the challenge pane is.
  const fixture = ['tests/fixtures/clock-sweep/weekend-bomb.test.js'];
  const [saturday, , monday] = instants(Date.now());
  const [red, green] = await Promise.all([runAt(fixture, saturday.at), runAt(fixture, monday.at)]);
  assert.notEqual(red.code, 0);
  assert.equal(red.failed.length, 1, red.failed.join('\n'));
  assert.match(red.failed[0], /^a card ending in five days reads 5d left \(tests\/fixtures\/clock-sweep\/weekend-bomb\.test\.js:\d+:\d+\)$/);
  assert.equal(green.code, 0, green.failed.join('\n'));
});

test('the calendar-sensitive suites pass at every instant', { concurrency: 2 }, async (t) => {
  const concurrency = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)));
  for (const { label, at } of instants(Date.now())) {
    t.test(`at ${label} (${new Date(at).toISOString()})`, async () => {
      const { code, failed } = await runAt(SWEPT, at, { concurrency });
      assert.equal(code, 0, `failed with the clock at ${new Date(at).toISOString()}:\n${failed.join('\n')}`);
    });
  }
});
