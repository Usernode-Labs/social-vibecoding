'use strict';

// Homeroom bot's weekly budget, said as that to the people waiting on it
// (src/services/bot-pause-words.js), and the refusal that tells Homeroom it
// ran out (worker/agent-api-failure.js).
//
// On 14 Oct 2026 the bench key's weekly limit at OpenRouter was used up, and
// ten trials of run 196 failed on their first request. Each turn's whole
// final message was Claude Code's own notice, with its reading in front:
// "Failed to authenticate. API Error: 403 Key limit exceeded (weekly
// limit). ...". Homeroom read that as "the agent exited with code 1": the
// notice's lead was not one it knew, so the turn was never the provider's
// refusal, and never the outage. These tests enter with that turn as the
// worker hands it over, and with the outage it leaves in the one stored
// state, then read what each surface says to its own reader.
//
// Run with: node --test tests/bot-pause-words.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pause = require('../src/services/bot-pause-words');
const credit = require('../src/services/openrouter-credit');
const limits = require('../src/services/limits');
const turnFailure = require('../src/services/bot-turn-failure');
const shared = require('../worker/agent-api-failure');
const live = require('../src/services/homeroom-bot-live');
const mayor = require('../src/services/homeroom-bot-mayor');
const dm = require('../src/services/homeroom-bot-dm');
const words = require('../src/services/homeroom-bot-words');
const look = require('../src/services/homeroom-bot-thread-tools/look-into');
const investigate = require('../src/services/homeroom-bot-thread-tools/investigate');
const ws = require('../src/services/work-state');
const stages = require('../src/services/work-stages');
const core = require('../frontend/locales/en/core.json');

// ── The turn, as it really ended ────────────────────────────────────────

// Bench run 196, trial 1500: the turn's final message, word for word but for
// the key's own id in the link.
const NOTICE = 'Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit). '
  + 'Manage it using https://openrouter.ai/workspaces/default/keys/0000000000000000000000000000000000000000000000000000000000000000 '
  + '$100.03 of $100.00 used; resets 2026-10-19T00:00:00.000Z.';
// What the worker hands the host for it (services/worker.js: the stream's
// last text block is `lastResultText`; run-cc.sh said "claude exited
// non-zero (1); skipping commit/push").
const REFUSED_TURN = Object.freeze({
  agentHarness: 'claude', ccExit: 1, exitCode: 1, pushOk: false, sha: '', lastResultText: NOTICE, costUsd: 0,
});
// The same turn refused for the account's credit, as Claude Code writes a 402.
const NO_CREDIT_TURN = Object.freeze({
  agentHarness: 'claude', ccExit: 1, exitCode: 1, pushOk: false, sha: '', costUsd: 0,
  lastResultText: 'API Error: 402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
});

// A Friday in the week production's key was at $648 of $800.
const FRIDAY = new Date('2026-11-20T12:00:00Z');

/** The platform's settings, where the one stored outage lives; anything else is accepted. */
function settingsPool() {
  const settings = new Map();
  return {
    settings,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO platform_settings/.test(sql)) { settings.set(params[0], params[1]); return { rows: [] }; }
      if (/FROM platform_settings/.test(sql)) {
        const keys = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      return { rows: [] };
    },
  };
}

// No admin is told from a test, and no socket: the outage is what is read.
const QUIET = { staging: true, limitsChanged: () => {}, budgetNudge: async () => {} };

/** A database in which a turn has met `refusal`, through the real noteOutage. */
async function outageFrom(refusal) {
  const db = settingsPool();
  const noted = await credit.noteOutage(db, { words: refusal }, QUIET);
  return { db, noted };
}

// ── 2. The refusal is read where the runtime wrote it ───────────────────

