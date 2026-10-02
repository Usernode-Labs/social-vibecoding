'use strict';

// #3654: a DM conversation with the Homeroom bot, simulated, for the benchmark.
//
// A DM task is a request whose triage asked its requester a question, and
// the requester's real answer, given in their DM with the bot
// (homeroom-bot-dm.js). The trial replays the conversation on a candidate
// model, with a SIMULATED requester who knows only that answer:
//
//   1. the triage runs on the frozen thread (services/bench/runner.js
//      triageStage, the real prompt and parser);
//   2. a question comes back with suggested answers to tap. The simulated
//      requester taps the one that matches their real answer (chooseReply's
//      deterministic rule below), or, when none does, replies "Something
//      else" in their own words: the real answer, verbatim;
//   3. that reply joins the thread exactly as a DM answer does in the live
//      bot: the bot's question as its post on the request
//      (live.questionText), then the person's answer as their message
//      (dm.mirroredText), and the seed is rebuilt from the thread
//      (sessions.buildHeadlessSeed);
//   4. again, until the bot stops asking or the turn limit (the script's
//      max_turns, 3 by default) is reached.
//
// Nothing is sent: no DM, no post, no thread message. The DM text the person
// would have seen (dm.dmText) is recorded in the conversation for the judge,
// and the real send paths are never called (tests/bench-dm-sim.test.js spies
// on them).
//
// Graded deterministically on the final verdict against the reference and
// on stopping inside the turn limit; a final plan goes to the judge, who
// reads whether it reflects what the person said.

const MATCH_THRESHOLD = 0.6;
const DEFAULT_MAX_TURNS = 3;
const MAX_TURNS = 5;
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'it', 'is', 'be', 'please', 'just', 'i', 'id', 'like', 'would', 'with']);

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter((w) => w.length >= 2 && !STOP_WORDS.has(w)));
}

