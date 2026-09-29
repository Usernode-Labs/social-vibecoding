// #2598: the server half of the live weekly meter.
//
// "$x left this week" used to move only when a turn ENDED, because the only
// thing that moved it was a refetch the client ran at turn end. The fix is a
// `budget_updated` event pushed to the spender's own sockets every time a
// model call's cost is recorded against their weekly pool.
//
// What is pinned here is everything that would silently turn the figure back
// into a turn-end one:
//   1. The payload: the snapshot both meters read, over the per-user socket.
//   2. The mid-turn overlay: a running total the ledger has not caught up
//      with yet is published — but only when it is AHEAD of the ledger, so
//      the meter can never walk backwards.
//   3. Coalescing: a build's burst of calls repaints once per window, and
//      the trailing push carries the newest figure, not the first one.
//   4. Tolerance: a failed read or a failed push is swallowed. Billing
//      bookkeeping must never fail the turn that paid for it, and a meter is
//      the least important thing in the request.
//   5. The wiring: the three recording sites actually call it.
//
// Run with: node --test tests/budget-live-push.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budgetLive = require('../src/services/budget-live');
const limits = require('../src/services/limits');

const root = path.join(__dirname, '..');
const POOL = { query: async () => ({ rows: [] }) };

// A week-to-date snapshot in the shape limits.getBudgetSnapshot answers with
// — the same object GET /api/me/ai-budget returns and GET /api/budget wraps.
const snapshot = (over = {}) => ({
  limitCents: 5000,
  spentCents: 1200,
  remainingCents: 3800,
  weeklySpentCents: 1200,
  weeklyLimitCents: 5000,
  weeklyApplies: true,
  byokCents: 0,
  hasByokKey: false,
  capWindow: 'weekly',
  windowLabel: 'This week',
  resetLabel: 'Monday 00:00 UTC',
  ...over,
});

/** Swap both collaborators for recorders, and put them back afterwards. */
function harness({ read = () => snapshot(), push = null } = {}) {
  const pushes = [];
  const reads = [];
  const original = { readSnapshot: budgetLive._deps.readSnapshot, push: budgetLive._deps.push };
  budgetLive._reset();
  budgetLive._deps.readSnapshot = async (pool, userId) => {
    reads.push({ pool, userId });
    return read(userId);
  };
  budgetLive._deps.push = (userId, payload) => {
    if (push) return push(userId, payload);
    pushes.push({ userId, payload });
    return 1;
  };
  return {
    pushes,
    reads,
    restore() {
      budgetLive._reset();
      budgetLive._deps.readSnapshot = original.readSnapshot;
      budgetLive._deps.push = original.push;
    },
  };
}

test('a settled push carries the snapshot both meters read, to that user alone', async () => {
  const h = harness();
  try {
    const payload = await budgetLive.publish(POOL, 7);
    assert.equal(h.pushes.length, 1);
    assert.equal(h.pushes[0].userId, 7);
    assert.equal(h.pushes[0].payload.type, 'budget_updated');
    const budget = h.pushes[0].payload.budget;
    // The figures "$12.00/$50.00 · $38.00 left" is rendered from, unaltered.
    assert.equal(budget.spentCents, 1200);
    assert.equal(budget.limitCents, 5000);
    assert.equal(budget.remainingCents, 3800);
    assert.equal(budget.capWindow, 'weekly');
    assert.equal(budget.live, false, 'a ledger figure is not a running one');
    assert.deepEqual(payload, budget);
  } finally { h.restore(); }
});

test('a mid-turn figure ahead of the ledger is published, and moves all three numbers', async () => {
  const h = harness();
  try {
    await budgetLive.publish(POOL, 7, { liveWeeklySpentCents: 1850 });
    const budget = h.pushes[0].payload.budget;
    assert.equal(budget.spentCents, 1850);
    assert.equal(budget.weeklySpentCents, 1850, 'both spellings of the week move together');
    assert.equal(budget.remainingCents, 3150, 'the remainder is recomputed, not left stale');
    assert.equal(budget.live, true);
  } finally { h.restore(); }
});

