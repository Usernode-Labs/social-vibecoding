// Tests for src/services/session-lifecycle.js: the proposal lifecycle moves
// by the names their callers have always used.
//
// Every status move is the proposal machine's now (src/workflow/proposal/):
// what a pause, an unpromote, a close or a reopen does around the move (the
// worker destroyed, the pull request closed or reopened, the preview
// retired, the thread line, the bell) is its transaction or its durable
// work, and tests/workflow-proposal-postgres.test.js pins all of it. What is
// left here is thin: each name reads the status where it says it does,
// passes it as `from`, appends the machine's event through
// src/workflow/platform.ts and maps the outcome onto the shape its callers
// have always read. The slot eviction keeps its own victim SQL and asks the
// machine for each victim in order (pauseFirst). This suite stubs
// platform.ts and pins exactly that.
//
// Run with: node --test tests/session-lifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// Matches each query() against a list of [regex, rows] handlers (first
// match wins) and records every call so tests can assert on the SQL.
function makePool(handlers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    // Returns true if any issued query matched `re`.
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// ── Collaborator stubs ────────────────────────────────────────────────────
// Install before requiring the subject; returns { subject, spies, restore }.
// `answers` decides what each platform.ts function answers: a function of
// the call's payload, an outcome, or (default) accepted.
function loadWithStubs(answers = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    worker: require.resolve('../src/services/worker'),
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/services/session-lifecycle'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { calls: [], destroyCcVolume: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.worker, {
    destroyCcVolume: async (sessionId) => { spies.destroyCcVolume.push(sessionId); },
  });
  const fn = (name) => async (payload) => {
    spies.calls.push({ name, payload });
    const a = answers[name];
    if (typeof a === 'function') return a(payload);
    return a === undefined ? ACCEPTED() : a;
  };
  stub(ids.platform, Object.fromEntries(
    ['pauseProposal', 'unpromoteProposal', 'resumeProposal', 'closeProposal', 'reopenProposal']
      .map((name) => [name, fn(name)]),
  ));

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  const called = (name) => spies.calls.filter((c) => c.name === name).map((c) => c.payload);
  return { subject, spies, called, restore };
}

const ACCEPTED = (reply = null) => ({
  status: 'accepted', eventId: 1, requestKey: 'k', reason: null, state: 'underway', version: 2, reply,
});
const REJECTED = (reason) => ({ status: 'rejected', reason });
// Not decided in time: the machine (in its own process) did not answer
// within the wait, or reached the move past its deadline.
const PENDING = () => ({ status: 'pending', requestKey: 'k', reason: null });
const SLUG = [/SELECT a\.slug FROM chat_sessions/, [{ slug: 'widget' }]];

// ── pauseSession ──────────────────────────────────────────────────────────

test('pauseSession: appends the pause with what its caller read, and answers with the app', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const pool = makePool([SLUG]);
    const res = await subject.pauseSession({ pool, sessionId: '7', userId: 3, reason: 'manual', from: 'active' });
    assert.deepEqual(res, { paused: true, appSlug: 'widget' });
    assert.deepEqual(called('pauseProposal'), [{ sessionId: 7, reason: 'manual', from: 'active', userId: 3 }]);
  } finally { restore(); }
});

test('pauseSession: a replayed pause is a pause; a refusal says why and touches nothing', async () => {
  const replay = loadWithStubs({ pauseProposal: { ...ACCEPTED(), status: 'replayed' } });
  try {
    assert.equal((await replay.subject.pauseSession({ pool: makePool([SLUG]), sessionId: 7, from: 'active' })).paused, true);
  } finally { replay.restore(); }
  // The machine refuses a promoted row (its PR stays up for the vote) and,
  // for the platform's own reasons, a session somebody works on.
  const { subject, restore } = loadWithStubs({ pauseProposal: REJECTED('worked_on') });
  try {
    const pool = makePool([SLUG]);
    const res = await subject.pauseSession({ pool, sessionId: 7, reason: 'lru', from: 'active' });
    assert.deepEqual(res, { paused: false, reason: 'worked_on' });
    assert.equal(pool.calls.length, 0, 'a refused pause reads nothing and writes nothing');
  } finally { restore(); }
});

