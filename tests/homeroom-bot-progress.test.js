'use strict';

// #3685: how far along the Homeroom bot is, in the parts that need no
// database: which stage each record means, which step that is, and the
// words the DM says when it answers from the records alone. The queries run
// against PostgreSQL in tests/homeroom-bot-mayor-postgres.test.js.
//
// Run with: node --test tests/homeroom-bot-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../src/services/homeroom-bot-progress');

const NOW = new Date('2026-10-02T16:04:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
const stage = (row) => progress.stageOf(row, { now: NOW });

test('the steps a request and a first version go through, and which step each stage is', () => {
  assert.deepEqual(progress.FIRST_VERSION_STEPS, [
    'Set up the project', 'Read the description', 'Write a plan', 'Build it', 'Run its checks', 'Group vote', 'Live',
  ]);
  assert.deepEqual(progress.REQUEST_STEPS, progress.FIRST_VERSION_STEPS.slice(1).map((s) => s.replace('description', 'request')));
  assert.equal(progress.stepNumber('setting_up', true), 1);
  assert.equal(progress.stepNumber('reading', true), 2);
  assert.equal(progress.stepNumber('reading', false), 1);
  assert.equal(progress.stepNumber('planning', false), 2);
  assert.equal(progress.stepNumber('building', true), 4);
  assert.equal(progress.stepNumber('checks', false), 4);
  assert.equal(progress.stepNumber('vote', false), 5);
  assert.equal(progress.stepNumber('nonsense', false), null);
});

test('a request being read, asked about, or waiting in the queue', () => {
  assert.deepEqual(stage({ started_at: ago(3) }), {
    stage: 'reading', since: ago(3), doing: 'reading the request to decide whether to ask a question or build it', limit: 'reading',
  });
  assert.match(stage({ started_at: ago(3), first_version: true }).doing, /^reading the description/);
  assert.deepEqual(stage({ question_at: ago(9) }), {
    stage: 'question', since: ago(9), doing: 'waiting for an answer to the question asked', waitingOn: 'them',
  });
  assert.equal(stage({ queue_id: 4, enqueued_at: ago(1), queue_position: 2 }).doing, 'waiting in the queue (number 2) to be read');
  assert.equal(stage({ verdict: 'person', mode: 'live' }), null, 'nothing in progress');
});

test('a build in progress is read from its run and its session, never the queue', () => {
  const ready = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(5) };
  assert.equal(stage({ ...ready }).stage, 'starting', 'a ready verdict with no session yet');
  assert.equal(stage({ ...ready, run_at: ago(40) }).stage, 'stalled', 'and past the grace, it says nothing is recorded');
  assert.match(stage({ ...ready, run_at: ago(40) }).doing, /nothing about the build has been recorded since/);
  const planning = stage({ ...ready, build_session_id: 7, build_status: 'active', build_started_at: ago(4) });
  assert.deepEqual(planning, { stage: 'planning', since: ago(4), doing: 'writing the plan for the build', limit: 'plan' });
  const building = stage({ ...ready, build_session_id: 7, build_status: 'active', build_started_at: ago(12), spec_at: ago(6) });
  assert.deepEqual(building, { stage: 'building', since: ago(6), doing: 'building it', limit: 'build' });
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'active', build_turn_mode: 'build', build_turn_at: ago(2) }).stage,
    'building', 'a build whose plan failed is still a build');
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'paused', spec_at: ago(30) }).stage, 'proposing');
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'archived' }), null, 'a failed attempt is not in progress');
  assert.equal(stage({ ...ready, cap_suppressed: 'proposals_per_app' }).stage, 'held');
  assert.equal(stage({ ...ready, mode: 'shadow', build_session_id: 7, build_status: 'active' }), null,
    'a shadow build is never their work');
  assert.equal(stage({ ...ready, build_ok: false }), null);
  assert.equal(stage({ ...ready, started_at: ago(1) }).stage, 'reading', 'a new look comes first');
});

