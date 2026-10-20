'use strict';

// Platform signals, wave 2: three detectors and the records they read.
//
//   homeroom_crash         a Homeroom process died: repeat boots in one pod
//                          (platform_booted) and what ended the process
//                          before (platform_pod_exit, read off the Pod at
//                          boot by services/platform-release.js)
//   turn_recovery_gave_up  a retained recovery of an interrupted turn ran
//                          out of attempts (services/recovery-retry.js)
//   bot_health             a figure of the bot's rollout health past its
//                          line (services/homeroom-bot-health.js)
//
// Without a database: each observer reads a stub pool, the pod read is a
// stub Kubernetes client, and the retry runs on fake timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const signals = require('../src/services/platform-signals');
const observers = require('../src/services/platform-signal-observers');
const evidence = require('../src/services/platform-signal-evidence');
const crashes = require('../src/services/signal-observers/homeroom-crashes');
const turnRecovery = require('../src/services/signal-observers/turn-recovery');
const botHealth = require('../src/services/signal-observers/bot-health');
const release = require('../src/services/platform-release');
const recoveryRetry = require('../src/services/recovery-retry');
const events = require('../src/services/events');
const kubernetes = require('../src/services/kubernetes');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const at = (iso) => new Date(iso);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// Every item is one the sweep accepts as it is, and says nothing the
// scrubber would have to take out.
function assertFiles(item) {
  const it = signals.normalizeItem(item);
  assert.ok(it, `${item.kind}:${item.key} is a valid item`);
  assert.deepEqual(it.evidence.lines, item.evidence.lines.map((l) => l.replace(/\s+/g, ' ').trim()),
    'typed lines pass the scrubber unchanged');
  assert.deepEqual(evidence.cleanEvidence(item.evidence).where, item.evidence.where);
  return it;
}

test('the three detectors are wired to their kinds', () => {
  const kinds = observers.OBSERVERS.flatMap((o) => o.kinds);
  for (const kind of ['homeroom_crash', 'turn_recovery_gave_up', 'bot_health']) {
    assert.ok(kinds.includes(kind), kind);
    assert.ok(signals.KINDS[kind], kind);
  }
  assert.equal(events.EVENT_TYPES.PLATFORM_POD_EXIT, 'platform_pod_exit');
  assert.equal(events.EVENT_TYPES.TURN_RECOVERY_GAVE_UP, 'turn_recovery_gave_up');
});

// ── homeroom_crash ──────────────────────────────────────────────────────

