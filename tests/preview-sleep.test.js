'use strict';

// A preview asleep (#6157, src/services/preview-sleep.js): the sleep pass
// (staging-reap.js sweepSleep) scales an unused preview to no replicas and
// keeps everything else; whatever opens it wakes it (a Preview click, a
// direct link, a checks run), with no rebuild. The cluster is an in-memory
// fake behind kubernetes.js's own client seam, and the session rows a fake
// pool that answers the statements this module writes.
//
// Run with: node --test tests/preview-sleep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

test('the preview idle default is one hour, with a configurable window and zero to disable', () => {
  const { sleepAfterMs, DEFAULT_SLEEP_AFTER_MS } = require('../src/services/preview-sleep');
  assert.equal(DEFAULT_SLEEP_AFTER_MS, 60 * 60 * 1000);
  assert.equal(sleepAfterMs({ previewSleepAfterMs: NaN }), DEFAULT_SLEEP_AFTER_MS);
  assert.equal(sleepAfterMs({ previewSleepAfterMs: 30 * 60 * 1000 }), 30 * 60 * 1000);
  assert.equal(sleepAfterMs({ previewSleepAfterMs: 0 }), 0);
});

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── The session rows ────────────────────────────────────────────────────
const rows = new Map();
const statements = [];
const olderBuilds = { n: 0 };
const busy = new Set();
const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    statements.push(text);
    // staging-reap sweepSleep: the previews unused past the window.
    if (/FROM chat_sessions cs\s+JOIN wf_instances w/.test(text)) {
      return { rows: [...rows.values()].filter((r) => r.listed !== false && !r.staging_asleep_at).map((r) => ({
        id: r.id, app_id: 1, status: r.status, last_activity_at: r.last_activity_at, staging_asleep_at: r.staging_asleep_at,
        staging_runtime_name: r.staging_runtime_name, machine_state: r.machine_state, serving: r.serving, check_run_open: false,
      })) };
    }
    // sleep: the claim, which the real statement makes only while the row is
    // still what was chosen (`claimable`).
    if (/UPDATE chat_sessions cs SET staging_asleep_at = now\(\)/.test(text)) {
      const r = rows.get(params[0]);
      if (!r || !r.claimable || r.staging_asleep_at || r.staging_runtime_name !== params[1] || r.serving.n !== params[3]) return { rows: [] };
      r.staging_asleep_at = '2026-11-02T12:00:00Z';
      return { rows: [{ id: r.id }] };
    }
    if (/UPDATE chat_sessions SET staging_asleep_at = NULL WHERE id = \$1/.test(text)) {
      rows.get(params[0]).staging_asleep_at = null;
      return { rows: [] };
    }
    if (/SET staging_asleep_db_bytes = \$2/.test(text)) {
      const r = rows.get(params[0]);
      if (r?.staging_asleep_at) r.staging_asleep_db_bytes = params[1];
      return { rows: [] };
    }
    if (/SELECT id, app_id, staging_url, staging_runtime_kind, staging_runtime_name, staging_asleep_at/.test(text)) {
      const r = rows.get(params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    // wake: the sleep ends.
    if (/SET staging_asleep_at = NULL, staging_asleep_db_bytes = NULL,\s+last_activity_at/.test(text)) {
      const r = rows.get(params[0]);
      if (r && r.staging_runtime_name === params[1]) {
        Object.assign(r, { staging_asleep_at: null, staging_asleep_db_bytes: null, last_activity_at: 'now' });
      }
      return { rows: [] };
    }
    if (/UPDATE chat_sessions cs SET last_activity_at = now\(\)/.test(text)) return { rows: [] };
    // wakeByHost: the session a preview host names, of that app.
    if (/FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = \$1 AND a.slug = \$2/.test(text)) {
      const r = rows.get(params[0]);
      return { rows: r && r.slug === params[1] ? [{ ...r }] : [] };
    }
    // sweepSleep: the workflow processes of another build still serving.
    if (/FROM platform_processes/.test(text)) return { rows: [{ n: olderBuilds.n }] };
    if (/count\(staging_asleep_db_bytes\)/.test(text)) {
      const asleep = [...rows.values()].filter((r) => r.staging_asleep_at);
      return { rows: [{ count: asleep.length, bytes: String(asleep.reduce((n, r) => n + (r.staging_asleep_db_bytes || 0), 0)),
        measured: asleep.filter((r) => r.staging_asleep_db_bytes != null).length }] };
    }
    throw new Error(`preview-sleep stub: unexpected query: ${text.slice(0, 120)}`);
  },
};
stub('../src/db/pool', { getPool: () => pool });
stub('../src/services/active-workers', {
  busySessionsAnywhere: async (ids) => new Set(ids.map(Number).filter((id) => busy.has(id))),
  isSessionBusyAnywhere: async (id) => busy.has(Number(id)),
});
const sizes = new Map();
stub('../src/services/db-manager', {
  async databaseSize(db) { return sizes.has(db) ? sizes.get(db) : null; },
  previewServerConfigured: () => false,
});

