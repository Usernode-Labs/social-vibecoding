'use strict';

// #3654: a simulated DM conversation for the benchmark. The simulated
// requester taps the suggested answer that matches their real one (a
// deterministic rule), or says "Something else" with their own words; the
// answer joins the thread exactly as a real DM answer is posted, and the
// triage reads it on the next turn; nothing is ever sent; and the grade is
// the final verdict inside the turn limit.

const test = require('node:test');
const assert = require('node:assert/strict');

const sim = require('../src/services/bench/dm-sim');
const runner = require('../src/services/bench/runner');
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const ws = require('../src/services/ws');
const githubModule = require('../src/services/github');

test('the reply rule: the same answer, an accepted phrasing, a close one, or Something else', () => {
  const answers = ['Dark blue', 'Green', 'Keep it as it is'];
  assert.deepEqual(sim.chooseReply({ answers, trueAnswer: 'dark BLUE.' }), { kind: 'tap', text: 'Dark blue', index: 0, score: 1 });
  assert.equal(sim.chooseReply({ answers, trueAnswer: 'Navy', accepted: ['green'] }).text, 'Green');
  const close = sim.chooseReply({ answers, trueAnswer: 'A dark blue please' });
  assert.equal(close.kind, 'tap');
  assert.equal(close.text, 'Dark blue');
  const other = sim.chooseReply({ answers, trueAnswer: 'Purple, like the logo' });
  assert.deepEqual({ kind: other.kind, text: other.text }, { kind: 'other', text: 'Purple, like the logo' });
  assert.equal(sim.chooseReply({ answers: [], trueAnswer: 'x y' }).kind, 'other');
  assert.ok(sim.similarity('keep it the same', 'keep it as it is') < sim.MATCH_THRESHOLD, 'one shared word is not a match');
  assert.equal(sim.chooseReply({ answers: ['Blue dark', 'Dark blue'], trueAnswer: 'dark blue color' }).index, 0, 'a tie goes to the first, the bot\'s default');
});

function spySideEffects(t) {
  const calls = [];
  const targets = [
    [live, ['post', 'postOnProposal', 'promoteAsBot']],
    [dm, ['sendDm', 'relayIssuePost', 'noteUserMessage', 'setQuestionState', 'closeOpenQuestions']],
    [ws, ['handleMessage', 'sendSystemMessage', 'pushConversationEvent']],
    [githubModule, ['createIssueComment']],
  ];
  for (const [mod, names] of targets) {
    for (const name of names) {
      const real = mod[name];
      mod[name] = () => { calls.push(name); return Promise.resolve(null); };
      t.after(() => { mod[name] = real; });
    }
  }
  return calls;
}

function harness(replies) {
  const prompts = [];
  let i = 0;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) return { rows: [{ id: 8001, branch_name: params[2], agent_model: params[4] }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = {
    isEnabled: () => true,
    async getBranchSha() { return 'f'.repeat(40); },
    async ensureBranchAtSha() {},
  };
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) { prompts.push(opts.prompt); const text = replies[Math.min(i, replies.length - 1)]; i += 1; return { lastResultText: text }; },
      async stopTurn() {},
    },
    sessions: {
      buildHeadlessSeed: require('../src/routes/sessions').buildHeadlessSeed,
      async runCodexAttemptLoop(args) { await args.resolveRuntime(); return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.01 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
  };
  return { pool, deps, prompts };
}

const QUESTION = '```json\n{"verdict":"question","question":"Which colour should the header be?","default":"Dark blue","blocker":"user_facing","why_default_fails":"taste","answers":["Dark blue","Green"]}\n```';
const READY = '```json\n{"verdict":"ready","determined":true,"build_note":"Make the header dark blue."}\n```';

function ctx(h, script) {
  return {
    pool: h.pool, config: {}, stage: 'dm', model: 'minimax/minimax-m3',
    task: { id: 1, stage: 'dm', reference: { verdict: 'ready', dm_script: script } },
    snapshot: {
      id: 1, issueNumber: 12, baseSha: 'b'.repeat(40), texts: { seed: 'unused' }, extra: {},
      thread: {
        issueNumber: 12,
        issue: { number: 12, title: 'Header colour', body: 'Change the header colour.', author: 'ann', updatedAt: '2026-09-30T10:00:00Z' },
        comments: [], threadMessages: [], botLogin: 'usernode-bot',
      },
    },
    user: { id: 501 }, app: { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/o/todo' },
    repo: { owner: 'o', repo: 'todo' }, trial: { id: 70, run_id: 4 }, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000 }, title: 'bench',
  };
}

