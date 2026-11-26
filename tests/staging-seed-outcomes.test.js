'use strict';

// #7172: every staging seed reports what it did, so a screenshot run can say
// which demo data never loaded and why. A seed that wrote rows is `wrote`; a
// silent one is `nothing`; `seedSkipped('no …')` is `skipped`; a statement
// that threw, even if the seed caught it, is `failed`. The boot keeps the
// non-wrote outcomes in platform_settings for the shots runner to read.
//
// Run with: node --test tests/staging-seed-outcomes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSeedWithOutcome, seedSkipped } = require('../src/db/staging-seed-outcome');
const { seedStagingEmojiThreadRequest, writeStagingSeedReport } = require('../src/db/migrate');

function fakePool(handler) {
  const query = async (sql, params) => handler(String(sql), params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const seed = (name, run) => ({ name, run });

test('a seed that changed rows is wrote', async () => {
  const outcome = await runSeedWithOutcome(
    seed('insertsOne', (pool) => pool.query("INSERT INTO demo_rows (name) VALUES ('x')")),
    fakePool(async () => ({ rowCount: 1, rows: [] })), {},
  );
  assert.deepEqual(outcome, { name: 'insertsOne', outcome: 'wrote', reason: null });
});

test('a seed that changed no rows and gave no reason is nothing', async () => {
  const outcome = await runSeedWithOutcome(
    seed('selectsOnly', (pool) => pool.query('SELECT 1 FROM demo_rows')),
    fakePool(async () => ({ rowCount: null, rows: [] })), {},
  );
  assert.equal(outcome.outcome, 'nothing');
  assert.equal(outcome.reason, 'changed no rows');
});

test('seedSkipped records the precondition it lacked', async () => {
  const outcome = await runSeedWithOutcome(
    seed('needsAProject', () => seedSkipped('no project staging-demo-pin-1')),
    fakePool(async () => ({ rowCount: null, rows: [] })), {},
  );
  assert.deepEqual(outcome, {
    name: 'needsAProject', outcome: 'skipped', reason: 'no project staging-demo-pin-1',
  });
});

test('a statement that threw, even caught, is failed with its error', async () => {
  const outcome = await runSeedWithOutcome(
    seed('swallows', async (pool) => {
      await pool.query('INSERT INTO absent_table VALUES (1)').catch(() => {});
    }),
    fakePool(async () => { throw new Error('relation "absent_table" does not exist'); }), {},
  );
  assert.equal(outcome.outcome, 'failed');
  assert.match(outcome.reason, /absent_table/);
});

test('#7170\'s seed without its project reports skipped: no project staging-demo-pin-1', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    const outcome = await runSeedWithOutcome(
      seed('seedStagingEmojiThreadRequest', (pool) => seedStagingEmojiThreadRequest(pool)),
      fakePool(async (sql) => {
        assert.match(sql, /FROM apps WHERE slug = 'staging-demo-pin-1'/);
        return { rows: [] };
      }), {},
    );
    assert.deepEqual(outcome, {
      name: 'seedStagingEmojiThreadRequest',
      outcome: 'skipped',
      reason: 'no project staging-demo-pin-1',
    });
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('#7170\'s seed writes its request when the project and fixture user exist', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    let inserted = null;
    const outcome = await runSeedWithOutcome(
      seed('seedStagingEmojiThreadRequest', (pool) => seedStagingEmojiThreadRequest(pool)),
      fakePool(async (sql, params) => {
        if (/FROM apps WHERE slug/.test(sql)) return { rows: [{ id: 3 }] };
        if (/FROM users WHERE username = 'usernode-capture'/.test(sql)) return { rows: [{ id: 9 }] };
        inserted = params;
        return { rowCount: 1, rows: [] };
      }), {},
    );
    assert.deepEqual(outcome, { name: 'seedStagingEmojiThreadRequest', outcome: 'wrote', reason: null });
    assert.deepEqual(inserted, [3, 9170, 9]);
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('the boot report keeps only the seeds that wrote nothing', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const writes = [];
  try {
    await writeStagingSeedReport({ query: async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; } }, [
      { name: 'wroteOne', outcome: 'wrote', reason: null },
      { name: 'skippedOne', outcome: 'skipped', reason: 'no project x' },
      { name: 'failedOne', outcome: 'failed', reason: 'boom' },
    ]);
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO platform_settings/);
  assert.equal(writes[0].params[0], 'staging_seed_report');
  assert.deepEqual(JSON.parse(writes[0].params[1]), {
    version: 1,
    outcomes: [
      { name: 'skippedOne', outcome: 'skipped', reason: 'no project x' },
      { name: 'failedOne', outcome: 'failed', reason: 'boom' },
    ],
  });
});

test('the report is written on staging only', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  let asked = false;
  try {
    await writeStagingSeedReport({ query: async () => { asked = true; return { rows: [] }; } }, [
      { name: 'skippedOne', outcome: 'skipped', reason: 'no project x' },
    ]);
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
  assert.equal(asked, false);
});