const kubernetes = require('../src/services/kubernetes');
const previewSleep = require('../src/services/preview-sleep');
const stagingReap = require('../src/services/staging-reap');

// ── The cluster ─────────────────────────────────────────────────────────
const CONFIG = { previewSleepAfterMs: 2 * 3600 * 1000, kubernetes: { appNamespace: 'apps', appGate: 'off' } };
const NAME = 'sv-preview-1-s7';
const ASSETS = kubernetes.PLATFORM_ASSET_NAME;
const notFound = () => Object.assign(new Error('not found'), { code: 404 });

function cluster({ fence = '3', podStarts = true } = {}) {
  const store = new Map();
  const writes = [];
  store.set('deployment', {
    metadata: { name: NAME, uid: 'd1', resourceVersion: '1', generation: 1, annotations: { [kubernetes.PREVIEW_ATTEMPT_ANNOTATION]: fence } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: 'app@sha256:3' }] } } },
  });
  store.set('service', { metadata: { name: NAME, resourceVersion: '1' }, spec: { selector: { 'social.usernode.io/runtime-name': NAME } } });
  store.set('ingress', { metadata: { name: NAME, resourceVersion: '1' }, spec: { rules: [{ host: 'shop--s7.apps.example.invalid', http: { paths: [
    { path: '/usernode-bridge/', pathType: 'Prefix', backend: { service: { name: ASSETS, port: { number: 3000 } } } },
    { path: '/', pathType: 'Prefix', backend: { service: { name: NAME, port: { number: 3000 } } } },
  ] } }] } });
  const read = (kind) => {
    const o = store.get(kind);
    if (!o) throw notFound();
    return structuredClone(o);
  };
  const replace = (kind) => async ({ body }) => {
    const cur = store.get(kind);
    if (body.metadata.resourceVersion && body.metadata.resourceVersion !== cur.metadata.resourceVersion) {
      throw Object.assign(new Error('conflict'), { code: 409 });
    }
    const next = structuredClone(body);
    next.metadata.resourceVersion = String(Number(cur.metadata.resourceVersion) + 1);
    next.metadata.generation = (cur.metadata.generation || 1) + 1;
    store.set(kind, next);
    writes.push(kind);
    return structuredClone(next);
  };
  kubernetes._setClientsForTest({
    apps: {
      readNamespacedDeployment: async () => {
        const d = read('deployment');
        const replicas = d.spec.replicas;
        const up = podStarts ? replicas : 0;
        d.status = { observedGeneration: d.metadata.generation, replicas, updatedReplicas: replicas, readyReplicas: up, availableReplicas: up };
        return d;
      },
      replaceNamespacedDeployment: replace('deployment'),
    },
    core: { readNamespacedService: async () => read('service') },
    networking: { readNamespacedIngress: async () => read('ingress'), replaceNamespacedIngress: replace('ingress') },
  });
  return { store, writes, catchAll: () => store.get('ingress').spec.rules[0].http.paths[1].backend.service.name };
}

function preview(extra = {}) {
  const row = {
    id: 7, slug: 'shop', status: 'promoted', claimable: true,
    staging_url: 'https://shop--s7.apps.example.invalid', staging_runtime_kind: 'kubernetes', staging_runtime_name: NAME,
    staging_asleep_at: null, staging_asleep_db_bytes: null, last_activity_at: '2026-11-02T08:00:00Z',
    machine_state: 'settled', serving: { n: 3, db: 'app_shop_staging_s7_abcdef' }, ...extra,
  };
  rows.clear();
  rows.set(row.id, row);
  return row;
}

const edgeAnswers = { staging: { verifyStagingEdge: async () => ({ ok: true, code: 200 }) } };

