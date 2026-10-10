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
// backoff tops out, and a platform boot makes it due at once.

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
  await visuals.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'error', results: [], platformFault: true }, COLLISION);
  await visuals.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'error', results: [] }, 'boot failed');
  await visuals.storeChecks(pool, 7741, 'a'.repeat(40), { state: 'passing', results: [] });
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
  const pool = recordingPool();
  await stagingRecovery.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /AND \(cs\.consecutive_check_failures < \$2\s+OR \(cs\.check_error_platform\s+AND cs\.first_check_failure_at > NOW\(\) - make_interval\(secs => \$4::double precision \/ 1000\.0\)\)\)\s+AND cs\.check_next_retry_at IS NOT NULL\s+AND cs\.check_next_retry_at < NOW\(\)/);
  assert.equal(params[3], stagingRecovery.PLATFORM_FAULT_RETRY_MS);
  assert.equal(stagingRecovery.PLATFORM_FAULT_RETRY_MS, 24 * HOUR);

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

test('a boot makes the platform faults inside their day due, before the stuck-checks reconcile', async () => {
  const pool = recordingPool();
  await stagingRecovery.rearmPlatformFaults(pool);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /SET check_next_retry_at = NOW\(\)/);
  assert.match(sql, /check_state = 'error'\s+AND check_error_platform\s+AND check_next_retry_at > NOW\(\)/);
  assert.equal(params[0], stagingRecovery.PLATFORM_FAULT_RETRY_MS);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /\.then\(\(\) => rearmPlatformFaultsAtBoot\(config\)\)\s+\.then\(\(\) => reconcileStuckChecks\(config\)\)/);
  assert.match(server, /Platform faults made due at boot/);
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