test('a stale running total never walks the meter backwards', async () => {
  const h = harness();
  try {
    // The proxy's tracker resets its delta on each checkpoint refresh, so a
    // stale one reads BEHIND the settled sum. The ledger wins.
    await budgetLive.publish(POOL, 7, { liveWeeklySpentCents: 900 });
    let budget = h.pushes[0].payload.budget;
    assert.equal(budget.spentCents, 1200);
    assert.equal(budget.remainingCents, 3800);
    assert.equal(budget.live, false);
    // …and neither does a nonsense one.
    for (const value of [NaN, null, undefined, 'lots', -5]) {
      await budgetLive.publish(POOL, 7, { liveWeeklySpentCents: value });
    }
    budget = h.pushes[h.pushes.length - 1].payload.budget;
    assert.equal(budget.spentCents, 1200);
    assert.equal(budget.live, false);
  } finally { h.restore(); }
});

test('an account with no weekly cap is published without dividing by its zero', async () => {
  const h = harness({ read: () => snapshot({ limitCents: 0, remainingCents: 0, weeklyApplies: false, capWindow: 'none' }) });
  try {
    await budgetLive.publish(POOL, 7, { liveWeeklySpentCents: 9999 });
    const budget = h.pushes[0].payload.budget;
    assert.equal(budget.remainingCents, 0, 'no cap means no headroom, never a negative one');
    assert.equal(budget.spentCents, 9999);
  } finally { h.restore(); }
});

test('a burst repaints once per window, and the trailing push carries the newest figure', async () => {
  const h = harness();
  try {
    // The leading edge fires immediately: the meter has to move on the first
    // call of a build, not a window later.
    const first = budgetLive.notifySpend(POOL, 7, { liveWeeklySpentCents: 1300 });
    assert.ok(first, 'the first call of a quiet window sends straight away');
    await first;
    assert.equal(h.pushes.length, 1);
    assert.equal(h.pushes[0].payload.budget.spentCents, 1300);

    // Everything inside the window collapses into ONE trailing push.
    assert.equal(budgetLive.notifySpend(POOL, 7, { liveWeeklySpentCents: 1400 }), null);
    assert.equal(budgetLive.notifySpend(POOL, 7, { liveWeeklySpentCents: 1900 }), null);
    assert.equal(budgetLive.notifySpend(POOL, 7, { liveWeeklySpentCents: 1700 }), null);
    assert.equal(h.pushes.length, 1, 'three more calls, no three more events');

    await new Promise((resolve) => setTimeout(resolve, budgetLive.COALESCE_WINDOW_MS + 100));
    assert.equal(h.pushes.length, 2, 'exactly one trailing push');
    assert.equal(h.pushes[1].payload.budget.spentCents, 1900,
      'a turn total only grows, so the largest offered figure is the newest');
    assert.equal(h.reads.length, 2, 'one snapshot read per push, not one per call');
  } finally { h.restore(); }
});

test('windows are per user: one spender cannot swallow another\'s update', async () => {
  const h = harness();
  try {
    await budgetLive.notifySpend(POOL, 7);
    await budgetLive.notifySpend(POOL, 8);
    assert.deepEqual(h.pushes.map((p) => p.userId), [7, 8]);
  } finally { h.restore(); }
});

test('a spender is forgotten once their window lapses', async () => {
  const h = harness();
  try {
    await budgetLive.notifySpend(POOL, 7);
    assert.ok(budgetLive._pending.has(7));
    await new Promise((resolve) => setTimeout(resolve, budgetLive.COALESCE_WINDOW_MS + 100));
    assert.equal(budgetLive._pending.has(7), false,
      'the tracker is bounded to spenders inside the last window');
  } finally { h.restore(); }
});

test('a failed read pushes nothing; a failed push is swallowed', async () => {
  const bad = harness({ read: () => { throw new Error('connection refused'); } });
  try {
    assert.equal(await budgetLive.publish(POOL, 7), null);
    assert.equal(bad.pushes.length, 0);
  } finally { bad.restore(); }

  const unsendable = harness({ push: () => { throw new Error('socket closed'); } });
  try {
    const payload = await budgetLive.publish(POOL, 7);
    assert.ok(payload, 'the caller still gets its answer when delivery fails');
  } finally { unsendable.restore(); }
});