test('Claude Code\'s notice for a refused key is the runtime\'s error notice, and the turn that ended on it is the budget outage', () => {
  // One definition, the worker's and the host's.
  assert.equal(require('../src/services/agent-result-text').agentApiFailure, shared.agentApiFailure);
  const read = shared.agentApiFailure(NOTICE);
  assert.equal(read.kind, 'api_error');
  assert.match(read.line, /^Failed to authenticate\. API Error: 403 Key limit exceeded \(weekly limit\)\. Manage it using https:\/\/openrouter\.ai\//);

  // The turn failed for what it said, not for "the agent exited with code 1".
  assert.match(live.failedClaudeTurn(REFUSED_TURN), /^it ended on an API error: Failed to authenticate\. API Error: 403 Key limit exceeded \(weekly limit\)/);
  // An outage, by the one test every turn is read with, and the budget's.
  assert.equal(credit.creditOut(REFUSED_TURN), true);
  assert.equal(credit.refusalCause(REFUSED_TURN), 'budget');
  assert.equal(turnFailure.sort({ turn: REFUSED_TURN }).class, 'credit');
  // As a build or a plan hands it on: a routed turn.
  assert.equal(live.turnCreditOut({ error: null, result: REFUSED_TURN }), true);
  assert.equal(credit.refusalCause({ error: null, result: REFUSED_TURN }), 'budget');
  // The 402 for credit is still credit's, and names no budget.
  assert.equal(credit.creditOut(NO_CREDIT_TURN), true);
  assert.equal(credit.refusalCause(NO_CREDIT_TURN), null);

  // The worker keeps nothing of such a turn, read from its journal's result.
  const journal = [
    '__USERNODE_PHASE__ claude (mode build)',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: NOTICE }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: NOTICE }),
  ].join('\n');
  assert.equal(shared.failedFinalResult(journal), 'claude ended on an API error');
});

test('only the runtime\'s notice is read, never a reply that quotes it', () => {
  const quoted = [
    // The model's own words about that very error.
    'The settings page now shows "Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit)" when the key is spent.',
    'I added a banner for a spent key.\n\nFailed to authenticate. API Error: 403 Key limit exceeded (weekly limit).',
    'Failed to authenticate the session in the app, so I fixed the cookie check. The API error is gone.',
    'Blocked: the page shows "Key limit exceeded" and needs a design first.',
  ];
  for (const text of quoted) {
    assert.equal(shared.agentApiFailure(text), null, text);
    const turn = { agentHarness: 'claude', ccExit: 0, exitCode: 0, lastResultText: text };
    assert.equal(live.failedClaudeTurn(turn), null, text);
    assert.equal(credit.creditOut(turn), false, text);
    assert.equal(credit.refusalCause(turn), null, text);
    assert.equal(pause.platformTurnRefused({ ...turn, exitCode: 1 }, 'shots'), null, text);
  }
  // A key refused for another reason failed the turn, and is no outage:
  // nothing comes back by waiting for Monday.
  const badKey = 'Failed to authenticate. API Error: 401 {"error":{"message":"No auth credentials found","code":401}}';
  assert.equal(shared.agentApiFailure(badKey).kind, 'api_error');
  assert.equal(credit.creditOut({ ...REFUSED_TURN, lastResultText: badKey }), false);
  assert.equal(credit.refusalCause({ ...REFUSED_TURN, lastResultText: badKey }), null);
});

// ── The day ─────────────────────────────────────────────────────────────

test('the day is the one the bot\'s week really turns on, which is the day the shared work line names', () => {
  assert.equal(pause.resetDay(FRIDAY), 'Monday');
  // From the boundary itself, whatever day it is asked on: Sunday night, and
  // the first minute of the new week.
  for (const at of ['2026-11-22T23:59:00Z', '2026-11-23T00:00:30Z', '2026-12-31T08:00:00Z']) {
    const now = new Date(at);
    const turns = new Date(limits.weeklyResetAt(now));
    assert.equal(turns.getUTCDay(), 1, 'the week turns on a Monday');
    assert.equal(pause.resetDay(now), 'Monday', at);
  }
  // The work line is one catalog text on every screen and takes no value, so
  // it writes the day (as "On hold until Monday" does).
  assert.match(core['work.line.budgetWait'].text, new RegExp(`\\b${pause.resetDay(FRIDAY)}\\b`));
});

// ── 3. Which cause, from the one stored outage ──────────────────────────

