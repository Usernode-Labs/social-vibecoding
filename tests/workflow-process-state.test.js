// test:changed: when src/ (any module a workflow machine reaches; scripts/workflow-state-trace.mjs)
'use strict';

// Every place a workflow machine still depends on something a restart
// erases, or bends the workflow contract (docs/workflows.md), traced from
// source by scripts/workflow-state-trace.mjs and checked in at
// tests/baselines/workflow-process-state.json. The list may only shrink:
// a change that adds an entry fails here with the path that reaches it; a
// change that removes one fails until the entry leaves the list too
// (`node scripts/workflow-state-trace.mjs --shrink` drops what is no longer
// reached and never adds anything). The migration is done when it is empty.

const test = require('node:test');
const assert = require('node:assert/strict');

// The machines that predate the list. Any other machine may enter it only
// with the other writers of its own columns (removed by the end of its step,
// when the legacy paths go); nothing else.
const PREDATE = new Set(['governance-proposal', 'merge-followups', 'platform', 'kernel', 'relay']);

// One trace of the checkout, shared by the tests (about two seconds).
let traced = null;
function trace() {
  traced ||= import('../scripts/workflow-state-trace.mjs').then((m) => ({ m, trace: m.traceMachines() }));
  return traced;
}

test('the workflow machines reach nothing new that a restart erases', async () => {
  const { m: { ratchetEntries, readBaseline, BASELINE }, trace: traced } = await trace();
  const baseline = readBaseline();
  const allowed = new Set(Object.keys(baseline.allowed));
  const now = ratchetEntries(traced, allowed);
  const problems = [];

  for (const [name, entries] of now) {
    const listed = new Set(baseline.machines[name] || []);
    for (const [entry, d] of entries) {
      if (listed.has(entry)) continue;
      const path = d.meet ? d.walk.pathTo(d.meet.via).join(' → ')
        : d.write ? d.walk.pathTo(d.write.via).join(' → ') : (d.detail || '');
      problems.push(`${name}: new entry "${entry}"${path ? `\n    via ${path}` : ''}`);
    }
    for (const entry of listed) {
      if (!entries.has(entry)) problems.push(`${name}: "${entry}" is no longer reached; remove it from the list (--shrink)`);
    }
    if (!PREDATE.has(name)) {
      for (const entry of listed) {
        if (!entry.startsWith('ownership | ')) problems.push(`${name}: a new machine may list only other writers of its columns, not "${entry}"`);
      }
    }
  }
  for (const name of Object.keys(baseline.machines)) {
    if (!now.has(name)) problems.push(`${name}: listed, but no such machine under src/workflow/`);
  }
  assert.deepEqual(problems, [], `${problems.length} difference(s) from ${BASELINE}:\n${problems.join('\n')}`);
});

test('each allowed process resource says why, and is still reached', async () => {
  const { m: { readBaseline }, trace: traced } = await trace();
  const baseline = readBaseline();
  const reached = new Set();
  for (const t of traced.machines.values()) for (const r of t.roles.values()) for (const k of r.met.keys()) reached.add(k);
  for (const [entry, reason] of Object.entries(baseline.allowed)) {
    assert.ok(typeof reason === 'string' && reason.length > 20, `${entry}: give the reason it is allowed`);
    assert.ok(reached.has(entry), `${entry}: allowed but no longer reached; remove it`);
  }
});
