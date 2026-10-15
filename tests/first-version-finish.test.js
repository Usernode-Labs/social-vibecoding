'use strict';

// 15 Oct 2026: Try again finishes a first version that was built.
//
// A first version built to the end whose proposal was refused stops "built
// but could not be proposed": its session paused, its branch pushed
// (homeroom-bot-live.js buildAndPropose). #5170 had its maker read "Tap Try
// again and I'll start over", and Try again did start over: the tap is the
// person's own "Try again" replying to that message, it reached the bot's
// chat model, the model started the request again (start_request), and the
// bot read it again, sent a new plan for Build it, and built it again in a
// new session, tens of minutes paid from the maker's allowance.
//
// Pinned here: the tap (or its words written under the message) is decided
// without the model (homeroom-bot-dm.js finishOnTryAgain); the session the
// build left is proposed as the build proposes one, once, however many taps
// (homeroom-bot.js finishBuiltFirstVersion), and recorded as the run's
// proposal; anything that makes that unsafe answers "not finished", which
// leaves the tap to the model and the start over; and each stop says what
// Try again will do. The same against the full schema, through a real tap:
// tests/first-version-finish-postgres.test.js.
//
// Run with: node --test tests/first-version-finish.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const words = require('../src/services/homeroom-bot-words');
const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
const progress = require('../src/services/homeroom-bot-progress');
const { OWN_WORK } = require('../src/services/lifecycle');
const { HOMEROOM_BOT_PROPOSAL } = require('../src/services/app-access');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UNPROPOSED = 'the change was built but could not be proposed: Server is restarting';
const SHA = 'a'.repeat(40);
const BOT = { id: 2, username: 'homeroom_bot' };
const ADA = { id: 7, username: 'ada' };

// A stopped first version's run as finishableRun reads it: built and not
// proposed, the newest look at its request, its session the bot's, paused.
const RUN = Object.freeze({
  id: 2027, app_id: 5, issue_number: 1, mode: 'live', verdict: 'ready', build_ok: false, build_error: UNPROPOSED,
  build_session_id: 88, build_branch: 'hrbot/club-votes-1', build_sha: SHA, build_commits: 3,
  build_spec_md: '# Club Votes', proposal_session_id: null, build_finish: null, finish_stale: false,
  newest_run_id: 2027, session_status: 'paused', session_user_id: BOT.id, session_branch: 'hrbot/club-votes-1',
  session_headless: false, own_proposal_status: null, proposal_status: null, request_closed: false, queued: false,
  maker_id: ADA.id, slug: 'club-votes', name: 'Club Votes', repo_url: 'https://github.com/usernode-bot/club-votes',
});

test('the words of Try again, tapped or typed, and nothing else', () => {
  for (const said of ['Try again', 'try again', 'Try again.', '  Try   AGAIN! ', 'try again!!']) {
    assert.equal(dm.saysTryAgain(said), true, said);
  }
  for (const said of ['', null, 'Can you try again?', 'try again from scratch', 'Start over', 'Try']) {
    assert.equal(dm.saysTryAgain(said), false, String(said));
  }
  // The words are the button's own.
  assert.deepEqual([...dm.TRY_AGAIN_WORDS], [dm.STUCK_ACTIONS.build_failed[0].label.toLowerCase()]);
});

test('whyNotFinish: only a first version of theirs, built and only not proposed, its session paused on its branch', () => {
  const why = (over = {}, who = ADA.id) => bot.whyNotFinish({ ...RUN, ...over }, { userId: who, botId: BOT.id });
  assert.equal(why(), null);
  assert.equal(progress.firstVersionStopped(RUN), true, 'what its screens say: Stopped');
  assert.equal(bot.whyNotFinish(null, { userId: ADA.id, botId: BOT.id }), 'no_run');
  assert.equal(why({}, 9), 'not_their_first_version', 'somebody else\'s');
  assert.equal(why({ maker_id: null }), 'not_their_first_version', 'a later change, not a first version');
  assert.equal(why({ newest_run_id: 2030 }), 'not_newest', 'a newer look at the request');
  // Any other stop starts over, as it says.
  for (const error of ['the build ran past its time limit', 'the build turn failed (exit 1)', 'the build produced no change to propose']) {
    assert.equal(why({ build_error: error }), 'not_unproposed', error);
  }
  assert.equal(why({ build_ok: null }), 'not_stopped', 'still under way');
  assert.equal(why({ build_ok: true }), 'not_stopped', 'built and proposed');
  assert.equal(why({ request_closed: true }), 'not_stopped', 'its request closed');
  assert.equal(why({ proposal_status: 'promoted' }), 'not_stopped', 'a proposal of it up');
  assert.equal(why({ build_error: 'skipped: the request already has a proposal (90)' }), 'not_stopped');
  assert.equal(why({ queued: true }), 'queued', 'a start over asked for already');
  for (const status of ['archived', 'active', 'promoted', null]) {
    assert.equal(why({ session_status: status }), 'session_gone', String(status));
  }
  assert.equal(why({ build_session_id: null }), 'session_gone');
  assert.equal(why({ session_user_id: 9 }), 'not_the_bots');
  assert.equal(why({ session_headless: true }), 'not_the_bots');
  assert.equal(why({ session_branch: null }), 'branch_moved');
  assert.equal(why({ session_branch: 'hrbot/other' }), 'branch_moved', 'not the branch the build pushed');
});

