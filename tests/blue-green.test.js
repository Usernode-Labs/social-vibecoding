'use strict';

// Blue-green deploy guards: leadership election (src/services/leadership.js),
// the server.js leader/instance split, the compose color pair, the rollout
// script's cutover ordering, and rollback.sh's deterministic single-color
// recovery. The scripts and compose file are config, so — same pattern as
// tests/host-deployer.test.js — the strongest cheap guard is pinning the
// load-bearing lines; leadership.js additionally gets functional coverage
// for the paths that don't need a live Postgres.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const leadership = require('../src/services/leadership');
const serverJs = read('server.js');
const compose = read('docker-compose.yml');
const rolloutSh = read('scripts', 'platform-rollout.sh');
const deploySh = read('scripts', 'deploy.sh');
const rollbackSh = read('scripts', 'rollback.sh');

function withLeaderLockEnv(value, fn) {
  const prev = process.env.PLATFORM_LEADER_LOCK;
  if (value === undefined) delete process.env.PLATFORM_LEADER_LOCK;
  else process.env.PLATFORM_LEADER_LOCK = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.PLATFORM_LEADER_LOCK;
      else process.env.PLATFORM_LEADER_LOCK = prev;
    });
}

// ── leadership.js: single-instance (disabled) mode ────────────────────

test('leader lock is off by default — dev/tests/single-instance boot unchanged', async () => {
  await withLeaderLockEnv(undefined, async () => {
    assert.strictEqual(leadership.leaderLockEnabled(), false);
    const lead = leadership.createLeadership({ databaseUrl: 'postgres://unused' });
    assert.strictEqual(lead.enabled, false);
    let elected = 0;
    await lead.start(async () => { elected += 1; });
    assert.strictEqual(elected, 1, 'onElected must run immediately when the lock is disabled');
    assert.strictEqual(lead.isLeader, true);
    await lead.stop(); // must be a safe no-op without a pg client
  });
});

test('PLATFORM_LEADER_LOCK accepts 1 and true', async () => {
  await withLeaderLockEnv('1', () => assert.strictEqual(leadership.leaderLockEnabled(), true));
  await withLeaderLockEnv('true', () => assert.strictEqual(leadership.leaderLockEnabled(), true));
  await withLeaderLockEnv('0', () => assert.strictEqual(leadership.leaderLockEnabled(), false));
});

// ── leadership.js: withMigrationLock ──────────────────────────────────

function fakePool() {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release: () => calls.push({ sql: '<release>' }),
  };
  return { pool: { connect: async () => client }, calls };
}

test('withMigrationLock is a pass-through when the lock is disabled', async () => {
  await withLeaderLockEnv(undefined, async () => {
    const { pool, calls } = fakePool();
    const out = await leadership.withMigrationLock(pool, async () => 'ran');
    assert.strictEqual(out, 'ran');
    assert.strictEqual(calls.length, 0, 'must not touch the pool in single-instance mode');
  });
});

test('withMigrationLock serializes via the advisory lock and always unlocks', async () => {
  await withLeaderLockEnv('1', async () => {
    const { pool, calls } = fakePool();
    const out = await leadership.withMigrationLock(pool, async () => 'migrated');
    assert.strictEqual(out, 'migrated');
    assert.match(calls[0].sql, /pg_advisory_lock/);
    assert.deepStrictEqual(calls[0].params, [leadership.MIGRATE_LOCK_KEY]);
    assert.match(calls[1].sql, /pg_advisory_unlock/);
    assert.strictEqual(calls[2].sql, '<release>', 'the dedicated connection goes back to the pool');

    // The unlock + release must survive a throwing migration.
    const second = fakePool();
    await assert.rejects(
      () => leadership.withMigrationLock(second.pool, async () => { throw new Error('ddl boom'); }),
      /ddl boom/
    );
    assert.match(second.calls[1].sql, /pg_advisory_unlock/,
      'a failed migration must still release the lock or the other color hangs forever');
    assert.strictEqual(second.calls[2].sql, '<release>');
  });
});

