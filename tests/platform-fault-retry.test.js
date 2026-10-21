'use strict';

// A checks run that errored on the platform's own fault (the unit suite's
// Job refused or lost before any of the proposal's code ran) does not use up
// the proposal's automatic retries.
//
// On 10 Oct 2026 every split unit suite failed to start for three hours: two
// shards' input Secrets took the same name ("The unit suite could not start:
// a job with the same name was already there"). Six approved proposals spent
// their six retries (CHECK_MAX_AUTO_RETRIES) on it by 20:08, and after #4720
// fixed it at 21:26 each waited for a person to press Re-run. The error lane
// now keeps retrying such a fault for a day, 30 minutes apart once the
// backoff tops out, and a platform release retries it at once.

// The verdict's writers: the preview machine's own (its transitions run them).
const rowStore = require('../src/workflow/preview/check-store.ts');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const unitSuiteRow = require('../src/services/unit-suite-row');
const visuals = require('../src/services/visuals');
const stagingRecovery = require('../src/services/staging-recovery');
const tools = require('../src/services/mcp-tools');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-10T21:40:00Z');
const HOUR = 60 * 60 * 1000;
const COLLISION = 'The unit suite could not start: a job with the same name was already there.';

const notRunRow = (detail, advisory = false) => ({
  index: unitSuiteRow.UNIT_CHECK_INDEX, name: unitSuiteRow.UNIT_CHECK_NAME, path: unitSuiteRow.UNIT_CHECK_PATH,
  status: 'fail', advisory, couldNotRun: true, consoleErrors: [],
  failureReason: `${detail} | secrets "sv-unit-suite-s7741-…-input" already exists`,
});
const frame = (index, status) => ({ index, status, name: `Loads /p${index}`, path: `/p${index}`, consoleErrors: [], failureReason: '' });
const dispatched = [{ index: 0, checkKey: 'k0', name: 'Loads /p0', path: '/p0', graduated: true }];

test('only a Job the runner never got going, or lost, is the platform\'s fault alone', () => {
  const lead = unitSuiteRow.NOT_RUN_LEAD;
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(COLLISION)), true);
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(`${lead.start}: the cluster's job quota was full.`)), true);
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(`${lead.run}: the Kubernetes API could not be reached.`)), true);
  // Setup can be the proposal's own dependencies running out of memory or time.
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(`${lead.setup}: it ran out of memory while installing its dependencies.`)), false);
  assert.equal(unitSuiteRow.isPlatformNotRun({ ...notRunRow(COLLISION), couldNotRun: false }), false, 'a suite that ran');
  assert.equal(unitSuiteRow.isPlatformNotRun(null), false);
});

test('the verdict says so, in both shapes, and a capture that produced nothing is never only the platform\'s', () => {
  for (const opts of [{ extraRows: [notRunRow(COLLISION)] }, { dispatched, sentinel: null, extraRows: [notRunRow(COLLISION)] }]) {
    const out = visuals.classifyTests([frame(0, 'pass')], 1, opts);
    assert.equal(out.state, 'error');
    assert.equal(out.errorDetail, COLLISION);
    assert.equal(out.platformFault, true, opts.dispatched ? 'earned gating' : 'legacy');
  }
  const setup = visuals.classifyTests([frame(0, 'pass')], 1, {
    dispatched, sentinel: null, extraRows: [notRunRow(`${unitSuiteRow.NOT_RUN_LEAD.setup}: installing its dependencies did not finish in 600s.`)],
  });
  assert.equal(setup.state, 'error');
  assert.equal(setup.platformFault, false);
  // A graduated check with no verdict is decided before the unit suite: not this.
  const missing = visuals.classifyTests([], 1, { dispatched, sentinel: null, extraRows: [notRunRow(COLLISION)] });
  assert.equal(missing.state, 'error');
  assert.notEqual(missing.platformFault, true);

  const src = fs.readFileSync(path.join(ROOT, 'src/services/visuals.js'), 'utf8');
  const override = src.slice(src.indexOf('if (checksResult.state === \'error\' && parsedTests.length === 0 && testsCount > 0) {'));
  assert.match(override.slice(0, 400), /checksResult\.platformFault = false;/);
});

function recordingPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
}

test('storeChecks writes the flag with every error and clears it with every verdict', async () => {
  const pool = recordingPool();
  await rowStore.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'error', results: [], platformFault: true }, COLLISION);
  await rowStore.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'error', results: [] }, 'boot failed');
  await rowStore.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'passing', results: [] });
  const [platform, other, passing] = pool.calls;
  assert.match(platform.sql, /check_error_platform = \$6::boolean/);
  assert.equal(platform.params[5], true);
  assert.match(platform.sql, /consecutive_check_failures = consecutive_check_failures \+ 1/, 'the streak and its backoff run as for any error');
  assert.match(platform.sql, /LEAST\(120 \* power\(2, LEAST\(consecutive_check_failures, 10\)\), 1800\)/,
    'the exponent is capped, so a long streak cannot overflow the write');
  assert.equal(other.params[5], false, 'any other error writes false, so the flag never outlives its error');
  assert.match(passing.sql, /check_error_platform = false/);
});