test('pauseSession: a pause the machine did not decide in time says so, never as a refusal', async () => {
  for (const out of [PENDING(), REJECTED('expired')]) {
    const { subject, restore } = loadWithStubs({ pauseProposal: out });
    try {
      assert.deepEqual(await subject.pauseSession({ pool: makePool([SLUG]), sessionId: 7, from: 'active' }),
        { paused: false, reason: 'not_decided' }, out.status);
    } finally { restore(); }
  }
});

// ── unpromoteSession ──────────────────────────────────────────────────────

function unpromoteWith(row, answers) {
  const loaded = loadWithStubs(answers);
  const pool = makePool([
    [/SELECT status, user_id, app_id FROM chat_sessions/, row ? [row] : []],
    SLUG,
  ]);
  return { ...loaded, pool, run: (o = {}) => loaded.subject.unpromoteSession({ pool, sessionId: 9, userId: 3, actorUsername: 'ada', ...o }) };
}

test('unpromoteSession: reads the visible row and answers without the machine when it decides nothing', async () => {
  const cases = [
    [null, 3, { ok: false, code: 'not_found' }],
    // Somebody else's: public in review, indistinguishable from missing while Underway.
    [{ status: 'promoted', user_id: 4, app_id: 2 }, 3, { ok: false, code: 'forbidden' }],
    [{ status: 'merging', user_id: 4, app_id: 2 }, 3, { ok: false, code: 'forbidden' }],
    [{ status: 'active', user_id: 4, app_id: 2 }, 3, { ok: false, code: 'not_found' }],
    [{ status: 'active', user_id: 3, app_id: 2 }, 3, { ok: true, already: true, status: 'active' }],
    [{ status: 'paused', user_id: 3, app_id: 2 }, 3, { ok: true, already: true, status: 'paused' }],
    [{ status: 'merging', user_id: 3, app_id: 2 }, 3, { ok: false, code: 'merging' }],
    [{ status: 'merged', user_id: 3, app_id: 2 }, 3, { ok: false, code: 'merging' }],
    [{ status: 'archived', user_id: 3, app_id: 2 }, 3, { ok: false, code: 'closed' }],
  ];
  for (const [row, userId, want] of cases) {
    const { run, called, pool, restore } = unpromoteWith(row);
    try {
      assert.deepEqual(await run({ userId }), want, JSON.stringify(row));
      assert.deepEqual(called('unpromoteProposal'), [], 'nothing appended');
      assert.match(pool.calls[0].sql, /is_headless = FALSE/, 'a headless run is never unpromoted');
    } finally { restore(); }
  }
});

test('unpromoteSession: a promoted proposal is moved back by the machine, from what was read', async () => {
  const { run, called, restore } = unpromoteWith({ status: 'promoted', user_id: 3, app_id: 2 },
    { unpromoteProposal: ACCEPTED({ status: 'active' }) });
  try {
    assert.deepEqual(await run(), { ok: true, status: 'active', appSlug: 'widget' });
    assert.deepEqual(called('unpromoteProposal'), [{ sessionId: 9, appId: 2, userId: 3, username: 'ada', from: 'promoted' }]);
  } finally { restore(); }
  const bare = unpromoteWith({ status: 'promoted', user_id: 3, app_id: 2 }, { unpromoteProposal: ACCEPTED() });
  try {
    assert.equal((await bare.run()).status, 'paused', 'a reply without a status reads as the slot given back');
  } finally { bare.restore(); }
});

