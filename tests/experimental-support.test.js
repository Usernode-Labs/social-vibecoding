'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { completePreviewConfig, createCompletePreviewWork } = require('./lib/complete-preview-work');
const { assertSupportedExperimentalStore } = require('../src/services/preview-flow/experimental-support');
const { openArchive } = require('../archives/experimental-replay-c01dc0687/replay.cjs');

const archiveDirectory = path.resolve(__dirname, '../archives/experimental-replay-c01dc0687');
const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL;

test('historical archive replays outside the checkout with no installed dependencies', t => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-replay-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  fs.cpSync(archiveDirectory, isolated, { recursive: true });
  const result = spawnSync(process.execPath, ['replay.cjs', '--verify'], {
    cwd: isolated,
    env: {},
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(result.stdout);
  assert.deepEqual(verified.totals, { 'original-golden': 9, 'synthetic-version-witness': 5, 'exported-test-trace': 139 });
  assert.equal(verified.cases, 153);

  fs.appendFileSync(path.join(isolated, 'sources.json.gz'), 'changed');
  assert.throws(() => openArchive(isolated), /checksum mismatch/);
});

for (const machine of ['preview-flow', 'cli-preview-handoff', 'proposal-review']) {
  test(`${machine}: historical versions are offline only`, () => {
    const live = require(`../src/services/${machine}/reducer`);
    const archive = openArchive();
    for (const version of archive.manifest.historicalVersions[machine]) {
      assert.throws(() => live.replayDecision({ reducer_version: version }), /Unsupported/);
    }
  });
}

for (const historicalKind of ['native-preview-prepare', 'native-preview-template-prepare', 'native-preview-kpack-prepare', 'trace']) {
  test(`real PostgreSQL: unsupported ${historicalKind} blocks startup and preserves retained obligations`, { skip: !databaseUrl }, async t => {
    const db = await createExecutionDatabase(databaseUrl);
    t.after(() => db.close());
    await assertSupportedExperimentalStore(db.pool);
    await db.pool.query("INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)", ['a'.repeat(40)]);
    const work = createCompletePreviewWork(db.pool, completePreviewConfig({ databaseUrl: db.url }));
    const admitted = await work.request({ type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId: 1,
      headSha: 'a'.repeat(40), startedStatus: 'active' });
    if (historicalKind === 'trace') await db.pool.query('UPDATE preview_flow_decisions SET reducer_version = 9');
    else await db.pool.query('UPDATE execution_work_requests SET workflow = $1', [historicalKind]);
    const before = await db.pool.query('SELECT * FROM preview_flow_resources');
    let initialized = false;
    t.mock.method(require('../src/services/github'), 'init', async () => { initialized = true; });
    await assert.rejects(require('../scripts/preview-preparation-worker').runWorker({
      pool: db.pool,
      config: completePreviewConfig({ databaseUrl: db.url }),
    }), /Unsupported experimental store/);
    assert.equal(initialized, false, 'Unsupported stores stop before adapters or execution initialize');
    assert.deepEqual((await db.pool.query('SELECT * FROM preview_flow_resources')).rows, before.rows);
    assert.equal((await work.store.read(admitted.work.id)).status, 'queued');
  });
}

test('offline replay is excluded from shipped images and live source imports', () => {
  const dockerIgnore = fs.readFileSync(path.resolve(__dirname, '../.dockerignore'), 'utf8');
  assert.ok(dockerIgnore.split('\n').includes('archives/experimental-replay-c01dc0687'));
  for (const machine of ['preview-flow', 'cli-preview-handoff', 'proposal-review']) {
    const reducer = fs.readFileSync(path.resolve(__dirname, `../src/services/${machine}/reducer.js`), 'utf8');
    assert.doesNotMatch(reducer, /require\([^)]*(?:versions|archives)/);
  }
});
