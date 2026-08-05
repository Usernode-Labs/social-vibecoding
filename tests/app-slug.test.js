'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_SLUG_CONSTRAINT,
  AppSlugAllocationError,
  appSlugBase,
  generateAppSlug,
  insertWithUniqueAppSlug,
} = require('../src/services/app-slug');

function bytes(...hexValues) {
  let i = 0;
  return () => Buffer.from(hexValues[i++], 'hex');
}

function slugCollision() {
  const err = new Error('duplicate key value violates unique constraint');
  err.code = '23505';
  err.constraint = APP_SLUG_CONSTRAINT;
  return err;
}

test('normalization and the six-hex suffix stay byte-compatible', () => {
  assert.equal(appSlugBase('  My COOL__App!  '), 'my-cool-app');
  assert.equal(appSlugBase('应用'), '', 'Unicode-only names retain the current invalid-name behavior');
  assert.equal(appSlugBase('Café Board'), 'caf-board',
    'mixed input retains the current ASCII-only technical normalization');
  assert.equal(
    generateAppSlug('my-cool-app', bytes('00a1ff')),
    'my-cool-app-00a1ff'
  );
});

test('first-attempt success returns the inserted value and attempt count', async () => {
  const seen = [];
  const result = await insertWithUniqueAppSlug('demo', async (slug) => {
    seen.push(slug);
    return { id: 7 };
  }, { randomBytes: bytes('010203') });

  assert.deepEqual(result, {
    slug: 'demo-010203',
    value: { id: 7 },
    attempts: 1,
  });
  assert.deepEqual(seen, ['demo-010203']);
});

test('exact apps.slug collisions retry until the database accepts one', async () => {
  const seen = [];
  const result = await insertWithUniqueAppSlug('demo', async (slug) => {
    seen.push(slug);
    if (seen.length < 3) throw slugCollision();
    return { accepted: slug };
  }, { randomBytes: bytes('000001', '000002', '000003') });

  assert.equal(result.slug, 'demo-000003');
  assert.equal(result.attempts, 3);
  assert.deepEqual(seen, ['demo-000001', 'demo-000002', 'demo-000003']);
});

test('two concurrent allocators let the unique constraint choose a winner', async () => {
  const reserved = new Set();
  async function insert(slug) {
    if (reserved.has(slug)) throw slugCollision();
    reserved.add(slug);
    return slug;
  }

  const [first, second] = await Promise.all([
    insertWithUniqueAppSlug('race', insert, { randomBytes: bytes('000001') }),
    insertWithUniqueAppSlug('race', insert, { randomBytes: bytes('000001', '000002') }),
  ]);

  assert.deepEqual(new Set([first.slug, second.slug]), new Set(['race-000001', 'race-000002']));
  assert.deepEqual([first.attempts, second.attempts].sort(), [1, 2]);
});

test('bounded exhaustion becomes a typed transient allocation error', async () => {
  await assert.rejects(
    insertWithUniqueAppSlug('demo', async () => { throw slugCollision(); }, {
      maxAttempts: 3,
      randomBytes: bytes('000001', '000002', '000003'),
    }),
    (err) => {
      assert.ok(err instanceof AppSlugAllocationError);
      assert.equal(err.code, 'APP_SLUG_UNAVAILABLE');
      assert.equal(err.attempts, 3);
      assert.equal(err.cause.constraint, APP_SLUG_CONSTRAINT);
      return true;
    }
  );
});

test('unrelated unique violations and ordinary failures are never retried', async () => {
  for (const err of [
    Object.assign(new Error('username conflict'), {
      code: '23505',
      constraint: 'users_username_key',
    }),
    new Error('database unavailable'),
  ]) {
    let calls = 0;
    await assert.rejects(
      insertWithUniqueAppSlug('demo', async () => {
        calls++;
        throw err;
      }, { randomBytes: bytes('000001') }),
      (seen) => seen === err
    );
    assert.equal(calls, 1);
  }
});

test('invalid helper arguments fail before allocation', async () => {
  await assert.rejects(insertWithUniqueAppSlug('', async () => {}), /base is required/);
  await assert.rejects(insertWithUniqueAppSlug('demo', null), /insert must be a function/);
  await assert.rejects(
    insertWithUniqueAppSlug('demo', async () => {}, { maxAttempts: 0 }),
    /positive integer/
  );
});