test('the two advisory-lock keys are distinct', () => {
  assert.notStrictEqual(leadership.LEADER_LOCK_KEY, leadership.MIGRATE_LOCK_KEY,
    'sharing a key would make a booting color block on the leader instead of just migration');
});

// ── server.js: leader/instance split ──────────────────────────────────

test('server.js runs migrations under the migration lock', () => {
  assert.match(serverJs, /await withMigrationLock\(getPool\(config\), \(\) => migrate\(config\)\)/,
    'two booting colors must never run DDL concurrently');
});

test('singleton background work lives in becomeLeader(), not start()', () => {
  const becomeLeaderBody = serverJs.slice(
    serverJs.indexOf('async function becomeLeader()'),
    serverJs.indexOf('async function start()')
  );
  const startBody = serverJs.slice(
    serverJs.indexOf('async function start()'),
    serverJs.indexOf('// Boot only when run as the entry point')
  );
  assert.ok(becomeLeaderBody.length > 0 && startBody.length > 0, 'both functions must exist');

  // The races blue-green exists to prevent: each of these double-runs if it
  // starts on both colors during the rollout overlap.
  for (const singleton of [
    'recoverActiveWorkers(config)',
    'resumeHeadlessRuns',
    'recoverStuckMerges(config)',
    'recoverSessions(config)',
    'startIdleEvictionSweeper()',
    'startSessionAutoPauseSweeper(config)',
    'startStalePrSweeper(config)',
    'startEligibleMergeSweeper(config)',
    'startTitleHealSweeper(config)',
    'resumeIssueCloseWatches(config)',
    'resumeRunningCampaigns(config',
    "require('./src/services/main-drift-poller').start(config)",
    "require('./src/services/app-heal').start(config)",
    'mobilePush.start()',
  ]) {
    assert.ok(becomeLeaderBody.includes(singleton), `becomeLeader() must own: ${singleton}`);
    assert.ok(!startBody.includes(singleton), `start() must NOT run singleton work: ${singleton}`);
  }

  // Per-instance services every color needs to serve traffic.
  for (const perInstance of [
    'app.listen(config.port',
    'ws.attach(server, config)',
    'chainPoller.start(config)',
    'statusService.start(config)',
    'leadership.start(becomeLeader)',
  ]) {
    assert.ok(startBody.includes(perInstance), `start() must run per-instance: ${perInstance}`);
  }
});

test('cleanup releases leadership after the drain so the standby promotes cleanly', () => {
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  const stopAt = cleanupBody.indexOf('leadership.stop()');
  assert.ok(stopAt !== -1, 'cleanup() must release the leader advisory lock');
  // lastIndexOf: an earlier comment inside cleanup() also says
  // "process.exit(0)" — the real call is the final statement.
  const exitAt = cleanupBody.lastIndexOf('process.exit(0)');
  assert.ok(stopAt < exitAt, 'the release happens before exit, after draining');
  const drainAt = cleanupBody.indexOf('lifecycle.waitFor');
  assert.ok(drainAt !== -1 && drainAt < stopAt,
    'promotion must see a quiesced old leader — release only after the handler drain');
});

// ── docker-compose.yml: the color pair ────────────────────────────────

test('compose defines both colors off one anchor, with the shared alias and leader lock', () => {
  assert.match(compose, /x-usernode-platform: &usernode-platform/);
  assert.match(compose, /usernode-blue:\n    <<: \*usernode-platform\n    container_name: usernode-blue\n    hostname: usernode-blue/);
  assert.match(compose, /usernode-green:\n    <<: \*usernode-platform\n    container_name: usernode-green\n    hostname: usernode-green/);
  assert.doesNotMatch(compose, /container_name: usernode\n/,
    'the single pre-blue-green platform service must be gone');
  assert.match(compose, /aliases:\n\s+- usernode/,
    'both colors must carry the `usernode` network alias for PLATFORM_INTERNAL_URL and the Caddy fallbacks');
  assert.match(compose, /PLATFORM_LEADER_LOCK: "1"/,
    'production must elect a single leader across the colors');
  assert.match(compose, /image: usernode-platform:latest/,
    'one shared tag: build either color, both reference the same image');
  assert.match(compose, /\.\/caddy\/active:\/etc\/caddy\/active:ro/,
    'caddy must see the rollout-managed active-color snippet');
});