test('unpromoteSession: the machine\'s refusals map onto the codes the route answers', async () => {
  const cases = [
    ['already_underway', { ok: true, already: true, status: 'paused' }],
    ['busy', { ok: false, code: 'busy' }],
    ['pending_secret', { ok: false, code: 'pending_secret' }],
    ['closed', { ok: false, code: 'closed' }],
    ['merging', { ok: false, code: 'merging' }],
    // Anything else changed under us (a stale read): a conflict, not a guess.
    ['session_state_changed', { ok: false, code: 'merging' }],
    // Reached past its deadline: never applied, so not decided, not merging.
    ['expired', { ok: false, code: 'not_decided' }],
  ];
  for (const [reason, want] of cases) {
    const { run, restore } = unpromoteWith({ status: 'promoted', user_id: 3, app_id: 2 },
      { unpromoteProposal: REJECTED(reason) });
    try { assert.deepEqual(await run(), want, reason); } finally { restore(); }
  }
});

test('unpromoteSession: a move the machine has not decided yet is never reported as merging', async () => {
  const { run, restore } = unpromoteWith({ status: 'promoted', user_id: 3, app_id: 2 },
    { unpromoteProposal: PENDING() });
  try { assert.deepEqual(await run(), { ok: false, code: 'not_decided' }); } finally { restore(); }
});

// ── Slot eviction (freeGlobalSlot / freeUserSlot) ─────────────────────────
// The victims are read here; the machine decides each pause. Its guard
// skips a session somebody works on or a durable build holds (P8 in
// tests/workflow-proposal-postgres.test.js), so eviction asks the next.

function slotPool(candidates) {
  return makePool([[/SELECT id FROM chat_sessions/, candidates.map((id) => ({ id }))]]);
}

test('freeGlobalSlot: the platform-wide victims, least recently active first, never an imported row', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const pool = slotPool([7, 8]);
    assert.deepEqual(await subject.freeGlobalSlot({ pool, graceMs: 1000, excludeSessionId: 5 }), { freed: true, sessionId: 7 });
    const read = pool.calls[0];
    assert.equal(read.sql, subject.GLOBAL_VICTIMS_SQL);
    assert.deepEqual(read.params, [1000, 5]);
    assert.match(read.sql, /status = 'active'/);
    assert.match(read.sql, /source IS DISTINCT FROM 'imported'/,
      'worker capacity eviction ignores worker-less imported rows');
    assert.match(read.sql, /ORDER BY last_activity_at ASC/);
    assert.deepEqual(called('pauseProposal'), [{ sessionId: 7, reason: 'pressure', from: 'active' }]);
    // No exclusion is 0; a grace of zero or less disables it outright.
    const none = slotPool([7]);
    await subject.freeGlobalSlot({ pool: none, graceMs: 1000 });
    assert.deepEqual(none.calls[0].params, [1000, 0]);
    const off = slotPool([7]);
    assert.deepEqual(await subject.freeGlobalSlot({ pool: off, graceMs: 0 }), { freed: false });
    assert.equal(off.calls.length, 0);
  } finally { restore(); }
});

test('slot eviction: a victim the machine refuses (worked on, a durable build holds it) is passed over for the next', async () => {
  const { subject, called, restore } = loadWithStubs({
    pauseProposal: ({ sessionId }) => (sessionId === 7 ? REJECTED('worked_on') : ACCEPTED()),
  });
  try {
    assert.deepEqual(await subject.freeGlobalSlot({ pool: slotPool([7, 8, 9]), graceMs: 1000 }), { freed: true, sessionId: 8 });
    assert.deepEqual(called('pauseProposal').map((p) => p.sessionId), [7, 8], 'asked in order, and stops at the first pause');
    assert.deepEqual(await subject.freeGlobalSlot({ pool: slotPool([7]), graceMs: 1000 }), { freed: false });
  } finally { restore(); }
});

test('slot eviction: an append that throws is passed over, never fails the request', async () => {
  const { subject, restore } = loadWithStubs({
    pauseProposal: ({ sessionId }) => {
      if (sessionId === 7) throw new Error('connection reset');
      return ACCEPTED();
    },
  });
  try {
    assert.deepEqual(await subject.freeUserSlot({ pool: slotPool([7, 8]), userId: 3 }), { freed: true, sessionId: 8 });
  } finally { restore(); }
});