test('a missing user or pool is a no-op, not a throw', async () => {
  const h = harness();
  try {
    assert.equal(await budgetLive.publish(POOL, null), null);
    assert.equal(await budgetLive.publish(POOL, 0), null);
    assert.equal(await budgetLive.publish(null, 7), null);
    assert.equal(budgetLive.notifySpend(POOL, undefined), null);
    assert.equal(h.pushes.length, 0);
    assert.equal(h.reads.length, 0);
  } finally { h.restore(); }
});

// ── The three recording sites ────────────────────────────────────────────

/** Stand in for notifySpend on the module object limits.js holds. */
function captureNotify() {
  const calls = [];
  const original = budgetLive.notifySpend;
  budgetLive.notifySpend = (pool, userId, opts) => { calls.push({ userId, opts }); return null; };
  return { calls, restore() { budgetLive.notifySpend = original; } };
}

test('recordSpend notifies after the ledger moves — and only then', async () => {
  const cap = captureNotify();
  try {
    // This is the OpenRouter venue's recording point too: routes/sessions.js
    // sharedPoolCodexSpend debits the included key through recordSpend.
    await limits.recordSpend({ query: async () => ({ rows: [] }) }, 11, 4.2);
    assert.deepEqual(cap.calls.map((c) => c.userId), [11]);

    await limits.recordSpend({ query: async () => { throw new Error('nope'); } }, 11, 4.2);
    assert.equal(cap.calls.length, 1, 'a write that failed has nothing to announce');

    await limits.recordSpend({ query: async () => ({ rows: [] }) }, 11, 0);
    assert.equal(cap.calls.length, 1, 'a zero-cost no-op writes nothing and says nothing');
  } finally { cap.restore(); }
});

test('a durable Claude turn\'s settlement notifies once its receipt commits', async () => {
  const cap = captureNotify();
  const turnEffects = require('../src/services/turn-effects');
  const originalEffect = turnEffects.runDbEffect;
  turnEffects.runDbEffect = async ({ run }) => ({ value: await run({ query: async () => ({ rows: [] }) }) });
  try {
    await limits.settleTurnSpend(POOL, 12, 300, { turnId: 'turn-1', sessionId: 5 });
    assert.deepEqual(cap.calls.map((c) => c.userId), [12],
      'the durable path writes inside a transaction, so recordSpend never sees it');
  } finally {
    turnEffects.runDbEffect = originalEffect;
    cap.restore();
  }
});

test('the Anthropic proxy pushes per model call, from the same running total it bills on', () => {
  // Booting the proxy means a real Anthropic call, so its one line is pinned
  // by reading it: what matters is WHERE it sits (inside the settled-cost
  // fold, after the weekly tracker has taken this call) and that it hands
  // over the tracker's total rather than re-reading a ledger that has not
  // been written yet.
  const src = fs.readFileSync(path.join(root, 'src/routes/anthropic-proxy.js'), 'utf8');
  assert.match(src, /require\('\.\.\/services\/budget-live'\)/);
  const fold = src.slice(src.indexOf('if (result.costCents > 0) {'));
  assert.ok(fold.indexOf('budgetLive.notifySpend') > -1
    && fold.indexOf('budgetLive.notifySpend') < fold.indexOf('noteAgentSpend'),
    'the push belongs in the block that folds a returned call\'s cost in');
  assert.match(fold, /liveWeeklySpentCents:[\s\S]*?totalAtCheckpointCents \+ liveWeekly\.liveDeltaCents/);
  // Sync turns bill the system bucket, which is nobody's weekly meter.
  const syncGuarded = fold.slice(fold.indexOf('if (!isSyncTurn) {'), fold.indexOf('noteAgentSpend'));
  assert.ok(syncGuarded.includes('budgetLive.notifySpend'),
    'the push must sit inside the !isSyncTurn branch');
});
