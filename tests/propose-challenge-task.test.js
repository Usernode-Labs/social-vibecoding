'use strict';
// #3253: the "Propose an app change" onboarding challenge's task sentence
// hid the promote-only scoring rule — people built sessions and chats for
// days while the challenge stayed open, because the text never said the
// Propose (promote) click is what completes it. backfillProposeChallengeTask
// in src/db/migrate.js rewrites the template-24 task (and instance rows that
// still carry the old sentence verbatim); the scorer was already right and
// is untouched.
//
// Two layers, mirroring tests/proposal-issuer-assignment.test.js and
// tests/waitlist-country-migration.test.js:
//   1. Behavioural — invoke the real backfill against a mock pool, covering
//      the one-shot marker, the exact-match guard on the instance rows, the
//      already-correct no-op and the template-absent no-op.
//   2. Static — the pinned copy stays aligned with the promote-only scorer
//      (PROPOSAL_SENT_SQL reads only chat_sessions.promoted_at), so the
//      participant-facing sentence and the rule cannot drift apart again.
// No live Postgres is required or used in either layer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { backfillProposeChallengeTask } = require('../src/db/migrate');

const migrateSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8'
);
const scorerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src/services/topochain/challenge-scorer.js'), 'utf8'
);

const NEW_TASK = "Propose a change to an app and put it up for the group's vote — the Propose click is what completes this challenge. Sessions and chats on their own do not count.";

function mockPool(scripted) {
  const calls = [];
  const handlers = Array.isArray(scripted) ? scripted : [scripted];
  let next = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const handler = handlers[Math.min(next, handlers.length - 1)];
      next++;
      return typeof handler === 'function' ? handler({ sql, params }) : handler;
    },
  };
}

test('migration pins the new task sentence for template 24 in source', () => {
  assert.ok(
    migrateSrc.includes(NEW_TASK),
    'migrate.js carries the new task sentence as one constant'
  );
  const templateId = /PROPOSE_CHALLENGE_TEMPLATE_ID = (\d+)/.exec(migrateSrc);
  assert.ok(templateId, 'the propose challenge template id constant is declared');
  assert.equal(Number(templateId[1]), 24);
  // Both surfaces the spec names are updated: the template and the instance
  // rows that copied its task at creation time.
  assert.match(migrateSrc, /UPDATE challenge_templates[\s\S]*?SET task = \$2[\s\S]*?WHERE id = \$1 AND task = \$3/);
  assert.match(migrateSrc, /UPDATE challenges[\s\S]*?SET task = \$2[\s\S]*?WHERE challenge_template_id = \$1 AND task = \$3/);
  // The rewrite runs once per database (marker-guarded), so an organiser's
  // later edit of the template or an instance is never clobbered again.
  assert.match(migrateSrc, /platform_settings WHERE key = \$1/);
  assert.match(migrateSrc, /INSERT INTO platform_settings \(key, value, description\)/);
});

test('the sentence says what completes the challenge and what does not', () => {
  assert.match(NEW_TASK, /Propose a change to an app/);
  assert.match(NEW_TASK, /put it up for the group's vote/);
  assert.match(NEW_TASK, /the Propose click is what completes this challenge/);
  assert.match(NEW_TASK, /Sessions and chats on their own do not count/);
});

test('the pinned copy matches the promote-only scoring rule', () => {
  // The scorer reads only the promote time; nothing else credits the
  // challenge, so the new wording is truthful.
  const start = scorerSrc.indexOf('const PROPOSAL_SENT_SQL = `');
  assert.ok(start >= 0, 'PROPOSAL_SENT_SQL is declared in the scorer');
  const end = scorerSrc.indexOf('`;', start);
  assert.ok(end > start, 'the PROPOSAL_SENT_SQL block terminates');
  const block = scorerSrc.slice(start, end);
  assert.match(block, /cs\.promoted_at >= \$1/);
  assert.doesNotMatch(block, /created_at/,
    'the measure must not drift into crediting bare session creation');
});

test('behavioural: template 24 with the old text is rewritten, guarded exactly', async () => {
  const oldTask = 'Create 1 app session and chat about it.';
  const pool = mockPool([
    { rows: [] },                            // marker absent
    { rows: [{ task: oldTask }] },           // template read
    { rowCount: 1 },                          // template update
    { rowCount: 0 },                          // instance update
    { rows: [], rowCount: 0 },               // marker insert
  ]);
  const changed = await backfillProposeChallengeTask(pool);

  assert.equal(changed, 1);
  assert.equal(pool.calls.length, 5);
  const [marker, select, templateUpdate, instanceUpdate] = pool.calls;
  assert.match(marker.sql, /SELECT 1 FROM platform_settings WHERE key = \$1/);
  assert.match(select.sql, /SELECT task FROM challenge_templates WHERE id = \$1/);
  assert.deepEqual(select.params, [24]);
  assert.match(templateUpdate.sql, /UPDATE challenge_templates\s+SET task = \$2, updated_at = NOW\(\)\s+WHERE id = \$1 AND task = \$3/);
  assert.deepEqual(templateUpdate.params, [24, NEW_TASK, oldTask]);
  assert.match(instanceUpdate.sql, /UPDATE challenges\s+SET task = \$2, updated_at = NOW\(\)\s+WHERE challenge_template_id = \$1 AND task = \$3/);
  assert.deepEqual(instanceUpdate.params, [24, NEW_TASK, oldTask]);
});

test('behavioural: a template already carrying the new sentence is a no-op that still marks the run', async () => {
  const pool = mockPool([
    { rows: [] },                   // marker absent
    { rows: [{ task: NEW_TASK }] }, // template already correct
    { rows: [], rowCount: 0 },      // marker insert
  ]);
  assert.equal(await backfillProposeChallengeTask(pool), 0);
  assert.equal(pool.calls.length, 3, 'no UPDATE is issued once the sentence is in place');
  assert.match(pool.calls[2].sql, /INSERT INTO platform_settings/);
});

test('behavioural: after the one-shot marker, every later boot issues one read and nothing else', async () => {
  const pool = mockPool({ rows: [{ key: 1 }] });
  assert.equal(await backfillProposeChallengeTask(pool), 0);
  assert.equal(pool.calls.length, 1, 'the marker short-circuits before any template read');
});

test('behavioural: template 24 absent affects zero rows and exits cleanly', async () => {
  const pool = mockPool([
    { rows: [] },        // marker absent
    { rows: [] },        // template 24 not imported yet
  ]);
  assert.equal(await backfillProposeChallengeTask(pool), 0);
  assert.equal(pool.calls.length, 2, 'no UPDATE and no marker for a database without template 24');
  assert.doesNotMatch(pool.calls[1].sql, /UPDATE/);
});

test('behavioural: a database failure never aborts boot', async () => {
  const pool = {
    query: async () => { throw new Error('connection refused'); },
  };
  assert.equal(await backfillProposeChallengeTask(pool), 0);
});