test('a conversation: the bot asks, the person taps the matching answer, the next turn reads it, nothing is sent', async (t) => {
  const side = spySideEffects(t);
  const h = harness([QUESTION, READY]);
  const out = await runner.runStage(ctx(h, { true_answer: 'A dark blue please', max_turns: 3 }));
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.verdict, 'ready');
  assert.equal(out.parsed.turns, 2);
  assert.equal(out.parsed.endedAsking, false);
  assert.equal(out.parsed.conversation[0].reply.kind, 'tap');
  assert.equal(out.parsed.conversation[0].reply.text, 'Dark blue');
  assert.match(out.parsed.conversation[0].dm, /I have a question before I build this/, 'what the person would have read in the DM');
  assert.equal(h.prompts.length, 2);
  assert.doesNotMatch(h.prompts[0], /Answered in a chat with Homeroom bot/);
  assert.match(h.prompts[1], /\[ann, [^\]]*usernode thread\] Dark blue\n\n\(Answered in a chat with Homeroom bot\.\)/,
    'the answer joins the thread the way a real DM answer is posted');
  assert.match(h.prompts[1], /Homeroom bot has a question before it can build this:\n\nWhich colour should the header be\?/);
  assert.equal(out.cost_usd, 0.02, 'both turns are the trial\'s cost');
  assert.deepEqual(side, [], 'no DM sent, nothing posted on the request');
  assert.deepEqual(sim.dmGrade({ trial: { parsed: out.parsed }, reference: { verdict: 'ready' } }).needsJudge, true);
});

test('"Something else": no suggested answer matches, so the person writes their real answer', async (t) => {
  spySideEffects(t);
  const h = harness([QUESTION, READY]);
  const out = await runner.runStage(ctx(h, { true_answer: 'Purple, like our logo' }));
  assert.equal(out.parsed.conversation[0].reply.kind, 'other');
  assert.match(h.prompts[1], /Purple, like our logo\n\n\(Answered in a chat with Homeroom bot\.\)/);
});

test('a bot that keeps asking stops at the turn limit and fails', async (t) => {
  spySideEffects(t);
  const h = harness([QUESTION]);
  const out = await runner.runStage(ctx(h, { true_answer: 'Dark blue', max_turns: 2 }));
  assert.equal(out.status, 'ok');
  assert.equal(h.prompts.length, 2);
  assert.equal(out.parsed.endedAsking, true);
  const grade = sim.dmGrade({ trial: { parsed: out.parsed }, reference: { verdict: 'ready' } });
  assert.equal(grade.pass, false);
  assert.match(grade.notes[0], /still asking after 2/);
});

test('the DM grade: final verdict against the reference, a person verdict settled by the rule', () => {
  const p = (verdict, turns = 2) => ({ parsed: { verdict, turns, maxTurns: 3, endedAsking: verdict === 'question' } });
  assert.equal(sim.dmGrade({ trial: p('person'), reference: { verdict: 'person' } }).pass, true);
  assert.equal(sim.dmGrade({ trial: p('person'), reference: { verdict: 'ready' } }).pass, false);
  assert.equal(sim.dmGrade({ trial: p('ready'), reference: {} }).pass, null);
});

test('a DM task with no answer yet never runs: not applicable, never the model\'s failure', async (t) => {
  const side = spySideEffects(t);
  // A pending scripted task: the requester never answered, and the
  // labelling session has not written their answer yet.
  const h = harness([READY]);
  const pending = await runner.runStage(ctx(h, { true_answer: null, accepted: [], max_turns: 3, source: 'scripted', pending: true }));
  assert.equal(pending.status, 'not_applicable');
  assert.match(pending.error, /never answered, and the answer written for them is not there yet/);
  const missing = await runner.runStage({ ...ctx(h, {}), task: { id: 1, stage: 'dm', reference: {} } });
  assert.equal(missing.status, 'not_applicable', 'no answer at all is not the model\'s fault either');
  assert.equal(h.prompts.length, 0, 'no turn ran');
  assert.deepEqual(side, []);
  assert.equal(require('../src/services/bench/graders').finalVerdict({ status: 'not_applicable' }), 'excluded', 'kept out of accuracy');
  // The same rule the launcher applies up front.
  assert.match(sim.noAnswerReason({ stage: 'dm', reference: { dm_script: { true_answer: null, source: 'scripted' } } }), /label the task first/);
  assert.equal(sim.noAnswerReason({ stage: 'dm', reference: { dm_script: { true_answer: 'Green', source: 'scripted' } } }), null, 'once written, it runs');
  assert.equal(sim.noAnswerReason({ stage: 'triage', reference: {} }), null, 'only a DM task needs an answer');

  // Once written, a scripted answer runs like a real one.
  const h2 = harness([QUESTION, READY]);
  const scripted = await runner.runStage(ctx(h2, { true_answer: 'Green, please', accepted: [], max_turns: 3, source: 'scripted', scripted_by: 'opus' }));
  assert.equal(scripted.status, 'ok');
  assert.equal(scripted.parsed.conversation[0].reply.text, 'Green');
});
