'use strict';

// defineMachine's table validation and the kernel's pure helpers
// (src/workflow/kernel/machine.ts). No database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { defineMachine, NONE, ok, reject, canonicalHash } = require('../src/workflow/kernel/index.ts');

const base = () => ({
  name: 'kt-valid',
  version: 1,
  events: { Open: (p) => p, Close: (p) => p },
  create: ['Open'],
  terminal: ['closed'],
  decode: (row) => ({ name: row.state, data: row.data }),
  authorize: { Open: () => ok(), Close: () => ok() },
  transitions: {
    [NONE]: { Open: { to: () => ({ next: { name: 'open', data: {} } }) } },
    open: { Open: { ignore: 'already_open' }, Close: { to: () => ({ next: { name: 'closed', data: {} } }) } },
    closed: { '*': { ignore: 'closed' } },
  },
});

test('a complete table defines a machine', () => {
  const m = defineMachine(base());
  assert.deepEqual(m.states, ['open', 'closed']);
  assert.deepEqual(m.entryFor('closed', 'Close'), { ignore: 'closed' });
  assert.deepEqual(m.entryFor(NONE, 'Close'), { ignore: 'no_instance' });
  // Work results are kernel events: a state that does not list them refuses them,
  // even under a wildcard ignore.
  assert.deepEqual(m.entryFor('closed', 'WorkSucceeded'), { ignore: 'unexpected_work_result' });
});

test('every state must handle or ignore every declared event', () => {
  const def = base();
  delete def.transitions.open.Open;
  assert.throws(() => defineMachine(def), /state open neither handles nor ignores Open/);
});

test('every declared event needs an authorize rule', () => {
  const def = base();
  delete def.authorize.Close;
  assert.throws(() => defineMachine(def), /no authorize rule for Close/);
});

test('table entries name declared events and states, and creating events start from (none)', () => {
  const unknown = base();
  unknown.transitions.open.Reopen = { to: () => ({}) };
  assert.throws(() => defineMachine(unknown), /undeclared event/);
  const noCreate = base();
  noCreate.transitions[NONE] = {};
  assert.throws(() => defineMachine(noCreate), /creating event Open has no transition/);
  const stray = base();
  stray.transitions[NONE].Close = { to: () => ({}) };
  assert.throws(() => defineMachine(stray), /not listed in create/);
  const terminal = base();
  terminal.terminal = ['gone'];
  assert.throws(() => defineMachine(terminal), /terminal state gone/);
  const kernelEvent = base();
  kernelEvent.events.WorkSucceeded = (p) => p;
  assert.throws(() => defineMachine(kernelEvent), /kernel event/);
  const noTo = base();
  noTo.transitions.open.Close = { guard: () => ok() };
  assert.throws(() => defineMachine(noTo), /neither `to` nor `ignore`/);
});

test('work results are authorised only from the service that ran the work', () => {
  const m = defineMachine(base());
  const event = (source) => ({ type: 'WorkSucceeded', payload: { workId: 'w1' }, source });
  assert.equal(m.check(event({ kind: 'service', workId: 'w1' }), undefined, {}), true);
  assert.deepEqual(m.check(event({ kind: 'service', workId: 'w2' }), undefined, {}), reject('not_a_service_result'));
  assert.deepEqual(m.check(event({ kind: 'route' }), undefined, {}), reject('not_a_service_result'));
});

test('the payload hash is canonical: key order does not matter, values do', () => {
  assert.equal(canonicalHash({ a: 1, b: { c: [1, 2], d: null } }), canonicalHash({ b: { d: null, c: [1, 2] }, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
  assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
});
