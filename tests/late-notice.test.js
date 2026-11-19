'use strict';

// A notice owed as a machine's work is said when it is owed, never hours
// later (src/workflow/rules/late-notice.ts): work a rollback left queued runs
// on the next roll-forward. Each handler that says one skips it once it is
// late, before it reads or sends anything.
//
// Run with: node --test tests/late-notice.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

test('a notice owed hours ago is not said; one owed now, or before owedAt existed, is', async () => {
  const { lateNotice, LATE_NOTICE_MS } = await import('../src/workflow/rules/late-notice.ts');
  const now = Date.now();
  assert.equal(lateNotice(new Date(now - LATE_NOTICE_MS - 1000).toISOString(), now), true);
  assert.equal(lateNotice(new Date(now - 60 * 1000).toISOString(), now), false);
  assert.equal(lateNotice(undefined, now), false, 'work owed before the field existed runs');

  const pool = { query: async () => assert.fail('a late notice reads nothing') };
  const owedAt = new Date(now - 7 * 60 * 60 * 1000).toISOString();
  const { botDmServices } = await import('../src/workflow/bot-dm/services.ts');
  const { botChangeServices } = await import('../src/workflow/bot-change/services.ts');
  const { WORK: DM } = await import('../src/workflow/bot-dm/machine.ts');
  const { WORK: CHANGE } = await import('../src/workflow/bot-change/machine.ts');
  const run = (handlers, kind, input) => handlers[kind].run({ input, steps: () => ({}) });
  assert.deepEqual(await run(botDmServices({ config: {}, pool }), DM.mail, { userId: 1, messageId: 2, owedAt }), { skipped: 'late' });
  // A yes's line in its request's thread is no longer said (5 Nov 2026,
  // decision 6), and its work, retired, is no longer served (review C).
  assert.equal(Object.values(CHANGE).includes('bot.tellApproved'), false);
  assert.equal('bot.tellApproved' in botChangeServices({ pool }), false);
});
