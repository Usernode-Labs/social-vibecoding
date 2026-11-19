'use strict';

// N5: a first version's App tab says "Ready to try" only when it is. Club
// Votes (newcomer run four, 12 October 2026) read Ready to try at 22:39:38
// with Try it, and about 90 s later "Testing it": its proposal's head was
// 83d22f05, which restart recovery had rolled the branch back to, while
// check_state held a pass of the fix 394d7494 it had rolled back (the
// promote route's recheck left that run to finish and be collected). The
// first checks of its own head then failed and a fix ran for 12 minutes.
//
// The App tab now reads what the DM's ready card goes out on: its request's
// stored work state (services/work-state.js, review A3, 19 Nov 2026), which
// says ready to try only once its checks passed ON ITS HEAD and its before &
// after shots settled, and never says ready while a follow-up is queued or
// running on it (homeroom-bot-progress.js firstVersionStage).
//
// Run with: node --test tests/first-version-ready.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../src/services/homeroom-bot-progress');
const dm = require('../src/services/homeroom-bot-dm');

const HEAD = '83d22f05'.padEnd(40, 'a');
const FIX = '394d7494'.padEnd(40, 'b');
const now = new Date('2026-10-12T20:39:38Z');
const open = {
  proposal_status: 'promoted', proposal_at: '2026-10-12T20:38:44Z', checks_at: '2026-10-12T20:39:30Z',
  first_version: true, mode: 'live', verdict: 'ready', build_ok: true, run_proposal: 31,
};

// ── The stage ────────────────────────────────────────────────────────────

test('a verdict about another commit than the head up for approval is not its own: its checks are still to come', () => {
  assert.equal(progress.checksOnHead({ reviewed_head_sha: HEAD, checks_sha: HEAD.toUpperCase() }), true, 'case does not matter');
  assert.equal(progress.checksOnHead({ reviewed_head_sha: HEAD, checks_sha: FIX }), false);
  assert.equal(progress.checksOnHead({ reviewed_head_sha: null, checks_sha: FIX }), true, 'nothing recorded: as before');
  assert.equal(progress.checksOnHead({ reviewed_head_sha: HEAD, checks_sha: null }), true);
  // An imported pull request is judged on its own head.
  assert.equal(progress.checksOnHead({ proposal_source: 'imported', imported_pr_head_sha: HEAD, reviewed_head_sha: FIX, checks_sha: HEAD }), true);
  assert.equal(progress.checksOnHead({ proposal_source: 'imported', imported_pr_head_sha: FIX, reviewed_head_sha: HEAD, checks_sha: HEAD }), false);

  // Club Votes at 22:39:38: promoted on 83d22f05, a pass of 394d7494 stored.
  const ws = require('../src/services/work-state');
  const at = (row) => { const s = ws.derive(row, { now }); return [s.stage, s.line && s.line.code].filter(Boolean).join(' '); };
  const stale = ws.derive({ ...open, check_state: 'passing', reviewed_head_sha: HEAD, checks_sha: FIX }, { now });
  assert.deepEqual([stale.stage, stale.line], ['checking', null]);
  assert.equal(progress.buildLineOf(progress.firstVersionStageOf(stale)), 'testing');
  // The same pass about its own head is the vote, as before (a first
  // version's: it goes live without one).
  const voteOf = (row) => at({ ...row, first_version: false });
  assert.equal(voteOf({ ...open, check_state: 'passing', reviewed_head_sha: HEAD, checks_sha: HEAD }), 'up_for_vote');
  assert.equal(voteOf({ ...open, check_state: 'skipped', reviewed_head_sha: HEAD, checks_sha: HEAD }), 'up_for_vote');
  // A failure about its own head is its failure. One about another commit
  // reads as checks still to come (decided 19 Nov 2026), on the change's
  // own row and so on its request's.
  assert.equal(voteOf({ ...open, check_state: 'failing', reviewed_head_sha: HEAD, checks_sha: HEAD }), 'checking checks_failing');
  assert.equal(voteOf({ ...open, check_state: 'failing', reviewed_head_sha: HEAD, checks_sha: FIX }), 'checking');
});

test('the per-request record reads which commit the verdict is about, and the head up for approval', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-progress'), 'utf8');
  assert.match(src, /cs\.checks_commit_sha AS checks_sha, cs\.reviewed_head_sha, cs\.imported_pr_head_sha,\s+cs\.source AS proposal_source,/);
});

