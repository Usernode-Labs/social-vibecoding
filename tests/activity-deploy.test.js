'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const deploy = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'),
  'utf8'
);

test('deploy validates every setting required by Activity authority', () => {
  assert.match(deploy, /name: Validate Activity notification configuration/);
  assert.match(
    deploy,
    /for name in ACTIVITY_BASE_URL ACTIVITY_PRODUCER_TOKEN ACTIVITY_LEDGER_ID ACTIVITY_SOCIAL_ASSERTION_KEY/
  );
  assert.match(deploy, /if \[ -z "\$\{!name\}" \]/);
  assert.match(deploy, /ACTIVITY_NOTIFICATIONS_READ_PATH must be legacy or activity/);
});

test('deploy proves Activity readiness before replacing Social', () => {
  const build = deploy.indexOf('docker compose build usernode');
  const probe = deploy.indexOf('docker compose run --rm --no-deps -T usernode');
  const firstPossibleStop = deploy.indexOf('docker compose stop usernode');
  const replace = deploy.indexOf('docker compose up -d usernode');

  assert.ok(build !== -1, 'Social image build is missing');
  assert.ok(probe > build, 'Activity probe must use the newly built Social image');
  assert.ok(firstPossibleStop > probe,
    'Activity probe must finish before any migration can stop Social');
  assert.ok(replace > probe, 'Activity probe must finish before Social is replaced');
  assert.match(deploy, /ACTIVITY_BASE_URL%\/}\/health\/ready/);
});

test('deploy waits for and explicitly verifies Social health', () => {
  assert.match(deploy, /^\s*docker compose up -d usernode\s*$/m);
  assert.match(deploy, /HEALTH_STREAK=\$\(\(HEALTH_STREAK \+ 1\)\)/);
  assert.match(deploy, /docker compose exec -T usernode wget -qO- http:\/\/localhost:3000\/health/);
  assert.match(deploy, /\/opt\/usernode-tools\/rollback\.sh "\$PREV_SHA"/);
});
