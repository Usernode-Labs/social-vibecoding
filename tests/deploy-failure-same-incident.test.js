// deployFailure.sameIncident decides whether a production rebuild failure
// is the one already recorded on apps.last_failure (same commit, same
// stage) or a new incident. staging.rebuildProduction notifies the app's
// creator and admins only for a new incident; the drift poller retries a
// failing rebuild every tick, and a commit that cannot build fails the
// same way each time. Twenty-five "Deploy failed" pushes went out for one
// falling-sands commit in a night before this.
//
// Run with: node --test tests/deploy-failure-same-incident.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { sameIncident, record } = require('../src/services/deploy-failure');

const SHA = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const OTHER = 'de34ddaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('the same commit failing at the same stage is the same incident', () => {
  const prev = { stage: 'build', reason: 'apt-get update timed out', log: '', at: '2026-09-16T22:00:00Z', sha: SHA };
  const next = { stage: 'build', reason: 'apt-get update timed out', log: '', at: '2026-09-17T09:00:00Z', sha: SHA };
  assert.equal(sameIncident(prev, next), true);
});

test('the reason text and the log may differ; the incident is the commit and the stage', () => {
  const prev = { stage: 'build', reason: 'Connection timed out [IP: 151.101.2.132 80]', log: 'tail A', sha: SHA };
  const next = { stage: 'build', reason: 'Connection timed out [IP: 151.101.66.132 80]', log: 'tail B', sha: SHA };
  assert.equal(sameIncident(prev, next), true);
});

test('sha comparison ignores case', () => {
  assert.equal(
    sameIncident({ stage: 'build', sha: SHA.toUpperCase() }, { stage: 'build', sha: SHA }),
    true,
  );
});

test('a different commit is a new incident', () => {
  assert.equal(
    sameIncident({ stage: 'build', sha: OTHER }, { stage: 'build', sha: SHA }),
    false,
  );
});

test('the same commit failing at a different stage is news', () => {
  // The build that could not run now builds, and the container will not
  // start: that is a different fault on the same commit.
  assert.equal(
    sameIncident({ stage: 'build', sha: SHA }, { stage: 'healthcheck', sha: SHA }),
    false,
  );
});

test('a record with no stage matches on sha alone', () => {
  assert.equal(sameIncident({ sha: SHA }, { stage: 'build', sha: SHA }), true);
  assert.equal(sameIncident({ stage: 'build', sha: SHA }, { sha: SHA }), true);
});

test('records without a sha never match, so they keep notifying', () => {
  // A synthetic record (creation watchdog, boot sweep) has sha: null.
  assert.equal(sameIncident({ stage: 'other', sha: null }, { stage: 'other', sha: null }), false);
  assert.equal(sameIncident({ stage: 'build', sha: SHA }, { stage: 'build', sha: null }), false);
  assert.equal(sameIncident({ stage: 'build', sha: null }, { stage: 'build', sha: SHA }), false);
});

test('nothing recorded before is a new incident; so is an unreadable previous value', () => {
  const next = { stage: 'build', sha: SHA };
  assert.equal(sameIncident(null, next), false);
  assert.equal(sameIncident(undefined, next), false);
  // The legacy shape was a bare string; it names no sha.
  assert.equal(sameIncident('docker build failed', next), false);
  assert.equal(sameIncident(42, next), false);
});

test('a previous record still serialised as JSON text is read', () => {
  const prev = JSON.stringify({ stage: 'build', sha: SHA, reason: 'x', log: '', at: 'y' });
  assert.equal(sameIncident(prev, { stage: 'build', sha: SHA }), true);
  assert.equal(sameIncident(prev, { stage: 'build', sha: OTHER }), false);
});

test('two records produced by record() for the same error and sha compare equal', () => {
  const err = new Error('docker build failed: E: Failed to fetch http://deb.debian.org/... Connection timed out');
  const a = record(err, { sha: SHA });
  const b = record(err, { sha: SHA });
  assert.equal(a.stage, b.stage);
  assert.equal(sameIncident(a, b), true);
  assert.equal(sameIncident(a, record(err, { sha: OTHER })), false);
});