test('the App tab\'s stage: ready to try only when ready, never while a follow-up is queued or running', () => {
  assert.equal(progress.firstVersionStage('vote', { ready: true }), 'vote');
  assert.equal(progress.firstVersionStage('vote', { ready: false }), 'checks', 'held on its shots, or a pass about another head');
  assert.equal(progress.firstVersionStage('vote'), 'checks');
  for (const stage of ['followup_queued', 'revising']) {
    assert.equal(progress.firstVersionStage(stage, { ready: true }), 'checks', stage);
  }
  for (const stage of ['fix_queued', 'fixing', 'checks', 'checks_failed', 'building', 'reviewing', 'merging', 'plan']) {
    assert.equal(progress.firstVersionStage(stage, { ready: false }), stage, stage);
  }
  assert.equal(progress.buildLineOf(progress.firstVersionStage('revising')), 'testing');
  assert.equal(progress.stepNumber(progress.firstVersionStage('followup_queued'), true), 5);
});

// 19 Nov 2026 (docs/plans/bot-one-model.md): the App tab draws its
// request's stored work state (services/work-state.js). Each point of the
// bot's work, as the work state stores it (tests/lib/work-at.js), is drawn
// at the step, build line and phase its name always had.
test('firstVersionStageOf: the App tab\'s stage is the work state\'s, at the step it always was', () => {
  const { workAt } = require('./lib/work-at');
  const facts = { first_version: true, review_round: 1, review_max_rounds: 3 };
  const stored = (step, row = facts) => (step.work || workAt(step.stage, row, { now: new Date(now) }));
  const same = (step, row) => {
    const mapped = progress.firstVersionStageOf(stored(step, row));
    const label = `${step.stage}${step.reply ? ' (reply)' : ''}${step.retry ? ' (retry)' : ''}`;
    assert.equal(progress.stepNumber(progress.firstVersionStage(mapped), true), progress.stepNumber(progress.firstVersionStage(step.stage), true), `${label}: its step`);
    for (const forCreator of [true, false]) {
      assert.equal(progress.buildLineOf(progress.firstVersionStage(mapped), { forCreator, question: true }),
        progress.buildLineOf(progress.firstVersionStage(step.stage), { forCreator, question: true }), `${label}: its line`);
    }
    assert.deepEqual(progress.firstVersionPhase({ stage: progress.firstVersionStage(mapped), since: '2026-10-12T20:00:00Z' }, facts),
      progress.firstVersionPhase({ stage: progress.firstVersionStage(step.stage), since: '2026-10-12T20:00:00Z' }, facts), `${label}: its phase`);
    return mapped;
  };
  for (const stage of ['reading', 'queued', 'on_hold', 'planning', 'plan', 'question', 'build_queued', 'starting', 'held',
    'reviewing', 'proposing', 'building', 'fixing', 'revising', 'followup_queued', 'fix_queued', 'checks', 'checks_failed', 'merging']) {
    same({ stage });
  }
  same({ stage: 'reading', reply: true, work: { stage: 'reading', line: { code: 'reply' } } });
  assert.equal(same({ stage: 'queued', retry: 'plan', work: { stage: 'planning', line: { code: 'retry_plan' } } }), 'queued',
    'a plan to write again waits to be read');
  // A first version whose checks passed goes live without a vote: Ready to
  // try, as before.
  assert.equal(same({ stage: 'vote' }, { ...facts, check_state: 'passing' }), 'vote');
  assert.equal(progress.firstVersionStageOf({ stage: 'up_for_vote' }), 'vote');
  assert.equal(progress.firstVersionStageOf({ stage: 'going_live', line: { code: 'github_checks' } }), 'merging');

  // Where the old decider disagreed, the work state wins: a build that never
  // started (stalled: step 3, Planning before), Homeroom bot's fixing of its
  // checks stopped (fix_stopped: no step at all before) and every other stop
  // are Stopped; a check being fixed for it (#6807: no step before) is its
  // checks.
  assert.equal(progress.firstVersionStageOf(stored({ stage: 'stalled' })), 'stopped');
  assert.equal(progress.firstVersionStageOf(stored({ stage: 'fix_stopped' })), 'stopped');
  assert.equal(progress.stepNumber('fix_stopped', true), null, 'it had no step before');
  assert.equal(progress.firstVersionStageOf(stored({ stage: 'flake_fixing' })), 'checks');
  assert.equal(progress.stepNumber('flake_fixing', true), null, 'nor had a check being fixed for it');
  for (const reason of ['build_failed', 'look_failed', 'change_closed']) {
    assert.equal(progress.firstVersionStageOf({ stage: 'stopped', reason }), 'stopped', reason);
  }
  // A person building it, a plan written with its requester.
  assert.equal(progress.firstVersionStageOf({ stage: 'building', line: { code: 'claimed', by: 'ada' } }), 'building');
  assert.equal(progress.firstVersionStageOf({ stage: 'planning', line: { code: 'planning_with_you' } }), 'queued');
  assert.equal(progress.firstVersionStageOf({ stage: 'planning', line: { code: 'planning_with_you', ready: true } }), 'build_queued');
  // No step of a first version on its way: live, closed, or handed back
  // for something the App tab has no line for.
  for (const work of [{ stage: 'live' }, { stage: 'closed' }, { stage: 'waiting_for_you', why: 'decide' },
    { stage: 'waiting_for_you', why: 'already_works' }, { stage: 'waiting_for_you', why: 'needs_detail' }, null, {}]) {
    assert.equal(progress.firstVersionStageOf(work), null, JSON.stringify(work));
  }
});