/** Jaccard similarity of two texts' content words: 0 to 1. */
function similarity(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/**
 * What the simulated requester does with a question's suggested answers.
 * Deterministic:
 *   1. an answer that IS their real answer (or one of the script's accepted
 *      phrasings), ignoring case and punctuation, is tapped;
 *   2. otherwise the answer most similar to it (content-word Jaccard), when
 *      that similarity is at least MATCH_THRESHOLD; the first such answer on
 *      a tie, which is the bot's own default;
 *   3. otherwise "Something else", with the real answer in their own words.
 * Returns { kind: 'tap' | 'other', text, index, score }.
 */
function chooseReply({ answers = [], trueAnswer, accepted = [] }) {
  const targets = [trueAnswer, ...(accepted || [])].filter((t) => typeof t === 'string' && t.trim());
  const list = (answers || []).filter((a) => typeof a === 'string' && a.trim());
  for (let i = 0; i < list.length; i += 1) {
    if (targets.some((t) => normalize(t) === normalize(list[i]))) return { kind: 'tap', text: list[i], index: i, score: 1 };
  }
  let best = { index: -1, score: 0 };
  for (let i = 0; i < list.length; i += 1) {
    const score = Math.max(0, ...targets.map((t) => similarity(list[i], t)));
    if (score > best.score) best = { index: i, score };
  }
  if (best.index >= 0 && best.score >= MATCH_THRESHOLD) {
    return { kind: 'tap', text: list[best.index], index: best.index, score: best.score };
  }
  return { kind: 'other', text: String(trueAnswer || '').trim(), index: -1, score: best.score };
}

/** The trial: a conversation of triage turns. See the header. */
async function dmStage(ctx) {
  const { snapshot, task, repo, trial, deps, pool, config, user, app, model, title } = ctx;
  const runner = require('./runner');
  const live = require('../homeroom-bot-live');
  const dm = require('../homeroom-bot-dm');
  const buildSeed = deps.sessions?.buildHeadlessSeed || require('../../routes/sessions').buildHeadlessSeed;
  const script = task.reference?.dm_script || {};
  if (!script.true_answer) return { status: 'infra_fail', error: 'the DM task has no scripted answer' };
  if (!snapshot.thread?.issue) return { status: 'infra_fail', error: 'the snapshot has no frozen thread' };
  const maxTurns = Math.min(Math.max(Number(script.max_turns) || DEFAULT_MAX_TURNS, 1), MAX_TURNS);
  const thread = snapshot.thread;
  const requester = thread.issue.author || 'requester';
  const messages = [...(thread.threadMessages || [])];
  // Each reply lands after everything already in the thread.
  let clock = Math.max(Date.parse(thread.issue.updatedAt || '') || 0,
    ...messages.map((m) => Date.parse(m.createdAt) || 0), ...(thread.comments || []).map((c) => Date.parse(c.createdAt) || 0));
  const tick = () => { clock += 60_000; return new Date(clock || Date.now()).toISOString(); };

  const branch = runner.branchFor(trial);
  let base;
  try {
    base = await runner.pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await runner.openSession(pool, config, { user, app, model, branch, title });
  ctx.onSession?.(session.id);

  const conversation = [];
  const totals = { cost: null, input: null, output: null, raw: [] };
  const add = (key, v) => { if (Number.isFinite(v)) totals[key] = (totals[key] || 0) + v; };
  let last = null;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const seed = buildSeed(snapshot.issueNumber, thread.issue, thread.comments || [], thread.botLogin || null, messages);
    // eslint-disable-next-line no-await-in-loop
    last = await runner.triageStage({ ...ctx, seedOverride: seed, session, baseSha: base });
    add('cost', last.cost_usd);
    add('input', last.input_tokens);
    add('output', last.output_tokens);
    if (last.raw_output) totals.raw.push(`--- turn ${turn} ---\n${last.raw_output}`);
    if (last.status !== 'ok') break;
    const p = last.parsed;
    const entry = { turn, verdict: p.verdict };
    if (p.verdict !== 'question') {
      conversation.push(entry);
      break;
    }
    const reply = chooseReply({ answers: p.questionAnswers || [], trueAnswer: script.true_answer, accepted: script.accepted || [] });
    // What the person would have read in their DM, and what they did.
    entry.question = p.question;
    entry.answers = p.questionAnswers || [];
    entry.dm = dm.dmText('question', { question: p.question }, {
      appName: app.name || app.slug, issueNumber: snapshot.issueNumber, issueTitle: thread.issue.title,
      firstVersion: !!snapshot.extra?.firstVersion,
    });
    entry.reply = reply;
    conversation.push(entry);
    // The question as the bot posts it on the request, then the answer as
    // a DM answer is posted there: the thread the next turn reads.
    messages.push({ author: 'homeroom_bot', body: live.questionText(p), createdAt: tick() });
    messages.push({ author: requester, body: dm.mirroredText(reply.text, { question: true }), createdAt: tick() });
  }
  const parsed = last?.parsed || {};
  return {
    status: last?.status || 'infra_fail',
    error: last?.error || null,
    session_id: session.id,
    base_sha: base,
    build_branch: branch,
    cost_usd: totals.cost,
    input_tokens: totals.input,
    output_tokens: totals.output,
    raw_output: totals.raw.join('\n').slice(0, 20000),
    parsed: last?.status === 'ok' ? {
      verdict: parsed.verdict,
      buildNote: parsed.buildNote || null,
      question: parsed.question || null,
      reason: parsed.reason || null,
      conversation,
      turns: conversation.length,
      maxTurns,
      endedAsking: parsed.verdict === 'question',
    } : { conversation, turns: conversation.length, maxTurns },
  };
}

/**
 * A DM trial's grade: the final verdict against the reference's, and an end
 * inside the turn limit (still asking at the limit fails). A right `ready`
 * goes to the judge, who reads whether the plan reflects the answer. Pure.
 */
function dmGrade({ trial, reference }) {
  const p = trial.parsed || {};
  const ref = reference || {};
  const criteria = {
    stopped_asking: p.endedAsking === false,
    within_turns: Number(p.turns) <= Number(p.maxTurns || DEFAULT_MAX_TURNS),
    final_verdict_match: ref.verdict ? p.verdict === ref.verdict : null,
  };
  if (!criteria.stopped_asking) {
    return { pass: false, needsJudge: false, criteria, notes: [`still asking after ${p.turns} turn(s)`] };
  }
  if (!ref.verdict) return { pass: null, needsJudge: false, criteria, notes: ['the task has no reference verdict yet'] };
  if (!criteria.final_verdict_match) {
    return { pass: false, needsJudge: false, criteria, notes: [`ended ${p.verdict}, the reference says ${ref.verdict}`] };
  }
  return p.verdict === 'ready' ? { pass: null, needsJudge: true, criteria, notes: [] } : { pass: true, needsJudge: false, criteria, notes: [] };
}

module.exports = {
  MATCH_THRESHOLD,
  DEFAULT_MAX_TURNS,
  normalize,
  similarity,
  chooseReply,
  dmStage,
  dmGrade,
};