test('the stored outage says which figure ran out, and every surface asks it the same way', async () => {
  const budget = await outageFrom(NOTICE);
  assert.deepEqual([budget.noted.fresh, budget.noted.cause], [true, 'budget']);
  assert.equal(pause.isBudget(budget.noted), true);
  assert.equal(await pause.budgetNow(budget.db), true);
  assert.equal(await ws.creditWaitIsBudget(budget.db), true);

  const noCredit = await outageFrom(NO_CREDIT_TURN.lastResultText);
  assert.equal(noCredit.noted.cause, 'credit');
  assert.equal(pause.isBudget(noCredit.noted), false);
  assert.equal(await pause.budgetNow(noCredit.db), false);
  assert.equal(await ws.creditWaitIsBudget(noCredit.db), false);

  // No outage, a store that cannot be read, a stand-in that is not asked:
  // the credit wording, never a guess at the budget's.
  assert.equal(await pause.budgetNow(settingsPool()), false);
  assert.equal(await ws.creditWaitIsBudget(settingsPool()), false);
  assert.equal(await pause.budgetNow({ query: async () => { throw new Error('connection refused'); } }), false);
  assert.equal(await ws.creditWaitIsBudget({ query: async () => { throw new Error('connection refused'); } }), false);
  assert.equal(await pause.budgetNow(budget.db, { noteOutage: async () => null }), false, 'a stand-in with no state of its own is not asked');
  assert.equal(await pause.budgetNow({}, { creditState: async () => ({ out: true, cause: 'budget' }) }), true);
  assert.equal(await pause.budgetNow({}, { creditState: async () => ({ out: false, cause: 'budget' }) }), false);
  assert.equal(pause.isBudget(null), false);
});

// ── The chat with the bot ───────────────────────────────────────────────

test('the chat says the budget and the day, and keeps the credit line for credit', async () => {
  const t = () => ({ ctx: { userText: 'Can you add a dark mode?', deps: {} }, failures: [] });
  const { db } = await outageFrom(NOTICE);
  const out = await mayor.fallbackAnswer(db, t(), { error: 'credit_out', history: [] });
  assert.deepEqual({ fallback: out.fallback, defer: out.defer }, { fallback: 'credit', defer: true });
  assert.equal(out.text, 'I\'ve used up this week\'s building budget, so I couldn\'t answer yet. '
    + 'I\'ll answer this here on Monday, or sooner if an admin raises it; you don\'t need to send it again.');
  assert.doesNotMatch(out.text, /credit|admin has been told|—|–/);

  const other = await outageFrom(NO_CREDIT_TURN.lastResultText);
  const credited = await mayor.fallbackAnswer(other.db, t(), { error: 'credit_out', history: [] });
  assert.equal(credited.text, mayor.CREDIT_TEXT);

  // Its last try, and the one that owes earlier messages too.
  assert.equal(pause.chat.gaveUp('Monday'), 'This week\'s building budget is still used up, so I couldn\'t answer your message above yet. '
    + 'I\'ll answer it here on Monday, or sooner if an admin raises it.');
  assert.equal(pause.chat.gaveUpOwed('Monday'), 'This week\'s building budget is still used up, so I couldn\'t answer your message above, '
    + 'or the ones you sent before it that I said I\'d come back to. I\'ll answer them all here on Monday, or sooner if an admin raises it.');
});

// ── A project's thread, a look, a check-in, an update of a change ───────