test.afterEach(() => {
  kubernetes._setClientsForTest(null);
  previewSleep._resetForTest();
  busy.clear();
  sizes.clear();
  statements.length = 0;
});

test('the sleep pass scales an unused vote-backed preview to none and keeps its Service, image and database; its link goes to the waking page', async () => {
  const c = cluster();
  const row = preview();
  sizes.set('app_shop_staging_s7_abcdef', 2_500_000_000);
  const service = structuredClone(c.store.get('service'));
  const summary = await stagingReap.sweepSleep(CONFIG);
  assert.equal(summary.asleep, 1);
  assert.equal(summary.dbBytes, 2_500_000_000, 'what it still holds is logged');
  assert.equal(c.store.get('deployment').spec.replicas, 0);
  assert.equal(c.store.get('deployment').spec.template.spec.containers[0].image, 'app@sha256:3');
  assert.deepEqual(c.store.get('service'), service);
  assert.equal(c.catchAll(), ASSETS, 'the gate is off: its link is answered by the asset backend\'s waking page');
  assert.equal(c.store.get('ingress').spec.rules[0].http.paths[0].path, '/usernode-bridge/');
  assert.ok(row.staging_asleep_at, 'the row says Asleep');
  assert.equal(row.staging_asleep_db_bytes, 2_500_000_000);
  assert.ok(!statements.some((s) => /staging_url = NULL|DELETE/.test(s)), 'nothing is torn down');
  assert.deepEqual(await previewSleep.asleepTotals(pool), { count: 1, bytes: 2_500_000_000, measured: 1 });
});

test('the sleep pass leaves a preview somebody works on, and one used inside the window', async () => {
  const c = cluster();
  preview();
  busy.add(7);
  assert.equal((await stagingReap.sweepSleep(CONFIG)).asleep, 0);
  busy.clear();
  preview({ last_activity_at: new Date(Date.now() - 60 * 1000).toISOString() });
  assert.equal((await stagingReap.sweepSleep(CONFIG)).asleep, 0);
  assert.deepEqual(c.writes, []);
  assert.deepEqual(await stagingReap.sweepSleep({ ...CONFIG, previewSleepAfterMs: 0 }), {
    examined: 0, eligible: 0, asleep: 0, skipped: 0, failed: 0, dbBytes: 0, off: true,
  }, 'PREVIEW_SLEEP_AFTER_MS=0 switches it off');
});

test('nothing sleeps while a process of another build still runs the workflow: it would check a sleeping preview without waking it', async () => {
  const c = cluster();
  const row = preview();
  olderBuilds.n = 1;
  try {
    assert.equal((await stagingReap.sweepSleep(CONFIG)).rollout, true);
    assert.deepEqual(c.writes, []);
    assert.equal(row.staging_asleep_at, null);
  } finally { olderBuilds.n = 0; }
  assert.equal((await stagingReap.sweepSleep(CONFIG)).asleep, 1, 'once it is gone');
});

test('a preview that changed since it was chosen is not put to sleep, and a claim whose scale did not happen is given back', async () => {
  // The claim no longer holds: somebody opened it, or the machine started
  // a build, between the choice and the claim.
  let c = cluster();
  preview({ claimable: false });
  assert.equal((await previewSleep.sleep(CONFIG, pool, rows.get(7))).outcome, 'skipped_changed');
  assert.deepEqual(c.writes, []);
  // Another attempt wrote the Deployment since: never scaled down.
  c = cluster({ fence: '4' });
  const row = preview();
  assert.equal((await previewSleep.sleep(CONFIG, pool, row)).outcome, 'skipped_superseded');
  assert.equal(c.store.get('deployment').spec.replicas, 1);
  assert.equal(row.staging_asleep_at, null, 'the claim is given back');
});

test('waking scales back to one, waits for the pod, routes the link back and ends the sleep: no rebuild', async () => {
  const c = cluster();
  const row = preview();
  await previewSleep.sleep(CONFIG, pool, row);
  assert.equal(c.store.get('deployment').spec.replicas, 0);
  const out = await previewSleep.wake(CONFIG, pool, 7, { deps: edgeAnswers, edgePollMs: 1 });
  assert.equal(out.status, 'woke');
  assert.equal(out.url, 'https://shop--s7.apps.example.invalid');
  assert.equal(c.store.get('deployment').spec.replicas, 1);
  assert.equal(c.store.get('deployment').spec.template.spec.containers[0].image, 'app@sha256:3', 'the same image');
  assert.equal(c.catchAll(), NAME, 'the link goes to the preview again');
  assert.equal(row.staging_asleep_at, null);
  assert.equal(row.last_activity_at, 'now', 'woken is used: it does not sleep again at once');
  assert.equal((await previewSleep.wake(CONFIG, pool, 7)).status, 'awake', 'a preview awake is left as it is');
});

