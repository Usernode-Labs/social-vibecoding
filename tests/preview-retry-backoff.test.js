'use strict';

// A preview that keeps failing waits out its retry before anything rebuilds
// it unasked (services/staging-recovery.js previewRetryPending).
//
// On 10 Oct 2026 every platform boot rebuilt one to twelve previews at once,
// the same ones each time: one proposal's preview had failed 860 times, a
// child app's 375. The boot recovery (server.js recoverSessions) checked
// nothing but whether the preview was missing, and the live heal's only
// brake was an in-memory cooldown a restart forgets. Every failure already
// schedules a retry on the row (storeChecks: check_next_retry_at, 2 minutes
// doubling to 30), and both now wait for it. That made releases cheap
// enough to go out every four minutes rather than ten.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { previewRetryPending } = require('../src/services/staging-recovery');

const NOW = Date.parse('2026-10-10T18:30:00Z');
const MIN = 60 * 1000;

test('only a session in error, with failures, inside its scheduled retry, waits', () => {
  const failing = { check_state: 'error', consecutive_check_failures: 860, check_next_retry_at: new Date(NOW + 20 * MIN) };
  assert.equal(previewRetryPending(failing, NOW), true);
  assert.equal(previewRetryPending({ ...failing, check_next_retry_at: new Date(NOW - MIN) }, NOW), false, 'its retry is due');
  assert.equal(previewRetryPending({ ...failing, check_next_retry_at: null }, NOW), false, 'no retry scheduled');
  assert.equal(previewRetryPending({ ...failing, consecutive_check_failures: 0 }, NOW), false, 'no failures');
  for (const state of ['pending', 'passing', 'failing', null]) {
    assert.equal(previewRetryPending({ ...failing, check_state: state }, NOW), false, String(state));
  }
  assert.equal(previewRetryPending(null, NOW), false);
  assert.equal(previewRetryPending({ ...failing, check_next_retry_at: '2026-10-10T18:45:00Z' }, NOW), true, 'a timestamp string reads too');
});

test('the boot recovery and the live heal both wait for it, before anything else is asked', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const boot = server.slice(server.indexOf('async function recoverSessions(config)'));
  const bootLoop = boot.slice(0, boot.indexOf("reason: 'startup'"));
  assert.match(bootLoop, /if \(stagingRecovery\.previewRetryPending\(session\)\) \{ backedOff \+= 1; continue; \}\s+if \(!\(await stagingRecovery\.stagingNeedsRebuild\(session, \{ config \}\)\)\) continue;/);
  assert.match(boot, /Left failing previews to their retry backoff at boot/);

  const heal = server.slice(server.indexOf('const MAX_HEALS_PER_SWEEP'), server.indexOf("reason: 'heal'"));
  assert.match(heal, /if \(stagingRecovery\.previewRetryPending\(session\)\) continue;\s+if \(!\(await stagingRecovery\.stagingNeedsRebuild\(session, \{ config \}\)\)\) continue;/);
});