test('the error lane keeps a platform fault past the cap for a day from its first failure', async () => {
  // The preview machine's own retry timer (preview/machine.ts errorTimer):
  // under the cap, or a platform fault inside its day. The leader's
  // stuck-checks sweep that ran the same rule in SQL is gone.
  const machine = fs.readFileSync(path.join(ROOT, 'src/workflow/preview/machine.ts'), 'utf8');
  assert.match(machine, /const PLATFORM_FAULT_RETRY_MS = 24 \* 60 \* 60 \* 1000;/);
  const timer = machine.slice(machine.indexOf('function errorTimer('));
  const body = timer.slice(0, timer.indexOf('\n}\n'));
  assert.match(body, /if \(!f\.session\?\.retryScope\) return null;/);
  assert.match(body, /const underCap = d\.streak < deps\.maxRetries;/);
  assert.match(body, /const platformDay = d\.platformFault && d\.firstFailureAt\s+&& ctx\.now\.getTime\(\) - Date\.parse\(d\.firstFailureAt\) < PLATFORM_FAULT_RETRY_MS;/);
  assert.match(body, /if \(!underCap && !platformDay\) return null;/);
  assert.equal(stagingRecovery.PLATFORM_FAULT_RETRY_MS, 24 * HOUR);
  assert.equal(stagingRecovery.findStuckCheckSessions, undefined);
  // An error from before the session was in the lane's scope (it went up
  // for a vote since) had no timer set: the promote's RevisionSubmitted of
  // that head arms it, where the sweep's SQL used to take such a row.
  assert.match(machine, /const rearms = \(s: any, e: Event<any>\) => e\.payload\.trigger === 'promote-kick'\s+&& \(s\.name === 'failed' \|\| \(s\.name === 'settled' && s\.data\.verdict === 'error'\)\);/);
  assert.match(machine, /if \(!restarts\(s\) && sameHead\(s, e\.payload\.head\)\) \{\s+return step\(\{ name: s\.name, data: s\.data, timer: errorTimer\(s\.data, f, deps, ctx, Math\.max\(0, s\.data\.streak - 1\)\) \}\);/);

  // The same rule in code, which the connector reads.
  const capped = { consecutive_check_failures: 6, check_error_platform: true, first_check_failure_at: new Date(NOW - 3 * HOUR) };
  const within = (row) => stagingRecovery.errorWithinAutoRetries(row, { maxAutoRetries: 6, now: NOW });
  assert.equal(within(capped), true, 'a platform fault three hours in');
  assert.equal(within({ ...capped, first_check_failure_at: new Date(NOW - 25 * HOUR) }), false, 'a day on, it waits for a person');
  assert.equal(within({ ...capped, check_error_platform: false }), false, 'any other error stops at the cap');
  assert.equal(within({ ...capped, first_check_failure_at: null }), false);
  assert.equal(within({ ...capped, check_error_platform: false, consecutive_check_failures: 5 }), true, 'under the cap, as before');
  assert.equal(within(null), false);
});

test('a release retries the platform faults inside their day, once per release', () => {
  // The preview machine holds every proposal's checks, so the release's own
  // work does it, once per release (src/workflow/platform.ts ADOPTIONS, run
  // by the release machine's release.adopt), rather than a boot step making
  // the old error lane's retry due.
  const platform = fs.readFileSync(path.join(ROOT, 'src/workflow/platform.ts'), 'utf8');
  const adoptions = platform.slice(platform.indexOf('const ADOPTIONS'));
  assert.match(adoptions.slice(0, adoptions.indexOf(']);')), /\['platformFaults', \(\) => retryPlatformFaults\(\)\]/);
  const fn = platform.slice(platform.indexOf('async function retryPlatformFaults('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\(state = 'failed' OR \(state = 'settled' AND data->>'verdict' = 'error'\)\)/);
  assert.match(body, /AND \(data->>'platformFault'\)::boolean/);
  assert.match(body, /AND \(data->>'firstFailureAt'\)::timestamptz > now\(\) - interval '1 day'/);
  assert.match(body, /\{ type: 'RetryDue', payload: \{\} \}/);
  assert.match(body, /requestKey: `release-retry:\$\{release\}:\$\{r\.key\}`/, 'the request key names the build: once per release');

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /rearmPlatformFaults/, 'no boot step of its own');
  assert.equal(stagingRecovery.rearmPlatformFaults, undefined);
});

test('the connector promises a re-run of a capped platform fault, and only that', () => {
  const ORIGIN = 'https://social-vibecoding.usernodelabs.org';
  const row = {
    id: 7741, app_slug: 'usernode-2d5619', status: 'promoted', pr_number: 4723, branch_name: 'usernode/s7741',
    check_state: 'error', check_error_detail: COLLISION, test_results: [notRunRow(COLLISION)],
    consecutive_check_failures: 6, check_next_retry_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    first_check_failure_at: new Date(Date.now() - 2 * HOUR).toISOString(), check_error_platform: true,
  };
  assert.match(tools.shapeProposal(row, ORIGIN).nextStep, /Homeroom runs errored checks again on its own/);
  assert.match(tools.shapeProposal({ ...row, check_error_platform: false }, ORIGIN).nextStep,
    /Homeroom will not run them again on its own now/);
});

test('the schema carries the column', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE chat_sessions\s+ADD COLUMN IF NOT EXISTS check_error_platform BOOLEAN NOT NULL DEFAULT false;/);
});