test('a proposal: its checks, then the group\'s vote', () => {
  const open = { proposal_status: 'promoted', proposal_at: ago(20) };
  const running = stage({ ...open, check_state: 'pending', check_phase: 'testing', checks_at: ago(8),
    checks_progress: { ran: 120, expected: 338, failed: 0 } });
  assert.equal(running.stage, 'checks');
  assert.equal(running.doing, 'its proposal is up, and its checks are running: 120 of 338 done, 0 failed so far');
  assert.equal(running.since, ago(8));
  assert.equal(stage({ ...open, check_state: 'pending', check_phase: 'building' }).doing,
    'its proposal is up, and its checks are running: building the preview first');
  const failing = stage({ ...open, check_state: 'failing', test_results: [{ status: 'pass' }, { status: 'fail' }, { status: 'fail' }] });
  assert.equal(failing.stage, 'checks_failed');
  assert.equal(failing.doing, 'its proposal is up, and its checks failed (2 checks did not pass)');
  assert.deepEqual(stage({ ...open, check_state: 'passing' }), {
    stage: 'vote', since: ago(20), doing: 'its proposal is up for the group\'s vote', waitingOn: 'the group',
  });
  assert.equal(stage({ ...open, check_state: 'skipped' }).stage, 'vote');
  assert.equal(stage({ ...open, check_state: 'failing', started_at: ago(1), queue_reason: 'checks_failing' }).stage, 'fixing');
  assert.equal(stage({ ...open, started_at: ago(1), queue_reason: 'changed' }).stage, 'revising');
  assert.equal(stage({ ...open, check_state: 'passing', question_at: ago(2) }).stage, 'question');
  assert.equal(stage({ proposal_status: 'merging', proposal_at: ago(2) }).stage, 'merging');
  assert.equal(stage({ proposal_status: 'merged' }), null, 'live is finished, not in progress');
  assert.equal(progress.outcomeOf({ proposal_status: 'merged' }), 'approved and live');
  assert.equal(progress.outcomeOf({ mode: 'live', build_ok: false, build_error: 'the build ran past its time limit' }),
    'the build did not succeed: the build ran past its time limit');
  assert.equal(progress.outcomeOf({ mode: 'shadow', verdict: 'person' }), null);
});

test('a first version\'s setup: which part runs, when this process knows', () => {
  const row = { app_status: 'creating', app_created_at: ago(2), created_at: ago(2) };
  assert.deepEqual(progress.setupOf(row, { phase: { phase: 'repository' } }), {
    stage: 'setting_up', since: ago(2), doing: 'setting up the project: part 2 of 4, making its code repository',
  });
  assert.equal(progress.setupOf(row).doing, 'setting up the project', 'no part is invented when it is not known here');
  assert.equal(progress.setupOf({ ...row, app_status: 'running' }).doing,
    'the project is set up; its first request is being filed to start on it');
  assert.equal(progress.setupOf({ ...row, app_status: 'awaiting_secrets' }).waitingOn, 'them');
  assert.ok(progress.setupOf({ ...row, app_status: 'error' }).outcome);
  assert.ok(progress.setupOf({ ...row, status: 'failed' }).outcome);
  assert.deepEqual(Object.keys(progress.SETUP_PARTS), require('../src/services/app-creation-phase').PHASES,
    'every part of the setup has words, in its order');
});

test('links go to the platform\'s own pages, and only when there is a domain', () => {
  assert.deepEqual(progress.links('app.example.com', { slug: 'ear-trainer', number: 1, proposal: 42 }), {
    project: 'https://app.example.com/#app/ear-trainer',
    request: 'https://app.example.com/#app/ear-trainer/dev/issues/1',
    proposal: 'https://app.example.com/#app/ear-trainer/dev/proposals/42',
  });
  assert.deepEqual(progress.links(null, { slug: 'ear-trainer' }), {});
});

test('the records, said in plain words when the model could not answer', () => {
  const text = progress.progressText({
    botIsOn: true,
    rightNow: [
      { projectName: 'Ear Trainer', title: 'First version', step: 1, of: 7, doing: 'setting up the project: part 2 of 4, making its code repository', minutesSoFar: 2 },
      { projectName: 'Seed swap', number: 3, title: 'Sort by date', step: 3, of: 6, doing: 'building it', minutesSoFar: 1 },
      { projectName: 'Note board', number: 5, title: 'Pin notes', step: 5, of: 6, doing: 'its proposal is up for the group\'s vote', minutesSoFar: 0 },
    ],
  });
  assert.equal(text, [
    'Here is where things stand, from my records:',
    '',
    '- Ear Trainer, its first version: step 1 of 7, setting up the project: part 2 of 4, making its code repository, for 2 minutes so far.',
    '- Seed swap request #3 (Sort by date): step 3 of 6, building it, for 1 minute so far.',
    '- Note board request #5 (Pin notes): step 5 of 6, its proposal is up for the group\'s vote, for under a minute so far.',
  ].join('\n'));
  assert.match(progress.progressText({ botIsOn: false, rightNow: [{ projectName: 'A', number: 1, doing: 'x' }] }),
    /I'm switched off right now, so this waits until I'm back on\.$/);
  assert.equal(progress.progressText({ rightNow: [] }), 'I\'m not working on anything for you right now.');
  assert.equal(progress.progressText({ rightNow: [], finishedLately: [{ projectName: 'Seed swap', number: 3, outcome: 'approved and live' }] }),
    'I\'m not working on anything for you right now. Most recently, Seed swap request #3: approved and live.');
  assert.doesNotMatch(text, /—/, 'no em dash in what the bot says');
});
