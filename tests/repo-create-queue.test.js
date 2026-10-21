// New repositories one at a time, and a wait instead of a failure when
// GitHub's secondary limit refuses one (src/services/repo-create-queue.js).
// The setup that uses it is tests/app-creator-failure.test.js's.
//
// Run with: node --test tests/repo-create-queue.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../src/services/repo-create-queue');
const githubBudget = require('../src/services/github-budget');

const slowDown = (headers = {}) => Object.assign(
  new Error('You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later.'),
  { status: 403, response: { status: 403, headers } });

// A pool whose clients record what they are asked, in order, with which
// client asked it.
function recordingPool() {
  const events = [];
  let clients = 0;
  return {
    events,
    async connect() {
      const id = ++clients;
      return {
        async query(sql, params) { events.push({ client: id, sql: String(sql), params }); return { rows: [] }; },
        release(err) { events.push({ client: id, released: true, broken: !!err }); },
      };
    },
  };
}

test.afterEach(() => queue._forTest.resetTiming());

test('one at a time: each task runs alone, under the advisory lock on its own client, and the gap follows it', async () => {
  queue._forTest.setTiming({ gapMs: 20 });
  const pool = recordingPool();
  const spans = [];
  const task = (name) => async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    spans.push({ name, start, end: Date.now() });
    return name;
  };
  const results = await Promise.all([queue.inLine(pool, task('a')), queue.inLine(pool, task('b')), queue.inLine(pool, task('c'))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i].start >= spans[i - 1].end + 15, `${spans[i].name} waited for ${spans[i - 1].name} and the gap`);
  }
  const first = pool.events.filter((e) => e.client === 1);
  assert.deepEqual(first.map((e) => e.sql || 'release'), [
    'BEGIN', 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', 'ROLLBACK', 'release']);
  assert.deepEqual(first[1].params, [queue._forTest.LOCK_KEY]);
  assert.equal(new Set(pool.events.map((e) => e.client)).size, 3, 'a client per turn, returned after it');
});

test('a task that fails gives up its turn: the line goes on, and the lock is released', async () => {
  queue._forTest.setTiming({ gapMs: 0 });
  const pool = recordingPool();
  const failed = queue.inLine(pool, async () => { throw new Error('boom'); });
  const after = queue.inLine(pool, async () => 'next');
  await assert.rejects(failed, /boom/);
  assert.equal(await after, 'next');
  assert.equal(pool.events.filter((e) => e.sql === 'ROLLBACK').length, 2);
});

test('withRetries: a secondary-limit refusal waits and tries again, doubling its wait', async (t) => {
  queue._forTest.setTiming({ gapMs: 0, firstWaitMs: 10, maxWaitMs: 25, budgetMs: 1000 });
  const pool = recordingPool();
  const times = [];
  const out = await queue.withRetries(pool, async () => {
    times.push(Date.now());
    if (times.length <= 3) throw slowDown();
    return 'made';
  });
  assert.equal(out, 'made');
  assert.equal(times.length, 4);
  const gaps = times.slice(1).map((at, i) => at - times[i]);
  assert.ok(gaps[0] >= 8 && gaps[1] >= 18 && gaps[2] >= 23, `waits of 10, 20, then 25 (capped): ${gaps}`);
});

test('withRetries: GitHub\'s Retry-After is the wait, and one longer than what is left is not waited', async () => {
  queue._forTest.setTiming({ gapMs: 0, firstWaitMs: 5, maxWaitMs: 5, budgetMs: 200 });
  assert.equal(githubBudget.secondaryRetryAfterMs(slowDown({ 'retry-after': '2' })), 2000);
  assert.equal(githubBudget.secondaryRetryAfterMs(slowDown()), null, 'nothing said');
  assert.equal(githubBudget.secondaryRetryAfterMs(new Error('Not Found')), null, 'not a secondary limit');
  let tries = 0;
  const started = Date.now();
  await assert.rejects(queue.withRetries(recordingPool(), async () => { tries += 1; throw slowDown({ 'retry-after': '60' }); }),
    /secondary rate limit/);
  assert.equal(tries, 1);
  assert.ok(Date.now() - started < 150, 'no wait it could not finish');
});

test('withRetries: the waits stop at their budget, with GitHub\'s refusal', async () => {
  queue._forTest.setTiming({ gapMs: 0, firstWaitMs: 10, maxWaitMs: 10, budgetMs: 35 });
  let tries = 0;
  await assert.rejects(queue.withRetries(recordingPool(), async () => { tries += 1; throw slowDown(); }), (err) => {
    assert.equal(githubBudget.isSecondaryRateLimitError(err), true);
    return true;
  });
  assert.equal(tries, 4, 'three waits of 10 fit in 35, a fourth would not');
});

test('withRetries: any other failure is the setup\'s at once', async () => {
  queue._forTest.setTiming({ gapMs: 0, firstWaitMs: 10 });
  let tries = 0;
  await assert.rejects(queue.withRetries(recordingPool(), async () => {
    tries += 1;
    throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
  }), /API rate limit exceeded/);
  assert.equal(tries, 1);
});

test('withRetries: a setup cancelled while it waits stops waiting, and one cancelled in line never starts', async () => {
  queue._forTest.setTiming({ gapMs: 0, firstWaitMs: 60 * 1000, budgetMs: 10 * 60 * 1000 });
  const controller = new AbortController();
  let tries = 0;
  const waiting = queue.withRetries(recordingPool(), async () => { tries += 1; throw slowDown(); }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('timed out')), 20);
  const started = Date.now();
  await assert.rejects(waiting, /timed out/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(tries, 1);

  const pool = recordingPool();
  let release;
  const holding = queue.inLine(pool, () => new Promise((r) => { release = r; }));
  const cancelled = new AbortController();
  let ran = false;
  const queued = queue.withRetries(pool, async () => { ran = true; }, { signal: cancelled.signal });
  cancelled.abort(new Error('cancelled'));
  await new Promise((r) => setTimeout(r, 5));
  release('done');
  await holding;
  await assert.rejects(queued, /cancelled/);
  assert.equal(ran, false);
});