// ── The DM's rule, on the change's head ─────────────────────────────────

// Review A3 (19 Nov 2026): the DM card and the App tab no longer decide this
// themselves (changeReadiness is gone). Ready to try is the change's stored
// work state (services/work-state.js deriveChange, stored as work_states),
// which reads its verdict against its head. So the rule is checked where it
// lives: the derive, and changeReadyFacts reading what the derive stored.
const { storedChange, readsStoredChange } = require('./lib/stored-change');

function readyPool(row) {
  // What the derive stores for this change, from the same session columns.
  const stored = storedChange({ ...row, promoted_at: '2026-10-12T20:38:44Z', first_version: false }, { id: 31, appId: 5, now });
  return {
    stored,
    async query(sql) {
      if (/FROM chat_sessions WHERE id = \$1/.test(String(sql))) return { rows: [row] };
      if (readsStoredChange(sql)) return { rows: [stored] };
      return { rows: [] };
    },
  };
}

const session = (extra = {}) => ({
  status: 'promoted', check_state: 'passing', approval_epoch: 1, source: 'native',
  reviewed_head_sha: HEAD, checks_commit_sha: HEAD, checks_checked_at: now,
  shots_state: null, shots_run_id: null, shots_detail: null, shots_updated_at: null, ...extra,
});

test('changeReadyFacts: ready is the change\'s stored row, so a pass about another commit than its head is not ready', async () => {
  const ready = readyPool(session());
  assert.equal(ready.stored.stage, 'up_for_vote');
  assert.equal((await dm.changeReadyFacts(ready, 31)).ready, true);

  const stalePool = readyPool(session({ checks_commit_sha: FIX }));
  assert.deepEqual([stalePool.stored.stage, stalePool.stored.vote_open], ['checking', false], 'its own checks are still to come');
  const stale = await dm.changeReadyFacts(stalePool, 31);
  assert.equal(stale.ready, false);
  assert.equal(stale.waitingOnShots, false);
  assert.deepEqual(stale.broken, [], 'not ready: nothing of its shots is read either');
  assert.equal(stale.work.stage, 'checking', 'the card carries the row it read');

  assert.equal((await dm.changeReadyFacts(readyPool(session({ checks_commit_sha: HEAD.toUpperCase() })), 31)).ready, true);
  assert.equal((await dm.changeReadyFacts(readyPool(session({ reviewed_head_sha: null, checks_commit_sha: FIX })), 31)).ready, true,
    'no head recorded: as before');
  assert.equal((await dm.changeReadyFacts(readyPool(session({ source: 'imported', imported_pr_head_sha: FIX, checks_commit_sha: FIX })), 31)).ready, true,
    'an imported pull request is judged on its own head');

  // No stored row yet: not ready (a reader never makes one here).
  const none = {
    async query(sql) { return /FROM chat_sessions WHERE id = \$1/.test(String(sql)) ? { rows: [session()] } : { rows: [] }; },
  };
  assert.equal((await dm.changeReadyFacts(none, 31)).ready, false);
  // Its row says open for votes, but the change is no longer promoted (it is
  // being merged): not a card to send.
  const merging = readyPool(session());
  const mergingPool = { async query(sql) {
    if (/FROM chat_sessions WHERE id = \$1/.test(String(sql))) return { rows: [session({ status: 'merging' })] };
    return merging.query(sql);
  } };
  assert.equal((await dm.changeReadyFacts(mergingPool, 31)).ready, false);
});

// ── firstVersionState ────────────────────────────────────────────────────

const FV_ROW = {
  app_id: 5, user_id: 7, status: 'filed', issue_number: 1, merged: false,
  slug: 'club-votes', name: 'Club Votes', app_status: 'running', username: 'ada', conversation_id: 12,
};

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/FROM homeroom_bot_first_versions f/.test(String(sql))) return { rows: [FV_ROW] };
      return { rows: [] };
    },
  };
}

