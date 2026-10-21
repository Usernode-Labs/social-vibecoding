// test:changed: when src/ (the workflow code and every SQL writer of an owned column; tests/lib/workflow-boundary.js)
'use strict';

// The boundary between each workflow machine and the code not migrated yet,
// read from source by tests/lib/workflow-boundary.js: each place a part of a
// machine names code outside src/workflow/, what its own code does that the
// contract forbids, each table a handler writes itself, each other writer of
// a column it owns. tests/baselines/workflow-process-state.json holds what
// was reviewed of it, and nothing else may be there:
// - `allowed`: the kernel's own timers, the bot-build machine's build
//   pipeline, and the routes' side's wiring (its runtime handle, pool and
//   logger), each with the reason it decides nothing;
// - `io`: a work handler's I/O core, a function outside src/workflow/ shown
//   to keep no process memory, each with a reason saying what it does and
//   why it keeps none (the two-process and restart tests show it);
// The last hand-offs (calls into a flow a later step would migrate) left
// with step 9, the agent turns' presence in Postgres: there are none, and
// none may come back.
// Everything else (a new call, another writer of an owned column, module
// state, a timer) fails here: the list of what the machines still depend on
// is empty, and stays so (plan-ratchet-cleanup, 2026-10-17). An entry that
// is gone fails until it leaves the list too (`node
// tests/lib/workflow-boundary.js --shrink` drops what is gone and never adds
// anything).

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundary, readBaseline, BASELINE } = require('./lib/workflow-boundary');

const SECTIONS = ['io'];

test('every place a workflow machine reaches outside src/workflow/ is reviewed, and nothing else is there', () => {
  const baseline = readBaseline();
  const now = boundary(undefined, new Set(Object.keys(baseline.allowed)));
  const problems = [];
  for (const [name, entries] of now) {
    const reviewed = new Map(SECTIONS.map((k) => [k, (baseline[k] || {})[name] || {}]));
    for (const [entry, from] of entries) {
      if ([...reviewed.values()].some((m) => Object.prototype.hasOwnProperty.call(m, entry))) continue;
      problems.push(`${name}: "${entry}" (${from}) is not reviewed: move it into the machine, cut it out of what keeps process memory, or name it in io with a reason`);
    }
  }
  for (const section of SECTIONS) {
    for (const [name, entries] of Object.entries(baseline[section] || {})) {
      if (!now.has(name)) { problems.push(`${name}: listed in ${section}, but no such machine under src/workflow/`); continue; }
      for (const entry of Object.keys(entries)) {
        if (!now.get(name).has(entry)) problems.push(`${name}: ${section}: "${entry}" is gone; remove it from the list (--shrink)`);
      }
    }
  }
  assert.deepEqual(problems, [], `${problems.length} difference(s) from ${BASELINE}:\n${problems.join('\n')}`);
});

test('each I/O core says what it does and why it keeps no process memory; nothing is handed off', () => {
  const baseline = readBaseline();
  assert.deepEqual(Object.keys(baseline).sort(), ['allowed', 'io'], 'nothing but what was reviewed, and no hand-off');
  for (const [name, entries] of Object.entries(baseline.io || {})) {
    for (const [entry, reason] of Object.entries(entries)) {
      assert.ok(entry.startsWith('services | uses '), `${name}: io: ${entry}: only a work handler's call can be one`);
      assert.ok(typeof reason === 'string' && reason.length > 40, `${name}: io: ${entry}: say what it does, and why it keeps no process memory`);
    }
  }
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