test('slot eviction: a pause the machine has not decided stops the search, and the gate says so', async () => {
  const { subject, called, restore } = loadWithStubs({
    pauseProposal: ({ sessionId }) => (sessionId === 7 ? REJECTED('worked_on') : PENDING()),
  });
  try {
    assert.deepEqual(await subject.freeGlobalSlot({ pool: slotPool([7, 8, 9]), graceMs: 1000 }), { freed: false, notDecided: true });
    assert.deepEqual(called('pauseProposal').map((p) => p.sessionId), [7, 8],
      'a refusal is passed over; an undecided pause is not waited out once per victim');
    assert.deepEqual(await subject.freeUserSlot({ pool: slotPool([8, 9]), userId: 3 }), { freed: false, notDecided: true });
    // The platform-wide gate: not a refusal at the cap, and none recorded.
    const pool = makePool([
      [/COUNT\(\*\)/, [{ cnt: '100' }]],
      [/SELECT id FROM chat_sessions/, [{ id: 8 }]],
    ]);
    assert.deepEqual(await subject.claimGlobalSlot({ pool, config: { maxGlobalSessions: 100, sessionPressureGraceMs: 1000 }, path: 'start' }),
      { ok: false, notDecided: true });
    assert.ok(!pool.issued(/INSERT INTO events/), 'no capacity refusal is recorded');
  } finally { restore(); }
});

test('answerNotDecided: a retryable 503 with its code and Retry-After', () => {
  const { subject, restore } = loadWithStubs();
  try {
    const sent = { headers: {} };
    const res = {
      set(k, v) { sent.headers[k] = v; return res; },
      status(n) { sent.status = n; return res; },
      json(b) { sent.body = b; return res; },
    };
    subject.answerNotDecided(res, 'Not yet.');
    assert.deepEqual(sent, { headers: { 'Retry-After': '5' }, status: 503, body: { error: 'Not yet.', code: 'not_decided' } });
    subject.answerNotDecided(res);
    assert.equal(sent.body.error, subject.NOT_DECIDED);
  } finally { restore(); }
});

test('freeUserSlot: the user\'s own victims, headless ones only when asked', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const pool = slotPool([4]);
    assert.deepEqual(await subject.freeUserSlot({ pool, userId: 3, excludeSessionId: 9 }), { freed: true, sessionId: 4 });
    assert.equal(pool.calls[0].sql, subject.USER_VICTIMS_SQL);
    assert.deepEqual(pool.calls[0].params, [3, 9, false]);
    assert.match(pool.calls[0].sql, /\(\$3::boolean OR is_headless = FALSE\)/);
    assert.match(pool.calls[0].sql, /source IS DISTINCT FROM 'imported'/);
    assert.deepEqual(called('pauseProposal'), [{ sessionId: 4, reason: 'lru', from: 'active' }]);
    const headless = slotPool([]);
    assert.deepEqual(await subject.freeUserSlot({ pool: headless, userId: 3, includeHeadless: true }), { freed: false });
    assert.deepEqual(headless.calls[0].params, [3, 0, true]);
  } finally { restore(); }
});

// ── archiveSession / unarchiveSession ─────────────────────────────────────

test('archiveSession: every close is the machine\'s, with what its caller passed', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const pool = makePool([SLUG]);
    const res = await subject.archiveSession({
      pool, sessionId: '7', userId: 3, reason: 'manual', purgeCc: true, from: 'promoted', username: 'ada', waitMs: 100,
    });
    assert.deepEqual(res, { archived: true, appSlug: 'widget' });
    assert.deepEqual(called('closeProposal'), [{
      sessionId: 7, reason: 'manual', from: 'promoted', userId: 3, username: 'ada', purgeCc: true, waitMs: 100,
    }]);
    // A system close names no owner and keeps the CC volume (reversible).
    await subject.archiveSession({ pool, sessionId: 8, reason: 'stale-pr', from: 'promoted' });
    assert.deepEqual(called('closeProposal')[1], {
      sessionId: 8, reason: 'stale-pr', from: 'promoted', userId: null, username: null, purgeCc: false, waitMs: undefined,
    });
  } finally { restore(); }
});

