'use strict';

// #6407: a change built from a person's plan is compared with that plan's
// after screen once its shots are taken and before anyone votes. The pure
// halves say what a plan draws, and read the reviewer's strict answer; the
// check itself answers 'unchecked' whenever it cannot get the plan, the
// stills or a readable answer, and never throws.

const test = require('node:test');
const assert = require('node:assert/strict');

const planMatch = require('../src/services/plan-match');

const PLAN = [
  '<article data-spec>',
  '<ol data-changes>',
  '<li data-change="1" data-steps="Messages → Homeroom bot → a request">Split Needs you and Waiting by day</li>',
  '</ol>',
  '<template data-screen data-size="desktop">',
  '<div data-side="before">BEFORE-ONLY-WORDS</div>',
  '<div data-side="after">',
  '<div data-variant="As it is now">History, one list per project</div>',
  '<div data-variant="With date headings" data-chosen>Needs you, TODAY and YESTERDAY</div>',
  '</div>',
  '</template>',
  '</article>',
].join('\n');

test('#6407: planLinesOf reads the plan\'s lines, its after words and its versions', () => {
  const read = planMatch.planLinesOf(PLAN);
  assert.equal(read.steps.length, 1);
  assert.match(read.steps[0].text, /Split Needs you and Waiting by day/);
  assert.match(read.steps[0].steps, /Homeroom bot/);
  assert.match(read.after, /Needs you, TODAY and YESTERDAY/);
  assert.doesNotMatch(read.after, /BEFORE-ONLY-WORDS/, 'the before side is not the after side');
  assert.deepEqual(read.variants, ['As it is now', 'With date headings']);
  assert.deepEqual(planMatch.planLinesOf('').steps, []);
});

test('#6407: parsePlanMatch takes the strict answer and nothing else', () => {
  assert.deepEqual(planMatch.parsePlanMatch('{"onPlan": true, "misses": ["ignored"]}'), { onPlan: true, misses: [] });
  assert.deepEqual(
    planMatch.parsePlanMatch('```json\n{"onPlan": false, "misses": ["The plan splits Needs you by day.", "Not X."]}\n```'),
    { onPlan: false, misses: ['The plan splits Needs you by day.', 'Not X.'] },
  );
  assert.equal(planMatch.parsePlanMatch('It looks fine to me.'), null);
  assert.equal(planMatch.parsePlanMatch('{"onPlan": "yes"}'), null);
  const many = planMatch.parsePlanMatch(JSON.stringify({ onPlan: false, misses: ['a', 'b', 'c', 'd'] }));
  assert.equal(many.misses.length, 3, 'at most three misses');
});

test('#6407: checkAgainstPlan is unchecked without a plan, and never throws', async () => {
  const empty = { query: async () => ({ rows: [{ from_id: null }] }) };
  const none = await planMatch.checkAgainstPlan(empty, {}, { sessionId: 1, head: 'a'.repeat(40) });
  assert.equal(none.state, 'unchecked');
  assert.deepEqual(none.misses, []);

  const broken = { query: async () => { throw new Error('db is down'); } };
  const out = await planMatch.checkAgainstPlan(broken, {}, { sessionId: 2 });
  assert.equal(out.state, 'unchecked', 'a failure never blocks the change');
});

test('#6407: checkAgainstPlan is unchecked when the plan\'s stills cannot be read', async () => {
  const pool = {
    query: async (sql) => {
      if (/built_from_session_id/.test(sql)) {
        return { rows: [{
          from_id: 44, from_version: 3, shots_run_id: 'f'.repeat(32),
          shots_detail: { headSha: 'a'.repeat(40), claims: [{ id: 'split', claim: 'Needs you is split by day' }] },
          plan_md: 'A plan', plan_html: PLAN, variant: 'With date headings',
        }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    botConfigs: { currentVersion: async () => ({ recipe: { models: { spec: 'vendor/model' } } }) },
    bot: { id: 7, username: 'homeroom_bot' },
  };
  const out = await planMatch.checkAgainstPlan(pool, {}, { sessionId: 3, head: 'a'.repeat(40), deps });
  assert.equal(out.state, 'unchecked');
});