// ── platform-rollout.sh: cutover ordering ─────────────────────────────

test('rollout flips traffic before stopping the old color, and gates on health', () => {
  const idleUp = rolloutSh.indexOf('docker compose up -d --no-deps --force-recreate "usernode-$IDLE"');
  const health = rolloutSh.indexOf('wait_healthy "usernode-$IDLE"');
  const flip = rolloutSh.indexOf('write_active "$IDLE"');
  const stopOld = rolloutSh.indexOf('docker compose stop -t "$DRAIN_TIMEOUT" "usernode-$LIVE"');
  assert.ok(idleUp !== -1 && health !== -1 && flip !== -1 && stopOld !== -1);
  assert.ok(idleUp < health && health < flip && flip < stopOld,
    'start idle → health gate → flip caddy → stop old, in that order');
  assert.match(rolloutSh, /reload_caddy/, 'the flip is applied via graceful reload');
  assert.match(rolloutSh, /write_active "\$LIVE"/,
    'a failed reload must revert the active file to the still-live color');
});

test('rollout health poll needs two consecutive successes', () => {
  const waitFn = rolloutSh.slice(rolloutSh.indexOf('wait_healthy() {'));
  assert.match(waitFn.slice(0, 700), /streak/,
    'one 200 from a mid-boot process is not health — do not flip traffic on it');
  assert.match(waitFn.slice(0, 700), /-ge 2/);
});

test('rollout seeds the active file on demand and removes the legacy container', () => {
  assert.match(rolloutSh, /--ensure-active-file/);
  assert.match(rolloutSh, /docker rm -f usernode >\/dev\/null/,
    'the pre-blue-green container runs no leader lock; leaving it up double-runs every sweeper');
  assert.match(deploySh, /platform-rollout\.sh --ensure-active-file/,
    'deploy.sh must seed the file before caddy (re)starts or the Caddyfile import fails');
});

// ── rollback.sh: deterministic kill-switch ────────────────────────────

test('rollback converges on blue and handles pre-blue-green trees', () => {
  assert.match(rollbackSh, /grep -qx usernode-blue/,
    'must detect whether the rolled-back tree is blue-green at all');
  assert.match(rollbackSh, /docker compose stop -t 10 usernode-green/,
    'deterministic post-rollback state: green stopped, blue live');
  assert.match(rollbackSh, /cat > caddy\/active\/platform-upstream\.caddy/,
    'the active file is written inline — the kill-switch cannot depend on the rolled-back rollout script');
  assert.match(rollbackSh, /reverse_proxy usernode-blue:3000/);
  assert.match(rollbackSh, /docker compose up -d usernode-db usernode-node usernode-minio acme-dns caddy/,
    'scoped service list — an unscoped up would start both colors');
  assert.match(rollbackSh, /docker rm -f usernode-blue usernode-green/,
    'rolling back ACROSS the blue-green boundary must clear the color containers');
  // The unscoped `up -d --build` may only exist in the legacy (pre-blue-
  // green tree) branch — inside the blue-green branch it would start both
  // colors at once.
  const bgBranch = rollbackSh.slice(
    rollbackSh.indexOf('grep -qx usernode-blue'),
    rollbackSh.indexOf('else')
  );
  assert.doesNotMatch(bgBranch, /docker compose up -d --build/,
    'the blue-green branch must never do an unscoped build-up');
});

test('the active-color file is host state: excluded from every deploy rsync', () => {
  const deployerSh = read('scripts', 'usernode-deployer.sh');
  const workflow = read('.github', 'workflows', 'deploy.yml');
  assert.match(deployerSh, /--exclude=caddy\/active/);
  assert.match(workflow, /--exclude=caddy\/active/);
  assert.match(rollbackSh, /--exclude=caddy\/active/);
});