function crashPool({ boots = [], exits = [] } = {}) {
  const asked = [];
  return {
    asked,
    query: async (sql) => {
      asked.push(sql);
      if (sql.includes("'platform_pod_exit'")) return { rows: exits };
      if (sql.includes("'platform_booted'")) return { rows: boots };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('homeroom crashes: a crash is a repeat boot in one pod, by the figure\'s own rule', () => {
  const sql = crashes.CRASH_BOOTS_SQL;
  assert.match(sql, /b\.created_at > NOW\(\) - interval '24 hours'/);
  assert.match(sql, /p\.metadata->>'pod' = b\.metadata->>'pod'/);
  assert.match(sql, /p\.created_at < b\.created_at/);
  assert.match(sql, /p\.created_at >= b\.created_at - interval '7 days'/);
  // The infra topic's figure counts the same boots.
  const figures = read('src/services/topic-figures.js');
  assert.match(figures, /AND p\.created_at >= b\.created_at - interval '7 days'\)`;/);
  assert.match(crashes.POD_EXITS_SQL, /e\.event_type = 'platform_pod_exit'\s+AND e\.created_at > NOW\(\) - interval '24 hours'/);
});

test('homeroom crashes: one problem per role, with how each ended, the memory limit and the builds running', async () => {
  const pool = crashPool({
    boots: [
      { created_at: at('2026-10-19T09:00:00Z'), pod: 'social-vibecoding-7d9f-aaaaa', sha: SHA_A, role: 'web' },
      { created_at: at('2026-10-19T08:00:00Z'), pod: 'social-vibecoding-7d9f-bbbbb', sha: SHA_A, role: 'web' },
      { created_at: at('2026-10-19T07:00:00Z'), pod: 'social-vibecoding-conductor-5c-ccccc', sha: SHA_B, role: 'conductor' },
      // Booted before roles were recorded, and no exit read: the platform.
      { created_at: at('2026-10-19T06:00:00Z'), pod: 'social-vibecoding-old-ddddd', sha: SHA_B, role: null },
    ],
    exits: [
      { created_at: at('2026-10-19T09:00:01Z'), metadata: { pod: 'social-vibecoding-7d9f-aaaaa', role: 'web', reason: 'OOMKilled', exitCode: 137, memoryLimit: '6Gi', restartCount: 1 } },
      { created_at: at('2026-10-19T08:00:01Z'), metadata: { pod: 'social-vibecoding-7d9f-bbbbb', role: 'web', reason: 'Error', exitCode: 1, memoryLimit: '6Gi', restartCount: 3 } },
      // A pod up longer than the figure's 7 days: its exit still counts.
      { created_at: at('2026-10-19T10:00:00Z'), metadata: { pod: 'social-vibecoding-7d9f-eeeee', role: 'web', reason: 'OOMKilled', exitCode: 137, memoryLimit: '6Gi' } },
    ],
  });
  const items = await crashes.run(pool);
  assert.equal(pool.asked.length, 2);
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.deepEqual(Object.keys(byKey).sort(), ['conductor', 'platform', 'web']);

  const web = byKey.web;
  assert.equal(web.kind, 'homeroom_crash');
  assert.equal(web.occurrences, 3);
  assert.deepEqual(web.subject, { role: 'web' });
  assert.equal(web.title, 'Homeroom\'s web process crashed');
  assert.deepEqual(web.evidence.lines, [
    '3 crashes in the last 24 hours, the first at 2026-10-19T08:00:00Z, the last at 2026-10-19T10:00:00Z.',
    'How it ended: OOMKilled (exit code 137) 2 times, Error (exit code 1) 1 time.',
    'Memory limit: 6Gi.',
    'Running: aaaaaaa (2 crashes).',
    'Pods: social-vibecoding-7d9f-aaaaa, social-vibecoding-7d9f-bbbbb, social-vibecoding-7d9f-eeeee.',
  ]);
  assert.deepEqual(web.evidence.where, ['deploy/helm/social-vibecoding-platform/values.yaml', 'server.js'],
    'the memory limit for the OOMs, the process for the rest');

  const conductor = byKey.conductor;
  assert.equal(conductor.occurrences, 1);
  assert.match(conductor.title, /conductor crashed/);
  assert.ok(conductor.evidence.lines.includes('No reason recorded for 1 crash: the process that came back up could not read its pod.'));
  assert.deepEqual(conductor.evidence.where, ['server.js']);

  assert.equal(byKey.platform.occurrences, 1);
  assert.match(byKey.platform.title, /server process crashed/);

  for (const item of items) {
    const it = assertFiles(item);
    assert.equal(it.fingerprint, `homeroom_crash:${item.key}`);
    assert.equal(it.topic, 'infra');
    assert.equal(it.fixer, 'bot');
  }
});

test('homeroom crashes: only OOMs point at the memory limit; a role\'s label wins over a boot\'s; none is nothing', async () => {
  const items = await crashes.run(crashPool({
    boots: [{ created_at: at('2026-10-19T09:00:00Z'), pod: 'p-1', sha: SHA_A, role: null }],
    exits: [{ created_at: at('2026-10-19T09:00:01Z'), metadata: { pod: 'p-1', role: 'conductor', reason: 'OOMKilled', exitCode: 137, memoryLimit: '4Gi' } }],
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'conductor', 'the pod\'s own label names the role');
  assert.equal(items[0].occurrences, 1, 'a boot and its exit are one crash');
  assert.deepEqual(items[0].evidence.where, ['deploy/helm/social-vibecoding-platform/values.yaml']);

  assert.equal(crashes.roleOf('all'), 'platform');
  assert.equal(crashes.roleOf(undefined), 'platform');
  assert.equal(crashes.roleOf('Web'), 'web');
  assert.deepEqual(await crashes.run(crashPool()), []);
  await assert.rejects(crashes.run({ query: async () => { throw new Error('db down'); } }), /db down/,
    'a pass that could not look throws, so nothing of its kind is cleared');
});

// ── What ended the last process in a pod ────────────────────────────────

function platformPod({ terminated, restartCount = 2, label = 'web', limit = '6Gi', extra = [] } = {}) {
  return {
    metadata: { name: 'social-vibecoding-7d9f-aaaaa', labels: label ? { 'social.usernode.io/process-role': label } : {} },
    spec: { containers: [...extra.map((name) => ({ name })), { name: 'platform', resources: { limits: { cpu: '4', memory: limit } } }] },
    status: {
      containerStatuses: [
        ...extra.map((name) => ({ name, restartCount: 9, lastState: { terminated: { reason: 'Completed', exitCode: 0 } } })),
        { name: 'platform', restartCount, state: { running: {} }, lastState: terminated ? { terminated } : {} },
      ],
    },
  };
}

test('a pod\'s exit: the platform container\'s last end, its role label and memory limit', () => {
  const exit = release.podExitOf(platformPod({
    extra: ['sidecar'],
    terminated: { reason: 'OOMKilled', exitCode: 137, startedAt: new Date('2026-10-19T08:00:00Z'), finishedAt: new Date('2026-10-19T09:00:00Z') },
  }));
  assert.deepEqual(exit, {
    pod: 'social-vibecoding-7d9f-aaaaa',
    role: 'web',
    container: 'platform',
    reason: 'OOMKilled',
    exitCode: 137,
    signal: null,
    startedAt: '2026-10-19T08:00:00.000Z',
    finishedAt: '2026-10-19T09:00:00.000Z',
    restartCount: 2,
    memoryLimit: '6Gi',
  });
  assert.equal(release.podExitOf(platformPod({ restartCount: 0 })), null, 'a pod\'s first container ended nothing');
  assert.equal(release.podExitOf({}), null);
  assert.equal(release.podExitOf(null), null);
  const unlabelled = platformPod({ label: null, terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-19T09:00:00Z' } });
  assert.equal(release.podExitOf(unlabelled, { role: 'conductor' }).role, 'conductor', 'the role it was told, when the pod has no label');
});

test('a process on Kubernetes records what ended the one before it; staging, off Kubernetes and no namespace read nothing', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push(params); return { rows: [] }; } };
  const reads = [];
  const readPod = async (args) => {
    reads.push(args);
    return platformPod({ terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-19T09:00:00Z' } });
  };
  const base = { pod: 'social-vibecoding-7d9f-aaaaa', namespace: 'social-platform', readPod, role: null };

  assert.equal(await release.recordPodExit(pool, { ...base, env: 'staging', onKubernetes: true }), null);
  assert.equal(await release.recordPodExit(pool, { ...base, env: 'production', onKubernetes: false }), null);
  assert.equal(await release.recordPodExit(pool, { ...base, env: 'production', onKubernetes: true, namespace: '' }), null);
  assert.equal(reads.length, 0, 'nothing is read where nothing is recorded');
  assert.equal(calls.length, 0);

  const exit = await release.recordPodExit(pool, { ...base, env: 'production', onKubernetes: true });
  assert.deepEqual(reads, [{ name: 'social-vibecoding-7d9f-aaaaa', namespace: 'social-platform' }]);
  assert.equal(exit.reason, 'OOMKilled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 'platform_pod_exit');
  assert.deepEqual(JSON.parse(calls[0][4]), exit);

  // A first container ended nothing: no row.
  await release.recordPodExit(pool, { ...base, env: 'production', onKubernetes: true, readPod: async () => platformPod() });
  assert.equal(calls.length, 1);
});

test('reading the pod never throws: not allowed, timed out, or the database down', async () => {
  const forbidden = Object.assign(new Error('pods is forbidden'), { code: 403 });
  const base = { env: 'production', onKubernetes: true, pod: 'p-1', namespace: 'social-platform', role: null };
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await release.recordPodExit(pool, { ...base, readPod: async () => { throw forbidden; } }), null);
  assert.equal(await release.recordPodExit(pool, { ...base, readPod: () => { throw forbidden; } }), null);
  const broken = { query: () => { throw new Error('db down'); } };
  const exit = await release.recordPodExit(broken, {
    ...base, readPod: async () => platformPod({ terminated: { reason: 'Error', exitCode: 1 } }),
  });
  assert.equal(exit.reason, 'Error', 'the row is best effort: events.record swallows its failure');
});

test('a boot says it came up, with its role, and what ended the process before it', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push(params); return { rows: [] }; } };
  await release.recordBoot(pool, {
    sha: SHA_A, env: 'production', onKubernetes: true, pod: 'social-vibecoding-7d9f-aaaaa',
    role: 'web', namespace: 'social-platform',
    readPod: async () => platformPod({ terminated: { reason: 'OOMKilled', exitCode: 137 } }),
  });
  assert.deepEqual(calls.map((p) => p[3]).sort(), ['platform_booted', 'platform_pod_exit']);
  const booted = JSON.parse(calls.find((p) => p[3] === 'platform_booted')[4]);
  assert.deepEqual(booted, { sha: SHA_A, pod: 'social-vibecoding-7d9f-aaaaa', role: 'web' });

  // Off Kubernetes and on staging: neither.
  calls.length = 0;
  let reads = 0;
  const readPod = async () => { reads += 1; return platformPod({ terminated: { reason: 'Error' } }); };
  await release.recordBoot(pool, { env: 'staging', onKubernetes: true, pod: 'x', namespace: 'n', readPod });
  await release.recordBoot(pool, { env: 'production', onKubernetes: false, pod: 'x', namespace: 'n', readPod });
  assert.equal(calls.length, 0);
  assert.equal(reads, 0);
  // A read that fails costs the exit, never the boot.
  await release.recordBoot(pool, {
    env: 'production', onKubernetes: true, pod: 'x', namespace: 'n', role: null, readPod: async () => { throw new Error('forbidden'); },
  });
  assert.deepEqual(calls.map((p) => p[3]), ['platform_booted']);
});

test('the platform reads its own pod through the Kubernetes client, bounded', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({ core: { readNamespacedPod: async (request) => {
    assert.deepEqual(request, { name: 'social-vibecoding-7d9f-aaaaa', namespace: 'social-platform' });
    return { metadata: { name: request.name } };
  } } });
  const pod = await kubernetes.readPlatformPod({ name: 'social-vibecoding-7d9f-aaaaa', namespace: 'social-platform' });
  assert.equal(pod.metadata.name, 'social-vibecoding-7d9f-aaaaa');

  kubernetes._setClientsForTest({ core: { readNamespacedPod: () => new Promise(() => {}) } });
  await assert.rejects(kubernetes.readPlatformPod({ name: 'p', namespace: 'n', timeoutMs: 20 }), /timed out/);
});

test('the platform\'s service account may get pods in its own namespace, and nothing more on them', () => {
  const rbac = read('deploy/helm/social-vibecoding-platform/templates/rollout-rbac.yaml');
  const role = rbac.split(/^---$/m)[0];
  assert.match(role, /^kind: Role$/m, 'a Role, in the release namespace, not a ClusterRole');
  assert.match(role, /- apiGroups: \[""\]\n\s+resources: \[pods\]\n\s+verbs: \[get\]/);
  assert.doesNotMatch(role, /verbs: \[[^\]]*(list|watch|create|update|patch|delete)/);
  assert.match(rbac, /name: social-platform-runtime/, 'bound to the account the platform runs as');
  assert.match(read('deploy/helm/social-vibecoding-platform/templates/platform.yaml'),
    /- name: PLATFORM_NAMESPACE\n\s+valueFrom: \{fieldRef: \{fieldPath: metadata\.namespace\}\}/,
    'the namespace it reads its pod in');
});

// ── turn_recovery_gave_up ───────────────────────────────────────────────

// A coding run's recovery is tried again by its turn's work item
// (services/turns.js RECOVERY_RETRY); running out of tries records the
// give-up the platform signal files a request for.
async function recoverTurn({ pool, recover, tries = 2 }) {
  const turns = require('../src/services/turns');
  const recovery = require('../src/services/turn-recovery');
  const saved = { recoverOwnedTurn: recovery.recoverOwnedTurn, releaseLeftRecord: recovery.releaseLeftRecord, retry: { ...turns.RECOVERY_RETRY } };
  recovery.recoverOwnedTurn = recover;
  recovery.releaseLeftRecord = async () => null;
  Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries });
  try {
    return await turns.run({
      workId: 'w', kind: 'turn.run', key: 'run:t', resumeFrom: null, lostAttempts: 0, signal: new AbortController().signal,
      input: { kind: 'recover', sessionId: 5030, turnId: 't', instanceKey: 'session:5030' },
    }, { config: {}, pool });
  } finally {
    Object.assign(recovery, { recoverOwnedTurn: saved.recoverOwnedTurn, releaseLeftRecord: saved.releaseLeftRecord });
    Object.assign(turns.RECOVERY_RETRY, saved.retry);
  }
}

test('a recovery that runs out of tries records that it gave up, with its session and code', async () => {
  const calls = [];
  const pool = { query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [] }); } };
  let tried = 0;
  await assert.rejects(recoverTurn({
    pool,
    recover: async () => {
      tried += 1;
      throw Object.assign(new Error('No commits between main and dev/x'), { code: 'no_commits', retryWorkerRecovery: true });
    },
  }), /No commits/);
  assert.equal(tried, 2);
  const records = calls.filter((c) => /INSERT INTO events/.test(c.sql));
  assert.equal(records.length, 1, 'once, as it gives up');
  assert.deepEqual(records[0].params.slice(0, 4), [null, null, 5030, 'turn_recovery_gave_up']);
  assert.deepEqual(JSON.parse(records[0].params[4]), { sessionId: 5030, recovery: 'interactive', code: 'no_commits', failures: 2 });
});

test('a recovery that succeeds, or stops on an error trying again cannot help, records no give-up; a record that fails costs nothing', async () => {
  const calls = [];
  const pool = { query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [] }); } };
  await recoverTurn({ pool, recover: async () => {} });
  await assert.rejects(recoverTurn({ pool, recover: async () => { throw Object.assign(new Error('bad state'), { code: 'recovery_retry_state_invalid' }); } }));
  assert.equal(calls.filter((c) => /INSERT INTO events/.test(c.sql)).length, 0);
  // The database throwing as it is asked, and a key with no session id.
  assert.doesNotThrow(() => recoveryRetry.recordGaveUp({ pool: { query: () => { throw new Error('db down'); } }, key: 'test:no-session', err: new Error('x'), failures: 1 }));
  assert.doesNotThrow(() => recoveryRetry.recordGaveUp({ pool: null, key: undefined, err: null, failures: 'x' }));
});

test('turns given up on: one problem for the day, with the codes, the recoveries and the sessions', async () => {
  const rows = [
    { created_at: at('2026-10-19T09:00:00Z'), session_id: 5030, metadata: { sessionId: 5030, recovery: 'interactive', code: 'no_commits', failures: 30 } },
    { created_at: at('2026-10-19T08:00:00Z'), session_id: 5031, metadata: { sessionId: 5031, recovery: 'interactive', code: 'no_commits', failures: 30 } },
    { created_at: at('2026-10-19T07:00:00Z'), session_id: null, metadata: { sessionId: 812, recovery: 'headless', code: null, failures: 30 } },
  ];
  let asked = null;
  const items = await turnRecovery.run({ query: async (sql) => { asked = sql; return { rows }; } });
  assert.equal(asked, turnRecovery.GAVE_UP_SQL);
  assert.match(asked, /e\.event_type = 'turn_recovery_gave_up'\s+AND e\.created_at > NOW\(\) - interval '24 hours'/);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, 'turn_recovery_gave_up');
  assert.equal(item.key, 'all');
  assert.equal(item.occurrences, 3);
  assert.deepEqual(item.evidence.lines, [
    '3 turns given up on in the last 24 hours, the first at 2026-10-19T07:00:00Z, the last at 2026-10-19T09:00:00Z.',
    'Error codes of the last failed attempt: no_commits (2), no code (1).',
    'Recoveries: interactive (2), headless (1).',
    'Attempts before giving up: 30.',
    'Sessions: 5030, 5031, 812.',
  ]);
  assert.deepEqual(item.evidence.where, ['src/services/recovery-retry.js', 'src/services/turn-lifecycle.js']);
  const it = assertFiles(item);
  assert.equal(it.fingerprint, 'turn_recovery_gave_up:all');
  assert.equal(it.fixer, 'bot');

  assert.deepEqual(await turnRecovery.run({ query: async () => ({ rows: [] }) }), [], 'none in the day is no problem');
});

// ── bot_health ──────────────────────────────────────────────────────────

// The four reads of homeroom-bot-health.js rolloutHealth, by what they ask.
function healthPool({ proposals = {}, questions = {}, turns = {}, chat = {}, fail = null } = {}) {
  const asked = [];
  return {
    asked,
    query: async (sql, params) => {
      asked.push(params);
      const which = sql.includes('homeroom_bot_dm_turns') ? 'chat'
        : sql.includes('question_status') ? 'questions'
          : sql.includes('build_ok') ? 'turns'
            : sql.includes('promoted_at') ? 'proposals' : null;
      assert.ok(which, `unexpected query: ${sql}`);
      if (fail === which) throw new Error(`${which} read failed`);
      return { rows: [{ proposals, questions, turns, chat }[which]] };
    },
  };
}

test('bot health: a figure past its line with enough behind it is a problem; one within it, or too thin, is not', async () => {
  const pool = healthPool({
    proposals: { up: 5, merged: 1, open: 0, timed: 2, median_secs: 40 * 3600 },
    questions: { asked: 2, answered: 0, closed: 0, waiting_of_asked: 2, waiting: 2 },
    turns: { runs: 16, failed: 3, builds: 4, builds_failed: 1 },
    chat: { turns: 30, failed: 1, broken: 0, recovered: 2, claims: 0 },
  });
  const items = await botHealth.run(pool);
  assert.ok(pool.asked.some((p) => p[0] === 'homeroom_bot'), 'the bot\'s own proposals');
  assert.deepEqual(items.map((i) => i.key).sort(), ['mergeRate', 'turnFailures'],
    'time to proposal and questions are too thin to judge; DM answers are within their line');

  const turns = items.find((i) => i.key === 'turnFailures');
  assert.equal(turns.title, 'Homeroom bot health: turn failures above 10%');
  assert.equal(turns.topic, 'homeroom-bot');
  assert.deepEqual(turns.subject, { figure: 'turnFailures' });
  assert.deepEqual(turns.evidence.lines, [
    'Over the last 7 days, 4 of 20 turns failed (20%).',
    'Its line is above 10%, judged from 10 turns or more; this is from 20 turns.',
    '3 of 16 triage and follow-up turns, 1 of 4 builds. A turn stopped on its budget is not counted.',
  ]);
  assert.deepEqual(turns.evidence.where, ['src/services/homeroom-bot-health.js']);

  const merges = items.find((i) => i.key === 'mergeRate');
  assert.equal(merges.title, 'Homeroom bot health: proposals merging below 50%');
  assert.equal(merges.evidence.lines[0], 'Over the last 7 days, 1 of 5 settled proposals merged (20%).');

  for (const item of items) {
    const it = assertFiles(item);
    assert.equal(it.fingerprint, `bot_health:${item.key}`);
    assert.equal(it.fixer, 'person');
  }
});

test('bot health: every watched figure has its words, and the lines follow the thresholds', () => {
  const health = require('../src/services/homeroom-bot-health');
  assert.deepEqual(Object.keys(botHealth.FIGURES).sort(), Object.keys(health.THRESHOLDS).sort());
  const h = health.shapeHealth({
    proposals: { up: 6, merged: 1, open: 0, timed: 5, median_secs: 30 * 3600, slowest_secs: 50 * 3600 },
    questions: { asked: 6, answered: 1, closed: 0, waiting_of_asked: 5, waiting: 5 },
    turns: { runs: 20, failed: 5, builds: 0, builds_failed: 0 },
    chat: { turns: 20, failed: 5, broken: 1, recovered: 0, claims: 0 },
  });
  const items = botHealth.healthItems(h);
  assert.deepEqual(items.map((i) => i.title), [
    'Homeroom bot health: proposals merging below 50%',
    'Homeroom bot health: request to proposal above 24 hours',
    'Homeroom bot health: questions waiting above 50%',
    'Homeroom bot health: turn failures above 10%',
    'Homeroom bot health: DM answer failures above 10%',
  ]);
  for (const item of items) assertFiles(item);
  assert.equal(items[1].evidence.lines[0], 'Over the last 7 days, the median from a request to its proposal was 30 hours.');
  assert.deepEqual(botHealth.healthItems(health.shapeHealth({})), [], 'a quiet week is not a broken one');
});

test('bot health: a read that fails throws, so a figure it could not look at is not cleared', async () => {
  await assert.rejects(botHealth.run(healthPool({ fail: 'turns' })), /turns read failed/);
  // The dashboard still reads soft, to zeros.
  const health = require('../src/services/homeroom-bot-health');
  const h = await health.rolloutHealth(healthPool({ fail: 'turns' }), { botUsername: 'homeroom_bot' });
  assert.equal(h.turns.runs, 0);
});
