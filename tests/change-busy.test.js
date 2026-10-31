'use strict';

// #6068: what a held change is, in the words the change page and the Mayor
// read. The database rules (which rows make a holder, and that workedOnSql is
// the same expression) are pinned against a real PostgreSQL schema in
// tests/session-work-holders-postgres.test.js; this suite is the pure part:
// when a holder list is called stuck, and which kinds are ever released.

const test = require('node:test');
const assert = require('node:assert/strict');

const busy = require('../src/services/change-busy');

const MINUTE = 60 * 1000;
const ago = (minutes, now) => new Date(now - minutes * MINUTE).toISOString();

test('a live coding turn is never stuck, however old', () => {
  const now = Date.now();
  const list = [
    { kind: 'turn', since: ago(90, now) },
    { kind: 'bot', since: ago(80, now) },
  ];
  assert.equal(busy.stuckOf(list, { now }), null, 'a turn is something a person can wait on');
});

test('a young holder is busy but not stuck', () => {
  const now = Date.now();
  const list = [{ kind: 'bot', since: ago(4, now) }];
  assert.equal(busy.stuckOf(list, { now }), null, 'four minutes is inside the window');
  const old = busy.stuckOf([{ kind: 'bot', since: ago(20, now) }], { now });
  assert.ok(old, 'twenty minutes is stuck');
  assert.deepEqual(old.holders, [{ kind: 'bot', since: ago(20, now) }]);
  assert.equal(old.since, ago(20, now));
  assert.equal(old.heldMs, 20 * MINUTE);
});

test('a kind with progress of its own is never stuck, however old', () => {
  const now = Date.now();
  for (const kind of ['sync', 'shots']) {
    assert.equal(busy.stuckOf([{ kind, since: ago(120, now) }], { now }), null,
      `${kind} has progress of its own`);
  }
  for (const kind of ['operation', 'bot', 'build', 'local_agent', 'turn_instance']) {
    assert.ok(busy.stuckOf([{ kind, since: ago(20, now) }], { now }), `${kind} can be stuck`);
  }
});

test('one old silent holder next to one with progress is not a stuck change', () => {
  const now = Date.now();
  const list = [
    { kind: 'operation', since: ago(40, now) },
    { kind: 'sync', since: ago(41, now) },
  ];
  assert.equal(busy.stuckOf(list, { now }), null);
});

test('a holder with no start is old by definition', () => {
  const now = Date.now();
  const stuck = busy.stuckOf([{ kind: 'operation', since: null }], { now });
  assert.ok(stuck);
  assert.equal(stuck.since, null);
});

test('the window is configurable, and the default is ten minutes', () => {
  const now = Date.now();
  const list = [{ kind: 'operation', since: ago(6, now) }];
  assert.equal(busy.stuckOf(list, { now }), null);
  assert.ok(busy.stuckOf(list, { now, windowMs: 5 * MINUTE }), 'a shorter window catches it');
  assert.equal(busy.stuckOf([], { now }), null, 'nothing holding it is not stuck');
  assert.equal(busy.stuckMs(), 10 * MINUTE);
});

test('the silent kinds are the ones with nothing on screen moving', () => {
  for (const kind of ['operation', 'bot', 'build', 'local_agent', 'turn_instance']) {
    assert.ok(busy.SILENT_KINDS.has(kind), kind);
  }
  for (const kind of ['turn', 'sync', 'shots']) {
    assert.ok(!busy.SILENT_KINDS.has(kind), kind);
  }
});

test('the sweep asks only for open changes that never had code', () => {
  assert.match(busy.SWEEP_SQL, /cs\.status IN \('active', 'paused'\)/);
  assert.match(busy.SWEEP_SQL, /cs\.branch_name IS NULL/);
  assert.match(busy.SWEEP_SQL, /cs\.active_turn IS NULL/);
  assert.match(busy.SWEEP_SQL, /EXISTS \(SELECT h\.kind/);
});

test('the cleared line is one sentence the thread can show', () => {
  assert.equal(busy.CLEARED_LINE, 'Cleared a stuck status: nothing was running on this change.');
  assert.ok(!busy.CLEARED_LINE.includes('\u2014'), 'no em dash in user-facing copy');
});