// 19 Nov 2026 (docs/plans/bot-one-model.md): its request's stored work
// state (services/work-state.js), the row the bot page reads, as each of the
// stages below reaches it: a first version whose checks passed is going
// live without a vote (`first_version`), merged and not live yet is going
// live, an update queued or under way is the bot's building, and a fix
// waiting its turn is its checks failing.
const WORK = Object.freeze({
  vote: { stage: 'going_live', line: { code: 'first_version' } },
  up_for_vote: { stage: 'up_for_vote' },
  followup_queued: { stage: 'building', line: { code: 'update_queued' } },
  revising: { stage: 'building', line: { code: 'revising' } },
  fix_queued: { stage: 'checking', line: { code: 'checks_failing', failing: 1 } },
  fixing: { stage: 'building', line: { code: 'fixing' } },
  merging: { stage: 'going_live' },
});

async function stateAt(stage, { proposal = 31, work = null } = {}) {
  const pool = fakePool();
  const state = await dm.firstVersionState(pool, 5, {
    viewerId: 7,
    workState: {
      async forItems() {
        return [{ kind: 'request', appId: 5, issueNumber: 1, why: null, reason: null, line: null, leadChangeId: proposal, ...(work || WORK[stage]) }];
      },
    },
    // Read no longer (review A3): a rule of its own could disagree with the row.
    readiness: async () => { throw new Error('the App tab reads its row, not a readiness rule'); },
  });
  return { state, pool };
}

test('firstVersionState: Ready to try when its request\'s stored row says so, else Testing it', async () => {
  // A first version whose change passed its checks on its head, its shots
  // settled: its request's row says it goes live without a vote.
  const ready = await stateAt('vote');
  assert.deepEqual([ready.state.step, ready.state.line, ready.state.ready], [6, 'ready', true]);

  // Its shots are still being taken, a pass about another head, a sync with
  // main: the row says it is checking, and so does the App tab.
  for (const work of [{ stage: 'checking', line: { code: 'shots' } }, { stage: 'checking', line: null },
    { stage: 'checking', line: { code: 'syncing' } }]) {
    const held = await stateAt('vote', { work });
    assert.deepEqual([held.state.step, held.state.line, held.state.ready], [5, 'testing', false], JSON.stringify(work));
    assert.equal(held.state.approval, undefined, 'nobody is asked to approve it yet');
  }
  // Up for a vote reads the same row (a first version never is: D1).
  assert.equal((await stateAt('up_for_vote')).state.ready, true);
  // With no change of its own there is nothing to try.
  const noChange = await stateAt('vote', { proposal: null });
  assert.equal(noChange.state.ready, false);
});

test('firstVersionState: never ready while a follow-up is queued or running on it', async () => {
  for (const stage of ['followup_queued', 'revising', 'fix_queued', 'fixing']) {
    const { state } = await stateAt(stage);
    assert.deepEqual([state.step, state.line, state.ready], [5, 'testing', false], stage);
    assert.equal(state.phase?.key, 'testing', `${stage}: its checks, by name`);
  }
  // Approved and going live is not a follow-up: it stays where it was.
  const merging = await stateAt('merging');
  assert.deepEqual([merging.state.step, merging.state.line, merging.state.ready], [6, 'ready', false]);
});

// Run five (13 Oct 2026, fix 7): at the merge (16:33:05) the App tab's card
// read every step back at "Plan written: now" for about 30 s, until live_at.
// Merged and not live yet is stage 'merging', which has no build phase, so
// the step list was drawn as if nothing were decided.
test('firstVersionState: going live keeps every step done, with Live under way', async () => {
  const { state } = await stateAt('merging');
  const by = Object.fromEntries(state.steps.map((s) => [s.key, s.state]));
  assert.deepEqual(by, { plan: 'done', screens: 'done', build: 'done', check: 'skipped', test: 'done', live: 'now' });
  assert.equal(state.phase, undefined, 'no build phase is named while it goes live');
});

test('firstVersionSteps: GOING_LIVE leaves nothing before Live to do, and keeps the minutes', () => {
  const steps = progress.firstVersionSteps(progress.GOING_LIVE, {
    made: '2026-10-13T15:41:31Z', decided: '2026-10-13T15:43:00Z', spec: '2026-10-13T15:50:00Z',
    review: '2026-10-13T16:05:00Z', proposal: '2026-10-13T16:20:00Z',
  });
  assert.deepEqual(steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'now']);
  assert.deepEqual(steps.slice(0, 4).map((s) => s.minutes), [1, 7, 15, 15]);
  assert.equal(steps[5].key, 'live');
  // Never a phase a screen names (build-line-words.js PHASE_WORDS).
  assert.equal(progress.FIRST_VERSION_PHASES.includes(progress.GOING_LIVE.key), false);
});
