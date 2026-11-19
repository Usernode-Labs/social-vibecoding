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
// Where a request's facts row puts it (services/work-state.js derive): its
// stage and its line's code.
const stage = (row) => {
  const s = require('../src/services/work-state').derive(row, { now: NOW });
  return [s.stage, s.line && s.line.code].filter(Boolean).join(' ');
};

test('#8 (WP3): a queue row from before its proposal merged is left over, not work in the queue', () => {
  const merged = { proposal_status: 'merged', merged_at: '2026-10-03T12:00:00Z', queue_id: 9, queue_reason: 'changed' };
  // Put there before the merge (a reply, a look again): nothing in progress,
  // where it used to read "waiting in the queue" in the header for days. A
  // request whose change is live reads Live whatever its queue row says (the
  // derive reads the merge first), so no surface draws the leftover.
  assert.equal(stage({ ...merged, enqueued_at: '2026-10-03T11:58:00Z' }), 'live');
  assert.equal(stage({ ...merged, enqueued_at: '2026-10-03T11:58:00Z', started_at: '2026-10-03T11:59:00Z' }), 'live',
    'nor being read');
  assert.equal(stage({ queue_id: 4, enqueued_at: ago(1), queue_position: 2 }), 'reading queued', 'an ordinary queue row is untouched');
  // B24: a request that closed with its change live has no work left, whenever its row was put there.
  const closedLive = { ...merged, request_closed: true, enqueued_at: '2026-10-03T12:05:00Z', started_at: '2026-10-03T12:06:00Z' };
  assert.equal(stage(closedLive), 'live', 'never "Reading the request" under its "It\'s live"');
});

test('#19 (WP3): how long a step usually takes is a fixed range, never past its time limit, and none for a wait', () => {
  assert.deepEqual(progress.typicalMinutes('building'), { from: 10, to: 25 });
  assert.deepEqual(progress.typicalMinutes('reading'), { from: 1, to: 3 });
  assert.deepEqual(progress.typicalMinutes('building', 20), { from: 10, to: 20 }, 'a build stopped at 20 minutes takes at most that');
  assert.deepEqual(progress.typicalMinutes('planning', 2), { from: 2, to: 2 });
  for (const stageName of ['queued', 'build_queued', 'question', 'vote', 'held', 'stalled', 'merging', 'followup_queued', 'fix_queued', 'checks_failed']) {
    assert.equal(progress.typicalMinutes(stageName), null, `${stageName} waits on somebody, and takes no usual time`);
  }
  // The steps the bot (or the setup it started) is at this minute.
  const busy = new Set(['setting_up', 'reading', 'revising', 'fixing', 'starting', 'planning', 'building', 'reviewing', 'proposing', 'merging']);
  for (const [key, [from, to]] of Object.entries(progress.TYPICAL_MINUTES)) {
    assert.ok(busy.has(key) || key === 'checks', `${key} is a step that takes a while`);
    assert.ok(Number.isInteger(from) && Number.isInteger(to) && from > 0 && from < to, key);
  }
  // 11 Nov 2026: on what the bot says of a request's stored work state
  // (homeroom-bot-mayor.js standingItem), while it is at it; never on one
  // that waits on somebody.
  const { standingItem } = require('../src/services/homeroom-bot-mayor');
  const item = (work) => standingItem({ app: { slug: 'a', name: 'A' }, issueNumber: 1, ...work });
  assert.deepEqual(item({ stage: 'building', line: null, whoseMove: 'bot' }).typicalMinutes, { from: 10, to: 25 });
  assert.deepEqual(item({ stage: 'building', line: { code: 'reviewing', round: 1, of: 2 }, whoseMove: 'bot' }).typicalMinutes, { from: 5, to: 25 });
  assert.equal(item({ stage: 'waiting_for_you', why: 'plan', whoseMove: 'requester' }).typicalMinutes, undefined);
  assert.equal(item({ stage: 'building', line: { code: 'queued', place: 2 }, whoseMove: 'bot' }).typicalMinutes, undefined, 'waiting its turn');
  assert.equal(item({ stage: 'up_for_vote', whoseMove: 'group' }).typicalMinutes, undefined);
});