test('two doors at once share one wake', async () => {
  const c = cluster();
  const row = preview();
  await previewSleep.sleep(CONFIG, pool, row);
  const writes = c.writes.length;
  const [a, b] = await Promise.all([
    previewSleep.wake(CONFIG, pool, 7, { deps: edgeAnswers, edgePollMs: 1 }),
    previewSleep.wake(CONFIG, pool, 7, { deps: edgeAnswers, edgePollMs: 1 }),
  ]);
  assert.equal(a, b);
  assert.deepEqual(c.writes.slice(writes), ['deployment', 'ingress'], 'one scale, one route');
});

test('a checks run\'s wake: one read when awake; a preview that does not wake in time is not ok, and stays recorded asleep', async () => {
  let c = cluster();
  preview();
  assert.deepEqual(await previewSleep.wakeForRun(CONFIG, pool, 7), { ok: true, woke: false });
  assert.deepEqual(c.writes, []);
  c = cluster({ podStarts: false });
  const row = preview();
  await previewSleep.sleep(CONFIG, pool, row);
  const out = await previewSleep.wakeForRun(CONFIG, pool, 7, { timeoutMs: 30, deps: edgeAnswers });
  assert.equal(out.ok, false);
  assert.match(out.detail, /asleep and did not wake in time/);
  assert.ok(row.staging_asleep_at, 'the next door asks again');
  assert.equal(c.catchAll(), ASSETS, 'its link still says it is waking');
});

test('a direct link\'s wake: the host names the preview, of its own app; anything else wakes nothing', async () => {
  const c = cluster();
  const row = preview();
  await previewSleep.sleep(CONFIG, pool, row);
  const writes = c.writes.length;
  assert.deepEqual(await previewSleep.wakeByHost(CONFIG, pool, 'shop.apps.example.invalid'), { status: 'unknown' });
  assert.deepEqual(await previewSleep.wakeByHost(CONFIG, pool, 'other--s7.apps.example.invalid'), { status: 'unknown' },
    'another app\'s name on this session');
  assert.deepEqual(await previewSleep.wakeByHost(CONFIG, pool, 'shop--s7.apps.example.invalid', { deps: edgeAnswers }), { status: 'waking' });
  assert.deepEqual(await previewSleep.wakeByHost(CONFIG, pool, 'shop--s7.apps.example.invalid'), { status: 'waking' },
    'asked again within seconds: the same wake');
  for (let i = 0; i < 100 && row.staging_asleep_at; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(row.staging_asleep_at, null);
  assert.deepEqual(c.writes.slice(writes), ['deployment', 'ingress']);
});

test('only Kubernetes previews sleep, and the row says when one is asleep', () => {
  assert.equal(previewSleep.isAsleep({ staging_asleep_at: '2026-11-02T12:00:00Z', staging_runtime_kind: 'kubernetes' }), true);
  assert.equal(previewSleep.isAsleep({ staging_asleep_at: null, staging_runtime_kind: 'kubernetes' }), false);
  assert.equal(previewSleep.isAsleep({ staging_asleep_at: '2026-11-02T12:00:00Z', staging_runtime_kind: 'docker' }), false);
  assert.deepEqual(previewSleep.previewSessionOfHost('shop--s7.apps.example.invalid'), { sessionId: 7, slug: 'shop', host: 'shop--s7.apps.example.invalid' });
  assert.equal(previewSleep.previewSessionOfHost('shop.apps.example.invalid'), null);
});

test('a new attempt serves awake, and a retired preview is not asleep: the machine\'s writes end the sleep', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/workflow/preview/machine.ts'), 'utf8');
  const published = src.slice(src.indexOf('async published('), src.indexOf('async unpublished('));
  assert.match(published, /staging_asleep_at = NULL, staging_asleep_db_bytes = NULL/);
  const unpublished = src.slice(src.indexOf('async unpublished('), src.indexOf('async prepareFailed('));
  assert.match(unpublished, /staging_asleep_at = NULL, staging_asleep_db_bytes = NULL/);
});