test('archiveSession: a refused close (not the owner, a newer move, past closing) archives nothing and says why', async () => {
  const { subject, restore } = loadWithStubs({ closeProposal: REJECTED('session_state_changed') });
  try {
    const pool = makePool([SLUG]);
    assert.deepEqual(await subject.archiveSession({ pool, sessionId: 7, userId: 4, from: 'promoted' }),
      { archived: false, reason: 'session_state_changed' });
    assert.equal(pool.calls.length, 0);
  } finally { restore(); }
  // A close recorded and not applied yet (a slow pipeline) closes once it
  // is: a close carries no deadline.
  const pending = loadWithStubs({ closeProposal: { status: 'pending', reason: null } });
  try {
    assert.deepEqual(await pending.subject.archiveSession({ pool: makePool(), sessionId: 7, from: 'active' }),
      { archived: true, pending: true });
  } finally { pending.restore(); }
});

function unarchivePool(row) {
  return makePool([[/SELECT status, user_id, app_id, cc_purged FROM chat_sessions/, row ? [row] : []]]);
}

test('unarchiveSession: only an archived row its owner (or the system) reopens reaches the machine', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    assert.deepEqual(await subject.unarchiveSession({ pool: unarchivePool(null), sessionId: 1, userId: 2 }), { unarchived: false });
    assert.deepEqual(await subject.unarchiveSession({
      pool: unarchivePool({ status: 'promoted', user_id: 2, app_id: 5, cc_purged: false }), sessionId: 1, userId: 2,
    }), { unarchived: false });
    assert.deepEqual(await subject.unarchiveSession({
      pool: unarchivePool({ status: 'archived', user_id: 3, app_id: 5, cc_purged: false }), sessionId: 1, userId: 2,
    }), { unarchived: false }, 'not the owner');
    assert.deepEqual(called('reopenProposal'), []);
  } finally { restore(); }
});

test('unarchiveSession: reopens from what was read and surfaces ccPurged', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const res = await subject.unarchiveSession({
      pool: unarchivePool({ status: 'archived', user_id: 2, app_id: 5, cc_purged: true }), sessionId: '1', userId: 2,
    });
    assert.deepEqual(res, { unarchived: true, ccPurged: true });
    assert.deepEqual(called('reopenProposal'), [{ sessionId: 1, appId: 5, userId: 2, from: 'archived' }]);
    // With no user (the system's reopen) the row's owner is the actor.
    await subject.unarchiveSession({
      pool: unarchivePool({ status: 'archived', user_id: 6, app_id: 5, cc_purged: false }), sessionId: 1,
    });
    assert.equal(called('reopenProposal')[1].userId, 6);
  } finally { restore(); }
  const refused = loadWithStubs({ reopenProposal: REJECTED('session_state_changed') });
  try {
    assert.deepEqual(await refused.subject.unarchiveSession({
      pool: unarchivePool({ status: 'archived', user_id: 2, app_id: 5, cc_purged: false }), sessionId: 1, userId: 2,
    }), { unarchived: false });
  } finally { refused.restore(); }
  // Its worker or CC volume still being removed (the machine waited, then
  // refused): not reopened, and the route says to try again.
  const tearing = loadWithStubs({ reopenProposal: REJECTED('tearing_down') });
  try {
    assert.deepEqual(await tearing.subject.unarchiveSession({
      pool: unarchivePool({ status: 'archived', user_id: 2, app_id: 5, cc_purged: false }), sessionId: 1, userId: 2,
    }), { unarchived: false, busy: true });
  } finally { tearing.restore(); }
  // Not decided in time is its own answer, not "still being closed".
  for (const out of [PENDING(), REJECTED('expired')]) {
    const undecided = loadWithStubs({ reopenProposal: out });
    try {
      assert.deepEqual(await undecided.subject.unarchiveSession({
        pool: unarchivePool({ status: 'archived', user_id: 2, app_id: 5, cc_purged: false }), sessionId: 1, userId: 2,
      }), { unarchived: false, notDecided: true }, out.status);
    } finally { undecided.restore(); }
  }
});

