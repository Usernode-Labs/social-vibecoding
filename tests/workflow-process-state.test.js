// test:changed: when src/ (the workflow code and every SQL writer of an owned column; tests/lib/workflow-boundary.js)
'use strict';

// The boundary between each workflow machine and the code not migrated yet,
// read from source by tests/lib/workflow-boundary.js and checked in at
// tests/baselines/workflow-process-state.json: each place a part of a machine
// names code outside src/workflow/, what its own code does that the contract
// forbids, each notifier, each table a handler writes itself, each other
// writer of a column it owns. The list may only shrink: a change that adds
// an entry fails here; a change that removes one fails until the entry
// leaves the list too (`node tests/lib/workflow-boundary.js --shrink` drops
// what is gone and never adds anything). The migration is done when it is
// empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundary, readBaseline, BASELINE } = require('./lib/workflow-boundary');

// The machines that predate the list. Any other machine may enter it only
// with the other writers of its own columns (removed by the end of its step,
// when the legacy paths go) and what its work handlers call to do their I/O
// (a container runtime's client): never in its transitions, its notifiers or
// its own state.
const PREDATE = new Set(['governance-proposal', 'merge-followups', 'platform', 'kernel']);
const NEW_MACHINE_MAY_LIST = /^(ownership|services \| uses) /;

test('the workflow machines cross no new boundary into code not migrated yet', () => {
  const baseline = readBaseline();
  const now = boundary(undefined, new Set(Object.keys(baseline.allowed)));
  const problems = [];
  for (const [name, entries] of now) {
    const listed = new Set(baseline.machines[name] || []);
    for (const [entry, from] of entries) {
      if (!listed.has(entry)) problems.push(`${name}: new entry "${entry}" (${from})`);
    }
    for (const entry of listed) {
      if (!entries.has(entry)) problems.push(`${name}: "${entry}" is gone; remove it from the list (--shrink)`);
    }
    if (!PREDATE.has(name)) {
      for (const entry of listed) {
        if (!NEW_MACHINE_MAY_LIST.test(entry)) problems.push(`${name}: a new machine may list only other writers of its columns and its work handlers' I/O, not "${entry}"`);
      }
    }
  }
  for (const name of Object.keys(baseline.machines)) {
    if (!now.has(name)) problems.push(`${name}: listed, but no such machine under src/workflow/`);
  }
  assert.deepEqual(problems, [], `${problems.length} difference(s) from ${BASELINE}:\n${problems.join('\n')}`);
});

test('each allowed entry says why, and is still there', () => {
  const baseline = readBaseline();
  const all = boundary(undefined, new Set());
  const present = new Set([...all.values()].flatMap((m) => [...m.keys()].map((e) => e.replace(/^\w+ \| /, ''))));
  for (const [entry, reason] of Object.entries(baseline.allowed)) {
    assert.ok(typeof reason === 'string' && reason.length > 20, `${entry}: give the reason it is allowed`);
    assert.ok(present.has(entry), `${entry}: allowed but no longer there; remove it`);
  }
});
