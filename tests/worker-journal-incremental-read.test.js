'use strict';

// On Kubernetes a turn journal is followed by polling
// (src/services/worker.js, _consumeJournal). It used to `cat` the whole
// journal every second and keep lines sliced from that copy, which pins the
// entire copy: a long turn held one journal-sized string per second of output
// and the platform ran out of heap (2026-09-25). Each poll now reads only the
// lines written since the last one (`tail -n +K`).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WORKER_RUNTIME = 'kubernetes';
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

const JOURNAL = '/tmp/turn-journal.jsonl';

test('a Kubernetes turn journal is read incrementally, each line exactly once', async (t) => {
  const records = [
    JSON.stringify({ type: 'system', note: 'start' }),
    JSON.stringify({ type: 'progress', text: 'héllo ✓ — ünïcode' }),
    '',
    JSON.stringify({ type: 'progress', text: 'x'.repeat(5000) }),
    JSON.stringify({ type: 'progress', text: 'last line before exit' }),
    '__USERNODE_EXIT__ 0',
  ];
  const full = `${records.join('\n')}\n`;
  // What the writer has flushed at each poll: the second ends mid-record.
  const cut = full.indexOf('x'.repeat(100));
  const growth = [
    full.slice(0, full.indexOf('\n\n') + 2),
    full.slice(0, cut),
    full.slice(0, full.indexOf('__USERNODE_EXIT__')),
    full,
  ];
  const calls = [];
  let servedChars = 0;
  t.mock.method(kubernetes, 'execInWorker', async (_config, _name, command) => {
    calls.push(command);
    const written = growth[Math.min(calls.length - 1, growth.length - 1)];
    assert.equal(command[0], 'tail', 'no whole-journal read');
    assert.deepEqual([command[1], command[3]], ['-n', JOURNAL]);
    const firstLine = Number(command[2].replace('+', ''));
    // `tail -n +K`: from line K (1-based) through whatever is flushed.
    const lines = written.split('\n');
    const stdout = lines.slice(firstLine - 1).join('\n');
    servedChars += stdout.length;
    return { stdout, stderr: '' };
  });

  const state = await worker.resumeTurnFromJournal(987654, {
    journal: JOURNAL,
    agentBackend: 'claude_code',
    startedAt: new Date().toISOString(),
  });

  assert.equal(state.execExitSeen, true, 'the exit marker ended the follow');
  assert.equal(state.rawStdout, full, 'every line once, in order, none lost at the mid-record boundary');
  assert.deepEqual(calls.map((command) => command[2]), ['+1', '+4', '+4', '+6'],
    'each poll starts at the first line not yet consumed; a half-written line is read again whole');
  assert.ok(servedChars < full.length * 2,
    `transferred ${servedChars} chars for a ${full.length}-char journal, not a full copy per poll`);
});