// ── A flow's own sessions (takeSlot / restSession / closeOwnSession) ─────

function statusPool(status) {
  return makePool([[/SELECT status FROM chat_sessions WHERE id = \$1/, status ? [{ status }] : []]]);
}

test('takeSlot: a paused session takes its slot through the machine, with no caps', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const pool = statusPool('paused');
    assert.equal(await subject.takeSlot({ pool, sessionId: '4', source: 'bot-build' }), true);
    assert.deepEqual(called('resumeProposal'), [{
      sessionId: 4, from: 'paused', caps: null, source: { kind: 'system', name: 'bot-build' },
    }]);
    assert.equal(pool.issued(/UPDATE/), false, 'the machine moves its activity');
  } finally { restore(); }
  const raced = loadWithStubs({ resumeProposal: REJECTED('already_active') });
  try {
    assert.equal(await raced.subject.takeSlot({ pool: statusPool('paused'), sessionId: 4 }), true,
      'another pass took it first: it holds the slot all the same');
  } finally { raced.restore(); }
  const closed = loadWithStubs({ resumeProposal: REJECTED('closed') });
  try {
    assert.equal(await closed.subject.takeSlot({ pool: statusPool('paused'), sessionId: 4 }), false);
  } finally { closed.restore(); }
});

test('takeSlot: an active session is touched, never a closed one resumed (bug 21)', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    const active = statusPool('active');
    assert.equal(await subject.takeSlot({ pool: active, sessionId: 4 }), true);
    const touch = active.calls.find((c) => /UPDATE chat_sessions SET last_activity_at = NOW\(\)/.test(c.sql));
    assert.deepEqual(touch.params, [4]);
    assert.doesNotMatch(touch.sql, /status/, 'only the activity, never the status');
    const archived = statusPool('archived');
    assert.equal(await subject.takeSlot({ pool: archived, sessionId: 4 }), false);
    assert.equal(await subject.takeSlot({ pool: statusPool(null), sessionId: 4 }), false);
    assert.deepEqual(called('resumeProposal'), []);
  } finally { restore(); }
});

test('restSession: only an active session goes back to rest, through the machine\'s pause', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    assert.equal(await subject.restSession({ pool: statusPool('active'), sessionId: '4' }), true);
    assert.deepEqual(called('pauseProposal'), [{ sessionId: 4, reason: 'rest', from: 'active' }]);
    for (const status of ['paused', 'promoted', 'archived', null]) {
      assert.equal(await subject.restSession({ pool: statusPool(status), sessionId: 4 }), false, String(status));
    }
    assert.equal(called('pauseProposal').length, 1);
  } finally { restore(); }
  // A turn still in flight is the machine's refusal (#1006); a throw is no pause.
  const refused = loadWithStubs({ pauseProposal: REJECTED('worked_on') });
  try {
    assert.equal(await refused.subject.restSession({ pool: statusPool('active'), sessionId: 4 }), false);
  } finally { refused.restore(); }
  const threw = loadWithStubs({ pauseProposal: () => { throw new Error('connection reset'); } });
  try {
    assert.equal(await threw.subject.restSession({ pool: statusPool('active'), sessionId: 4 }), false);
  } finally { threw.restore(); }
});

