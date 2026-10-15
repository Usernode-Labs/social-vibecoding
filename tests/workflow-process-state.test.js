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
// with:
// - the other writers of its own columns (removed by the end of its step,
//   when the legacy paths go);
// - calls it took over from a machine that lists them, each named in the
//   baseline's `takenOver` with where it came from (the call moves, so the
//   list ends no longer);
// - its work's I/O cores (`io`): a function outside src/workflow/ that does
//   the step's I/O, cut out of the per-process wrapper the old flow runs it
//   through, each with a reason saying so. The two-process and restart
//   tests show it keeps no process memory;
// - hand-offs to a flow a later step migrates (`handOff`), each naming that
//   step: they leave the list when it does.
// Nothing else. (Decided with Bruno for the preview machine, 2026-10-14.)
const PREDATE = new Set(['governance-proposal', 'merge-followups', 'platform', 'kernel']);

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
      const named = new Map(['takenOver', 'io', 'handOff'].map((k) => [k, (baseline[k] || {})[name] || {}]));
      for (const entry of listed) {
        if (entry.startsWith('ownership | ')) continue;
        if ([...named.values()].some((m) => Object.prototype.hasOwnProperty.call(m, entry))) continue;
        problems.push(`${name}: a new machine may list only other writers of its columns, calls it took over, its I/O cores and hand-offs to a later step, not "${entry}"`);
      }
    }
  }
  for (const name of Object.keys(baseline.machines)) {
    if (!now.has(name)) problems.push(`${name}: listed, but no such machine under src/workflow/`);
  }
  assert.deepEqual(problems, [], `${problems.length} difference(s) from ${BASELINE}:\n${problems.join('\n')}`);
});

test('each call a new machine took over says from where, and is still listed for it', () => {
  const baseline = readBaseline();
  for (const [name, moved] of Object.entries(baseline.takenOver || {})) {
    const listed = new Set(baseline.machines[name] || []);
    for (const [entry, reason] of Object.entries(moved)) {
      assert.ok(typeof reason === 'string' && reason.length > 40, `${name}: ${entry}: say which machine it was taken from`);
      assert.ok(listed.has(entry), `${name}: ${entry}: taken over but no longer listed; remove it from takenOver`);
    }
  }
});

test('each I/O core says what it does and which wrapper it was cut out of, each hand-off which step removes it', () => {
  const baseline = readBaseline();
  for (const [section, says] of [['io', 'what it does, outside which per-process wrapper'], ['handOff', 'which step migrates the flow it calls']]) {
    for (const [name, entries] of Object.entries(baseline[section] || {})) {
      const listed = new Set(baseline.machines[name] || []);
      for (const [entry, reason] of Object.entries(entries)) {
        assert.ok(entry.startsWith('services | uses '), `${name}: ${section}: ${entry}: only a work handler's call can be one`);
        assert.ok(typeof reason === 'string' && reason.length > 40, `${name}: ${section}: ${entry}: say ${says}`);
        if (section === 'handOff') assert.match(reason, /\bstep\b/, `${name}: ${entry}: name the step that removes it`);
        assert.ok(listed.has(entry), `${name}: ${section}: ${entry}: no longer listed; remove it from ${section}`);
      }
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