// ── finishBuiltFirstVersion ──────────────────────────────────────────────

// The database as the finish reads and writes it: the run (finishableRun),
// the session, and every write in order. Anything else answers no rows, as a
// post the fake does not keep does (live.post then says nothing).
function fakePool(run = RUN, { session = { status: 'paused', pr_number: null } } = {}) {
  const state = { run: { ...run }, session: { ...session }, writes: [] };
  return {
    state,
    async query(sql, params = []) {
      const text = String(sql);
      if (/AS newest_run_id/.test(text)) return { rows: [{ ...state.run }] };
      if (/FROM platform_settings WHERE key = ANY/.test(text)) return { rows: [{ key: 'homeroom_bot_mode', value: 'live' }] };
      if (/^SELECT status, pr_number FROM chat_sessions WHERE id = \$1/.test(text.trim())) return { rows: [{ ...state.session }] };
      if (/SET build_finish = jsonb_build_object\('at', NOW\(\), 'by'/.test(text)) {
        state.writes.push({ claim: params });
        const free = !state.run.build_finish || (!state.run.build_finish.outcome && state.run.finish_stale);
        if (state.run.build_ok !== false || state.run.proposal_session_id || !free) return { rows: [] };
        state.run.build_finish = { at: 'now', by: params[1], session_id: params[2] };
        state.run.finish_stale = false;
        return { rows: [{ id: state.run.id }] };
      }
      if (/build_finish = build_finish \|\| jsonb_build_object\('outcome'/.test(text)) {
        state.writes.push({ outcome: params[1] });
        state.run.build_finish = { ...state.run.build_finish, outcome: params[1] };
        return { rows: [] };
      }
      if (/SET build_ok = \$2, build_error = \$3/.test(text)) {
        state.writes.push({ recorded: { ok: params[1], error: params[2], sessionId: params[7] } });
        return { rows: [] };
      }
      if (/SET proposal_session_id = \$2 WHERE id = \$1 AND proposal_session_id IS NULL/.test(text)) {
        state.writes.push({ proposal: params[1] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

// The promote route as the bot reaches it in-process (live.promoteAsBot),
// answering `answer` and putting the session up when it is a 200.
function fakeRouter(pool, answer = { status: 200, body: { ok: true, prNumber: 12 } }) {
  const calls = [];
  return {
    calls,
    handle(req, res) {
      calls.push(req);
      if (answer.status === 200) Object.assign(pool.state.session, { status: 'promoted', pr_number: answer.body.prNumber });
      setImmediate(() => res.status(answer.status).json(answer.body));
    },
  };
}

function fakeGithub({ head = SHA, throws = null } = {}) {
  return {
    isEnabled: () => true,
    async getBranchSha(owner, repo, branch) {
      if (throws) throw throws;
      assert.deepEqual([owner, repo, branch], ['usernode-bot', 'club-votes', 'hrbot/club-votes-1']);
      return head;
    },
    async fetchPublicIssue() { return { issue: { state: 'open', updatedAt: '2026-10-15T09:00:00Z' } }; },
    async fetchIssueComments() { return { comments: [] }; },
    async createIssueComment() { return { id: 1 }; },
    async getBotUsername() { return 'usernode-bot'; },
  };
}

const WS = {
  async sendBotMessage() { return { id: 1 }; },
  async sendSystemMessage() { return { id: 1 }; },
  pushConversationEvent() { return 1; },
  pushToUser() { return 1; },
  pushIssueUpdate() {},
};

function finish(pool, { router = fakeRouter(pool), github = fakeGithub(), onProposed = null } = {}) {
  return bot.finishBuiltFirstVersion(pool, {}, {
    runId: RUN.id, user: ADA, bot: BOT, onProposed,
    deps: {
      github, votesRouter: router, ws: WS, domain: 'example.test', proposeRetryMs: [],
      threadContext: { loadIssueThread: async () => ({ messages: [] }), loadProposalThread: async () => ({ messages: [] }) },
    },
  });
}

test('Try again proposes the session the build left, once, as the build would, and records it as the run\'s proposal', async () => {
  const pool = fakePool();
  const router = fakeRouter(pool);
  const order = [];
  const out = await finish(pool, { router, onProposed: async (app) => { order.push(['said', app.slug, pool.state.writes.length]); } });
  assert.deepEqual(out, {
    ok: true, sessionId: 88, prNumber: 12,
    app: { id: 5, slug: 'club-votes', name: 'Club Votes', repo_url: 'https://github.com/usernode-bot/club-votes' },
  });
  // The build's own promote: that session, as the bot, past the drain guard.
  assert.equal(router.calls.length, 1);
  const [req] = router.calls;
  assert.equal(req.url, '/api/sessions/88/promote');
  assert.equal(req[OWN_WORK], true, 'a step of the bot\'s own work: a draining process lets it through');
  assert.equal(req.user[HOMEROOM_BOT_PROPOSAL], true);
  assert.equal(req.user.id, BOT.id);
  assert.equal(req.user.is_admin, false);
  // Claimed, proposed, and recorded as the build records a proposal.
  const { writes } = pool.state;
  assert.deepEqual(writes[0], { claim: [2027, ADA.id, 88, bot.FINISH_STALE_MINUTES] });
  assert.deepEqual(writes[1], { outcome: 'proposed' });
  const recorded = writes.find((w) => w.recorded).recorded;
  assert.equal(recorded.ok, true, 'build_ok: it is built and proposed now');
  assert.equal(recorded.sessionId, 88);
  assert.match(recorded.error, /^proposed on its maker's Try again after: the change was built but could not be proposed: Server is restarting$/,
    'why it was not proposed the first time stays on the run');
  assert.deepEqual(writes.find((w) => w.proposal), { proposal: 88 });
  // Said under the tap before the run's own news of it.
  assert.deepEqual(order, [['said', 'club-votes', 2]]);

  // A second tap, or one on another device, proposes nothing.
  pool.state.run.proposal_session_id = 88;
  pool.state.run.own_proposal_status = 'promoted';
  pool.state.run.build_ok = true;
  const again = await finish(pool, { router });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(router.calls.length, 1, 'proposed once');
});

test('two taps at once: one claims it and proposes, the other is told it is under way', async () => {
  const pool = fakePool();
  const router = fakeRouter(pool);
  const [a, b] = await Promise.all([finish(pool, { router }), finish(pool, { router })]);
  assert.equal(router.calls.length, 1, 'one proposal');
  assert.deepEqual([a, b].map((o) => [o.ok, !!o.already, o.sessionId || null]).sort(),
    [[true, false, 88], [true, true, null]]);
  // And a tap while the claim is fresh, before it has an outcome.
  const fresh = fakePool({ ...RUN, build_finish: { at: 'now', by: ADA.id, session_id: 88 } });
  const r = fakeRouter(fresh);
  assert.equal((await finish(fresh, { router: r })).already, true);
  assert.equal(r.calls.length, 0);
});

test('anything that makes it unsafe is not finished, so the tap goes on to the start over', async () => {
  const cases = [
    ['branch_gone', fakePool(), { github: fakeGithub({ throws: Object.assign(new Error('Not Found'), { status: 404 }) }) }],
    ['branch_moved', fakePool(), { github: fakeGithub({ head: 'b'.repeat(40) }) }],
    ['not_unproposed', fakePool({ ...RUN, build_error: 'the build ran past its time limit' }), {}],
    ['session_gone', fakePool({ ...RUN, session_status: 'archived' }), {}],
    ['not_newest', fakePool({ ...RUN, newest_run_id: 2031 }), {}],
    ['not_their_first_version', fakePool({ ...RUN, maker_id: 9 }), {}],
  ];
  for (const [why, pool, over] of cases) {
    const router = fakeRouter(pool);
    // eslint-disable-next-line no-await-in-loop
    const out = await finish(pool, { router, ...over });
    assert.equal(out.ok, false, why);
    assert.equal(out.why, why);
    assert.equal(router.calls.length, 0, `${why}: nothing proposed`);
    assert.equal(pool.state.writes.length, 0, `${why}: nothing claimed or recorded`);
  }
});

test('a proposal refused again is recorded on the claim, and every later tap starts over', async () => {
  const pool = fakePool();
  const router = fakeRouter(pool, { status: 409, body: { error: 'This proposal\'s pull request (#4) was closed on GitHub and couldn\'t be reopened.' } });
  let said = 0;
  const out = await finish(pool, { router, onProposed: async () => { said += 1; } });
  assert.equal(out.ok, false);
  assert.equal(out.why, 'refused');
  assert.match(out.detail, /closed on GitHub/);
  assert.equal(said, 0, 'nothing said under the tap: the start over says what happens');
  assert.deepEqual(pool.state.writes.map((w) => Object.keys(w)[0]), ['claim', 'outcome']);
  assert.deepEqual(pool.state.writes[1], { outcome: 'failed' });
  assert.equal(pool.state.writes.some((w) => w.recorded), false, 'the run still says it stopped');
  // Tapped again: not tried twice.
  const again = await finish(pool, { router });
  assert.deepEqual([again.ok, again.why], [false, 'finish_failed']);
  assert.equal(router.calls.length, 1);
});

test('a claim whose process died after it proposed is recorded on the next tap, never proposed twice', async () => {
  const pool = fakePool({
    ...RUN, build_finish: { at: 'long ago', by: ADA.id, session_id: 88 }, finish_stale: true, session_status: 'promoted',
  }, { session: { status: 'promoted', pr_number: 12 } });
  const router = fakeRouter(pool);
  const out = await finish(pool, { router });
  assert.deepEqual([out.ok, out.sessionId, out.prNumber], [true, 88, 12]);
  assert.equal(router.calls.length, 0, 'read back (proposedAlready), not promoted again');
  assert.equal(pool.state.writes.find((w) => w.recorded).recorded.ok, true);
});

// ── What each stop says Try again will do ───────────────────────────────

test('a first version built and not proposed says Try again finishes it; every other stop starts over', () => {
  const context = { appName: 'Club Votes', issueNumber: 1, issueTitle: 'First version of Club Votes', firstVersion: true, threaded: true };
  assert.equal(dm.dmText('build_failed', { reason: UNPROPOSED }, context),
    'I built Club Votes but couldn\'t put it live yet. Tap Try again and I\'ll finish it.');
  for (const reason of ['the build ran past its time limit', 'the build turn failed (exit 1)', 'the build could not start (x)',
    'the build produced no change to propose', 'the platform restarted in the middle of each of its last 2 tries at building this']) {
    assert.match(dm.dmText('build_failed', { reason }, context), / Tap Try again and I'll start over\.$/, reason);
  }
  // A later change keeps its words.
  assert.equal(dm.dmText('build_failed', { reason: UNPROPOSED }, { ...context, firstVersion: false }),
    'I built this, but I couldn\'t put it up for approval. Reply here and I\'ll try again.');
  // The push and the bell row.
  const push = (said, f) => notifyCopy.botMomentCopy(`hrbot2:${JSON.stringify({ m: 'stopped', s: said, a: 'Club Votes', ...(f ? { f: 1 } : {}) })}`).body;
  assert.equal(push('build_not_proposed', true), 'Stopped: I built your first version but couldn\'t put it live yet. Tap Try again and I\'ll finish it.');
  assert.equal(push('build_time', true), 'Stopped: it took longer than I\'m allowed. Tap Try again.');
  assert.equal(push('build_not_proposed', false), 'Stopped: I built it but couldn\'t put it up for a vote. Tap Try again.');
  // The request and its GitHub comment: a reply there starts it over, so it
  // says where Try again is; its Homeroom copy in the bot's own voice.
  const posted = live.buildFailedText(UNPROPOSED, { firstVersion: true });
  assert.equal(posted, 'Homeroom bot built this but couldn\'t put it live yet. '
    + 'Whoever asked for it can tap Try again in their chat with Homeroom bot, and it will finish it.');
  assert.equal(words.firstPerson(posted),
    'I built this but couldn\'t put it live yet. Whoever asked for it can tap Try again in their chat with me, and I\'ll finish it.');
  assert.equal(live.buildFailedText('the build ran past its time limit', { firstVersion: true }),
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed. Reply here (or on the GitHub issue) and it will try again.');
  // What the bot says under the tap.
  assert.equal(dm.FINISHING_TEXT, 'Finishing it now. I\'ll tell you here when it\'s ready to try.');
  assert.equal(dm.ALREADY_FINISHING_TEXT, 'I\'m already finishing it. I\'ll tell you here when it\'s ready to try.');
  for (const text of [dm.FINISHING_TEXT, dm.ALREADY_FINISHING_TEXT, posted]) assert.doesNotMatch(text, /—/);
});

test('the tap is decided before the model, and the model still has everything else written under the message', () => {
  const src = read('src/services/homeroom-bot-dm.js');
  const answer = src.slice(src.indexOf('async function answerUserMessage('), src.indexOf('// ── A request filed elsewhere'));
  const tap = answer.indexOf('if (target && target.kind === \'build_failed\' && saysTryAgain(message.content)) {');
  assert.ok(tap > 0, 'a quoted Try again under a stop');
  assert.ok(tap > answer.indexOf('const target = await quotedTarget(pool, user.id, quoted);'));
  assert.ok(tap < answer.indexOf('mayor.runDmTurn('), 'before the model');
  assert.match(answer, /const finished = await finishOnTryAgain\(pool, config, \{ bot, user, target, message, deps \}\);\n\s+if \(finished\) return finished;/,
    'and on to the model when it was not finished');
});
