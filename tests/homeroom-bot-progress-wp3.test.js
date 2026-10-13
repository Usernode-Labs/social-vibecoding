'use strict';

// WP3 (#8, #19): two pure rules of how far along the Homeroom bot is, beside
// tests/homeroom-bot-progress.test.js: a queue row left over from before its
// request's proposal merged is not work in the queue, and how long each step
// usually takes is a fixed range, never past the step's time limit. The
// PostgreSQL side is tests/homeroom-bot-mayor-postgres.test.js.
//
// Run with: node --test tests/homeroom-bot-progress-wp3.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../src/services/homeroom-bot-progress');

const NOW = new Date('2026-10-02T16:04:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
const stage = (row) => progress.stageOf(row, { now: NOW });

test('#8 (WP3): a queue row from before its proposal merged is left over, not work in the queue', () => {
  const merged = { proposal_status: 'merged', merged_at: '2026-10-03T12:00:00Z', queue_id: 9, queue_reason: 'changed' };
  // Put there before the merge (a reply, a look again): nothing in progress,
  // where it used to read "waiting in the queue" in the header for days.
  assert.equal(progress.leftOverQueue({ ...merged, enqueued_at: '2026-10-03T11:58:00Z' }), true);
  assert.equal(stage({ ...merged, enqueued_at: '2026-10-03T11:58:00Z' }), null);
  assert.equal(stage({ ...merged, enqueued_at: '2026-10-03T11:58:00Z', started_at: '2026-10-03T11:59:00Z' }), null,
    'nor being read');
  assert.equal(progress.leftOverQueue({ ...merged, enqueued_at: new Date('2026-10-03T11:59:59.999Z'), merged_at: new Date('2026-10-03T12:00:00Z') }), true,
    'the database\'s dates, to the millisecond');
  // Put there after the merge: new work.
  assert.equal(progress.leftOverQueue({ ...merged, enqueued_at: '2026-10-03T12:05:00Z' }), false);
  assert.equal(stage({ ...merged, enqueued_at: '2026-10-03T12:05:00Z' }).stage, 'queued');
  // Not merged, or no merge time to compare: the row stands.
  assert.equal(progress.leftOverQueue({ ...merged, proposal_status: 'promoted', enqueued_at: '2026-10-03T11:58:00Z' }), false);
  assert.equal(progress.leftOverQueue({ ...merged, merged_at: null, enqueued_at: '2026-10-03T11:58:00Z' }), false);
  assert.equal(stage({ queue_id: 4, enqueued_at: ago(1), queue_position: 2 }).stage, 'queued', 'an ordinary queue row is untouched');
});

test('#19 (WP3): how long a step usually takes is a fixed range, never past its time limit, and none for a wait', () => {
  assert.deepEqual(progress.typicalMinutes('building'), { from: 10, to: 25 });
  assert.deepEqual(progress.typicalMinutes('reading'), { from: 1, to: 3 });
  assert.deepEqual(progress.typicalMinutes('building', 20), { from: 10, to: 20 }, 'a build stopped at 20 minutes takes at most that');
  assert.deepEqual(progress.typicalMinutes('planning', 2), { from: 2, to: 2 });
  for (const stageName of ['queued', 'build_queued', 'question', 'vote', 'held', 'stalled', 'merging', 'followup_queued', 'fix_queued', 'checks_failed']) {
    assert.equal(progress.typicalMinutes(stageName), null, `${stageName} waits on somebody, and takes no usual time`);
  }
  for (const [key, [from, to]] of Object.entries(progress.TYPICAL_MINUTES)) {
    assert.ok(progress.BUSY_STAGES.has(key) || key === 'checks', `${key} is a step that takes a while`);
    assert.ok(Number.isInteger(from) && Number.isInteger(to) && from > 0 && from < to, key);
  }
  // On an entry, beside the limit; never on one that waits on the person.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-progress.js'), 'utf8');
  assert.match(src, /const typical = state\.waitingOn \? null : typicalMinutes\(state\.stage, limit\);/);
  assert.match(src, /\.\.\.\(limit \? \{ stepTimeLimitMinutes: limit \} : \{\}\),\n\s+\.\.\.\(typical \? \{ typicalMinutes: typical \} : \{\}\),/);
});
