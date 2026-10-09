'use strict';

// The web side of the session-activity machine (src/services/session-activity.js),
// against a fake platform: with the flag off it is a pass-through; with it on, an
// activity asks once, a step of it joins it, it ends once when every part of it
// has, and a Stop reaches the activity this process holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const stub = (rel, exports) => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const answers = [];
const rows = new Map();
const fakePlatform = {
  sessionActivityEnabled: () => true,
  async requestActivity(a) {
    calls.push({ type: 'Requested', ...a });
    const answer = answers.shift() || { status: 'accepted', reply: { granted: true, leaseMs: 90000, renewMs: 20 } };
    if (answer.status === 'accepted') rows.set(a.activityId, { sessionId: a.sessionId, kind: a.kind, stop: null });
    return answer;
  },
  async endActivity(sessionId, activityId, outcome) {
    calls.push({ type: 'Ended', sessionId, activityId, outcome });
    rows.delete(activityId);
  },
  async renewActivity(activityId) {
    const row = rows.get(activityId);
    return row ? { held: true, stop: row.stop } : { held: false, stop: null };
  },
  async readSessionActivities(ids) {
    const out = new Map();
    for (const [id, r] of rows) {
      if (!ids.includes(r.sessionId)) continue;
      if (!out.has(r.sessionId)) out.set(r.sessionId, []);
      out.get(r.sessionId).push({ id, kind: r.kind, stopping: !!r.stop });
    }
    return out;
  },
};
stub('workflow/platform.ts', fakePlatform);
stub('services/session-state', { touch() {} });
const activity = require('../src/services/session-activity');

const requested = () => calls.filter((c) => c.type === 'Requested');
const ended = () => calls.filter((c) => c.type === 'Ended');
const reset = () => { calls.length = 0; answers.length = 0; rows.clear(); };

test('with the flag off, nothing is asked and nothing refuses', async () => {
  reset();
  activity.configure({ wfSessionActivityEnabled: false });
  assert.equal(await activity.run(1, 'turn', {}, async (h) => (h === null ? 'ran' : 'no')), 'ran');
  assert.equal(await activity.begin(1, 'turn'), null);
  assert.deepEqual(await activity.tryBegin(1, 'turn'), { activity: null, refused: null });
  assert.deepEqual(await activity.busyIds([1]), new Set());
  assert.deepEqual(calls, []);
});

test('an activity asks once; its own steps join it, and it ends once when the last part ends', async () => {
  reset();
  activity.configure({ wfSessionActivityEnabled: true });
  await activity.run(7, 'turn', { label: 'sync with main' }, async () => {
    await activity.run(7, 'turn', { label: 'its own turn' }, async () => {});
    await activity.run(7, 'operation', { label: 'a branch move inside it' }, async () => {});
    assert.equal(ended().length, 0, 'still running');
  });
  assert.equal(requested().length, 1);
  assert.equal(ended().length, 1);
  assert.equal(ended()[0].outcome, 'done');
});

test('a step the activity does not cover asks, with the activity as its parent', async () => {
  reset();
  await activity.run(8, 'hold', { label: 'before & after shots' }, async (hold) => {
    await activity.run(8, 'turn', { label: 'the shots turn' }, async () => {});
    assert.equal(requested()[1].parent, hold.id);
  });
  assert.equal(requested().length, 2);
  assert.equal(ended().length, 2);
});

test('another session is never joined', async () => {
  reset();
  await activity.run(9, 'turn', {}, async () => {
    await activity.run(10, 'turn', {}, async () => {});
  });
  assert.deepEqual(requested().map((c) => c.sessionId), [9, 10]);
  assert.equal(requested()[1].parent, null);
});

test('a refusal throws before the work runs, saying what is in the way', async () => {
  reset();
  answers.push({ status: 'rejected', reason: 'busy_hold' });
  let ran = false;
  await assert.rejects(activity.run(11, 'turn', {}, async () => { ran = true; }),
    (err) => err instanceof activity.SessionBusyError && err.blockedBy === 'hold' && err.retainActiveTurn === true);
  assert.equal(ran, false);
  const gate = await activity.tryBegin(11, 'turn').catch((e) => e);
  assert.ok(gate.activity, 'granted once nothing is in the way');
  await gate.activity.end();
});

test('a request not answered in time is cancelled and refused', async () => {
  reset();
  answers.push({ status: 'pending' });
  await assert.rejects(activity.begin(12, 'turn'), (err) => err.blockedBy === 'unavailable');
  assert.equal(ended().length, 1, 'cancelled under the same id');
  assert.equal(ended()[0].activityId, requested()[0].activityId);
});

test('retain keeps an activity on for work that outlives its caller', async () => {
  reset();
  const op = await activity.begin(13, 'operation');
  const keep = op.retain();
  await op.end();
  assert.equal(ended().length, 0, 'the detached pipeline still runs');
  keep();
  await new Promise((r) => setImmediate(r));
  assert.equal(ended().length, 1);
});

test('what readers count leaves out a Mayor chat turn and what the caller runs inside', async () => {
  reset();
  const chat = await activity.begin(14, 'chat');
  assert.deepEqual(await activity.busyIds([14]), new Set());
  await activity.run(14, 'operation', {}, async () => {
    assert.equal(await activity.isBusy(14), false, 'its own operation');
  });
  await chat.end();
  const turn = await activity.begin(14, 'turn');
  assert.equal(await activity.isBusy(14), true);
  assert.deepEqual(await activity.liveStates([14]), new Map([[14, { busy: true, stopping: false }]]));
  await turn.end();
});

test('a Stop reaches the activity this process holds, and comes again at the next renewal until it lands', async () => {
  reset();
  const delivered = [];
  let land = false;
  activity.setStopHandler(async (sessionId, stop) => { delivered.push(sessionId); return land; });
  const turn = await activity.begin(15, 'turn');
  const stop = { at: new Date().toISOString(), by: { id: 1, username: 'ana', canAdminWrite: false } };
  assert.equal(activity.stopArrived({ sessionId: 15, activityId: 'not-ours', stop }), false);
  assert.equal(activity.stopArrived({ sessionId: 15, activityId: turn.handle.id, stop }), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(delivered, [15]);
  rows.get(turn.handle.id).stop = stop;
  land = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(delivered.length >= 2, 'delivered again by the renewal');
  const after = delivered.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(delivered.length, after, 'not again once it landed');
  activity.setStopHandler(null);
  await turn.end();
});

test('a lease that ran out is reported to its holder', async () => {
  reset();
  const turn = await activity.begin(16, 'turn');
  rows.delete(turn.handle.id);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(turn.handle.signal.aborted, true);
  assert.equal(turn.handle.alive(), false);
  await turn.end();
  assert.equal(ended().length, 0, 'nothing to end: it is already gone');
});