test('closeOwnSession: closes from whatever open status it reads, the way every close goes', async () => {
  const { subject, called, restore } = loadWithStubs();
  try {
    for (const status of ['active', 'paused', 'promoted']) {
      const pool = makePool([[/SELECT status FROM chat_sessions/, [{ status }]], SLUG]);
      assert.equal(await subject.closeOwnSession({ pool, sessionId: 4, reason: 'bench-trial', waitMs: 50 }), true, status);
    }
    assert.deepEqual(called('closeProposal').map((p) => [p.from, p.reason, p.waitMs, p.userId]), [
      ['active', 'bench-trial', 50, null], ['paused', 'bench-trial', 50, null], ['promoted', 'bench-trial', 50, null],
    ]);
    for (const status of ['merging', 'merged', 'archived', null]) {
      assert.equal(await subject.closeOwnSession({ pool: statusPool(status), sessionId: 4, reason: 'x' }), false, String(status));
    }
    assert.equal(called('closeProposal').length, 3);
  } finally { restore(); }
  const refused = loadWithStubs({ closeProposal: REJECTED('session_state_changed') });
  try {
    assert.equal(await refused.subject.closeOwnSession({ pool: statusPool('active'), sessionId: 4, reason: 'x' }), false);
  } finally { refused.restore(); }
});

// ── teardownStagingForSession ─────────────────────────────────────────────

// The preview machine retires the preview; the reason it is handed is the
// one the card and the logs name. A leak keeps the row's link for a retry
// and announces nothing.
test('teardownStagingForSession: hands its reason to the preview\'s teardown, and a leak announces nothing', async () => {
  const ids = { staging: require.resolve('../src/services/staging'), ws: require.resolve('../src/services/ws') };
  const orig = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, require.cache[id]]));
  const torn = [];
  const pushed = [];
  let answer = { removed: true };
  require.cache[ids.staging] = { id: ids.staging, filename: ids.staging, loaded: true, paths: [],
    exports: { teardownStaging: async (...args) => { torn.push(args); return answer; } } };
  require.cache[ids.ws] = { id: ids.ws, filename: ids.ws, loaded: true, paths: [],
    exports: { pushSessionUpdate: (u) => pushed.push(u) } };
  const { subject, restore } = loadWithStubs();
  try {
    const row = { id: 42, app_slug: 'widget', staging_runtime_name: 'preview-42' };
    const pool = makePool([[/FROM chat_sessions cs JOIN apps a/, [row]]]);
    assert.deepEqual(await subject.teardownStagingForSession({ pool, sessionId: 42, reason: 'pressure' }), { torn: true });
    assert.deepEqual(torn, [[row, { slug: 'widget' }, { reason: 'pressure' }]]);
    assert.deepEqual(pushed, [{ action: 'staging_torn_down', sessionId: 42, appSlug: 'widget' }]);
    await subject.teardownStagingForSession({ pool, sessionId: 42 });
    assert.deepEqual(torn[1][2], { reason: 'idle' }, 'idle unless it says otherwise');

    answer = { removed: false, leaked: true };
    pushed.length = 0;
    assert.deepEqual(await subject.teardownStagingForSession({ pool, sessionId: 42, reason: 'pressure' }), { torn: false, leaked: true });
    assert.deepEqual(pushed, []);
    // Nothing to give back: no teardown at all.
    torn.length = 0;
    const none = makePool([[/FROM chat_sessions cs JOIN apps a/, [{ id: 43, app_slug: 'widget' }]]]);
    assert.deepEqual(await subject.teardownStagingForSession({ pool: none, sessionId: 43 }), { torn: false });
    assert.deepEqual(torn, []);
  } finally {
    restore();
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
});

// ── An archived session's CC volume ───────────────────────────────────────

// The leader's hourly GC purged it with no lock, and could race a Reopen.
// The proposal machine queues the purge with the close, due once the
// retention window has passed, and a Reopen cancels it
// (tests/workflow-proposal-retention-postgres.test.js).
test('the archived CC purge is the proposal machine\'s, not this module\'s', () => {
  const { subject, restore } = loadWithStubs();
  try {
    assert.equal(subject.purgeArchivedCc, undefined);
  } finally { restore(); }
  const src = require('node:fs').readFileSync(require.resolve('../src/services/session-lifecycle'), 'utf8');
  assert.doesNotMatch(src, /destroyCcVolume|cc_purged = TRUE/);
});