test('a held thread question and a held look say the budget, and a held look is still a held look', async () => {
  // The thread's one line for an ask it keeps (#6922).
  assert.equal(pause.threadHeld('Monday'), 'I\'ve used up this week\'s building budget. I\'ll answer this here on Monday, or sooner if an admin raises it.');

  // The look's stored words: the row a held look is told by.
  const text = pause.lookHeldText('Plant Pal', 'Monday');
  assert.equal(text, 'I\'ve used up this week\'s building budget, so I couldn\'t look into it in Plant Pal yet. '
    + 'I\'ll run the look and post what I find here on Monday, or sooner if an admin raises it.');
  assert.doesNotMatch(text, /—|–|Ask me again/);
  assert.equal(look.isHeldLook({ state: 'failed', error: text }), true, 'kept and run again, as one held for credit is');
  assert.equal(look.isHeldLook({ state: 'failed', error: look.LOOK_HELD_TEXT('Plant Pal') }), true);
  assert.equal(look.isHeldLook({ state: 'done', error: text }), false);
  assert.equal(look.isHeldLook({ state: 'failed', error: 'The look did not finish because Homeroom had a problem on its side.' }), false);
  // What the chat's model is handed for it, and the one promise it may make.
  const held = look.heldNote('Plant Pal', { budget: true });
  assert.deepEqual({ ok: held.ok, held: held.held }, { ok: false, held: true });
  assert.match(held.error, /^I've used up this week's building budget, so I couldn't look into it in Plant Pal yet\./);
  assert.match(held.note, /once this week's building budget starts again, or an admin raises it/);
  assert.match(look.heldNote('Plant Pal').error, /^OpenRouter's credit ran out/);

  // Asked before the model is: the gate refuses for the cause that stands.
  const user = { id: 9, username: 'ada' };
  const app = { id: 3, slug: 'plant-pal', name: 'Plant Pal' };
  const settings = { mode: 'live', pausedApps: [] };
  const gate = (state) => look.gate({ query: async () => ({ rows: [] }) }, {
    user, app, settings, bot: { id: 7 },
    deps: { credit: { creditState: async () => state }, botSvc: { underWeeklyBudget: async () => ({ ok: true }), isPaused: () => false } },
  });
  const refused = await gate({ out: true, cause: 'budget' });
  assert.deepEqual({ code: refused.code, budget: refused.budget }, { code: 'credit', budget: true });
  assert.match(refused.error, /^Homeroom bot has used up this week's building budget, so it cannot .+\. Ask again on Monday, or sooner if an admin raises it\.$/);
  const credited = await gate({ out: true, cause: 'credit' });
  assert.deepEqual({ code: credited.code, budget: credited.budget }, { code: 'credit', budget: undefined });
  assert.match(credited.error, /out of building credit just now/);
  assert.equal(await gate({ out: false, cause: 'budget' }), null, 'nothing is refused once the key can spend again');

  // An investigation's check-in that did not run, and an update of somebody's change.
  assert.equal(investigate.SKIP_LINES.credit_budget, 'Skipped: Homeroom bot has used up this week\'s building budget.');
  assert.equal(investigate.SKIP_LINES.credit, 'Skipped: Homeroom bot is out of building credit right now.');
  assert.equal(pause.TAKEOVER_WHY, 'I\'ve used up this week\'s building budget, so nothing was changed');
});

// ── A build that stopped for it: the request, the chat, the bell ────────

test('a build that stopped for the budget says so on the request, in the requester\'s chat and on the push', () => {
  // The note on the request's page and its GitHub issue.
  const note = live.buildCreditText({ budget: true, now: FRIDAY });
  assert.equal(note, 'Homeroom bot has used up this week\'s building budget. '
    + 'It will pick this up again by itself on Monday, or sooner if an admin raises the budget.');
  assert.equal(live.buildCreditText({ budget: true, queued: false, now: FRIDAY }),
    'Homeroom bot has used up this week\'s building budget, and it could not keep this request\'s place in line. '
    + 'On Monday, or once an admin raises the budget, reply here and it will build this.');
  // Credit's own two are untouched.
  assert.match(live.buildCreditText(), /^Homeroom bot is out of building credit right now\. It will pick this up again by itself once credit is back\.$/);
  // Where Homeroom shows the note, the bot says it as itself.
  assert.equal(words.firstPerson(note),
    'I\'ve used up this week\'s building budget. I\'ll pick this up again by myself on Monday, or sooner if an admin raises it.');
  assert.equal(words.firstPerson(live.buildCreditText({ budget: true, queued: false, now: FRIDAY })),
    'I\'ve used up this week\'s building budget, and I could not keep this request\'s place in line. '
    + 'On Monday, or once an admin raises it, reply here and I\'ll build this.');

  // The requester's chat (the reason a credit wait is stored under), and the request's own voice.
  const reason = require('../src/services/bot-stop-cause').CREDIT_WAIT;
  assert.equal(dm.buildFailedCause(reason).cause, 'credit');
  assert.equal(dm.buildFailedWords(reason, 'Dark mode', 'me', { budget: true, now: FRIDAY }),
    'I used up this week\'s building budget while building Dark mode. I\'ll pick it up again by myself on Monday, or sooner if an admin raises it.');
  assert.equal(dm.buildFailedWords(reason, 'Dark mode', 'bot', { budget: true, now: FRIDAY }),
    'Homeroom bot used up this week\'s building budget while building Dark mode. '
    + 'It picks it up again by itself on Monday, or sooner if an admin raises the budget.');
  assert.match(dm.buildFailedWords(reason, 'Dark mode'), /^I ran out of building credit while building Dark mode\./);
  // A build that stopped for anything else is never said as the budget.
  assert.doesNotMatch(dm.buildFailedWords('the build produced no change to propose', 'Dark mode', 'me', { budget: true, now: FRIDAY }), /budget/);

  // Which words the bell and the push say.
  assert.equal(dm.saidOf('build_failed', { cause: 'credit', budget: true }), 'build_budget');
  assert.equal(dm.saidOf('build_failed', { cause: 'credit' }), 'build_credit');
  assert.equal(dm.saidOf('build_failed', { cause: 'time', budget: true }), dm.saidOf('build_failed', { cause: 'time' }));
  assert.equal(pause.notify('Monday'), 'Paused: I\'ve used up this week\'s building budget. I\'ll pick it up again on Monday.');
});

// ── The work state's line: every row, card and track ────────────────────

test('a request waiting for the budget says so on every screen that reads its row', () => {
  // The facts a credit wait leaves (#6867), stamped with the stored outage's
  // cause by the facts read (refresh).
  const facts = {
    app_id: 1, issue_number: 7, mode: 'live', verdict: 'ready', build_ok: null, run_proposal: null,
    run_at: '2026-11-20T11:00:00Z', build_session_id: 40, build_status: 'archived',
    queue_id: 9, enqueued_at: '2026-11-20T11:30:00Z', queue_reason: 'credit_wait', request_closed: false,
  };
  const work = ws.derive({ ...facts, credit_budget: true }, { now: FRIDAY });
  assert.deepEqual([work.stage, work.line], ['building', { code: 'credit_wait', budget: true }]);
  assert.deepEqual(stages.linePhraseOf(work.line), { id: 'core:work.line.budgetWait', values: {} });
  assert.equal(ws.says(work), `${core['work.stage.readyToBuild'].text} · ${core['work.line.budgetWait'].text}`);
  assert.equal(ws.says(work), 'Ready to build · Waiting until Monday: this week\'s building budget is used up. '
    + 'Homeroom bot picks this up again by itself, or sooner if an admin raises it.');
  assert.doesNotMatch(ws.says(work), /credit|—|–/);
  // It waits exactly as a credit wait does: the bot's, to pick up by itself.
  const credited = ws.derive(facts, { now: FRIDAY });
  assert.deepEqual(credited.line, { code: 'credit_wait' });
  assert.match(ws.says(credited), /^Ready to build · Waiting for building credit/);
  for (const key of ['stage', 'whoseMove', 'why', 'since']) assert.deepEqual(work[key], credited[key], key);
  assert.equal(ws.placeFor(work, { own: true }), ws.placeFor(credited, { own: true }));
  assert.equal(ws.busyNow(work), false);
  assert.deepEqual(ws.botWorkOf(work), ws.botWorkOf(credited));
  assert.equal(require('../src/services/homeroom-bot-chat').stageOf({ kind: 'filed' }, { work }), 'waiting');
  // The catalog's line has a description for its translators, and no em dash.
  assert.ok(core['work.line.budgetWait'].description.length > 40);

  // The read that stamps it asks only when a row waits, and only the stored outage.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'services', 'work-state.js'), 'utf8');
  assert.match(source, /rows\.some\(\(row\) => row\.queue_reason === 'credit_wait'\) && await creditWaitIsBudget\(db\)/);
});

// ── The other things the bot's key pays for ─────────────────────────────

test('before and after shots and Sync with main say the key was refused, for the cause that stands', () => {
  const shots = pause.platformTurnRefused(REFUSED_TURN, 'shots', { now: FRIDAY });
  assert.equal(shots, 'Homeroom\'s building budget for this week is used up, so the before and after shots could not be taken. '
    + 'They can be taken again on Monday, or once an admin raises the budget.');
  const sync = pause.platformTurnRefused(REFUSED_TURN, 'sync', { now: FRIDAY });
  assert.equal(sync, 'Homeroom\'s building budget for this week is used up, so the conflicts with main could not be resolved. '
    + 'Sync again on Monday, or once an admin raises the budget.');
  // The account's credit, in its own words.
  assert.equal(pause.platformTurnRefused(NO_CREDIT_TURN, 'shots'),
    'Homeroom\'s AI credit ran out, so the before and after shots could not be taken. They can be taken again once an admin adds credit.');
  assert.equal(pause.platformTurnRefused(NO_CREDIT_TURN, 'sync'),
    'Homeroom\'s AI credit ran out, so the conflicts with main could not be resolved. Sync again once an admin adds credit.');
  // A 402 met while the stored outage is the budget's (the key's limit and
  // the account's credit are refused in different words) is the budget's.
  assert.match(pause.platformTurnRefused(NO_CREDIT_TURN, 'sync', { budget: true, now: FRIDAY }), /^Homeroom's building budget for this week is used up/);
  // Any other failure keeps the words it had.
  for (const result of [
    { exitCode: -1, markerlessCause: 'oom_killed' },
    { fatalError: 'branch missing upstream: origin/dev/x-1', exitCode: 1 },
    { agentHarness: 'claude', ccExit: 1, exitCode: 1, lastResultText: 'API Error: 429 {"error":{"message":"Provider returned error","code":429}}' },
    null,
  ]) {
    assert.equal(pause.platformTurnRefused(result, 'shots', { budget: true }), null);
    assert.equal(pause.platformTurnRefused(result, 'sync', { budget: true }), null);
  }
  assert.equal(pause.platformTurnRefused(REFUSED_TURN, 'apps'), null, 'only the turns it has words for');
  for (const said of [shots, sync]) assert.doesNotMatch(said, /—|–|OpenRouter|403/);
});

test('a shots run and a sync whose turn was refused tell their reader so', async () => {
  // The shots agent, with a worker that hands back the refused turn.
  const agent = require('../src/services/shots-agent');
  const { db } = await outageFrom(NOTICE);
  const input = {
    pool: db, session: { id: 42, repo_url: 'https://github.com/acme/demo.git', branch_name: 'proposal' }, runId: 'b'.repeat(32),
    origins: { base: 'http://base:3000', head: 'http://head:3000' }, authTokens: {},
  };
  const failWith = async (result) => {
    const workerService = { ensureWorker: async () => ({}), execInWorker: async () => result };
    try { await agent.dispatch({ shots: {} }, input, { workerService }); } catch (error) { return error; }
    return assert.fail('the failed turn must throw');
  };
  const refused = await failWith(REFUSED_TURN);
  assert.equal(refused.code, 'shots_agent_failed');
  assert.match(refused.message, /^Homeroom's building budget for this week is used up, so the before and after shots could not be taken\. They can be taken again on Monday, or once an admin raises the budget\.$/);
  // What the change's page and the connector show for it.
  const orchestrator = require('../src/services/shots-orchestrator');
  assert.equal(orchestrator.agentErrorOf(refused).message, refused.message);
  // A turn that died for another reason says what it said before.
  assert.equal((await failWith({ exitCode: -1, markerlessCause: 'oom_killed' })).message, 'The shots agent stopped with an error before it finished.');

  // Sync with main asks the same helper for its turn's words.
  const sync = fs.readFileSync(path.join(ROOT, 'src', 'services', 'sync-main.js'), 'utf8');
  assert.match(sync, /pause\.platformTurnRefused\(result, 'sync', \{ budget: await pause\.budgetNow\(pool\) \}\)/);
  assert.match(sync, /new Error\(refused \|\| \(result\.fatalError/);
});
