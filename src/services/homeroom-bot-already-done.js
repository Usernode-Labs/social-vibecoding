'use strict';

// #6305: before Homeroom bot drafts one request on several projects, it has
// a look at each app's code, the way the request's first read would, and
// says in one sentence whether the app already does what the request asks
// ("Game Corner already lets guests play today's board"). A row for such an
// app starts unticked and is skipped unless the person ticks it.
//
// One project's look is a short model loop with only list_source and
// read_source for that project: at most MAX_READS reads, then its answer as
// JSON { done, sentence }. Any project that times out, errors, or answers
// unclearly is null: the row stays ticked with no sentence. Never throws.

const log = require('./logger');
const turnEngine = require('./homeroom-bot-turn-engine');

const TIMEOUT_MS = 60 * 1000;
const MAX_READS = 4;
const MAX_ROUNDS = MAX_READS + 2;
const CALL_TIMEOUT_MS = 20 * 1000;
const MAX_OUTPUT_TOKENS = 300;

// The project's code on main, read by the one definition of each tool
// (src/services/bot-tools/source.js), as a project's own thread reads it.
const botTools = require('./bot-tools');
const READ_TOOLS = botTools.toolsFor(['list_source', 'read_source'], 'thread');

function systemPrompt() {
  return [
    'You are looking at one app\'s code before Homeroom files a request on it.',
    'Decide only this: does the app ALREADY do what the request asks, so the request would add nothing?',
    'Look at the files that would show it (screens, routes, the app\'s own description). Read at most four files.',
    'Be strict about "already": a stub, a placeholder, a signed-in-only screen or a plan is NOT already done.',
    'When you have decided, reply with one line of JSON and nothing else:',
    '{"done": true, "sentence": "<App Name> already <what it does, in plain words, at most 100 characters>"}',
    'or {"done": false}. The sentence never uses an em dash, never says "looks like", and never blames anything.',
    'If you cannot tell, answer {"done": false}.',
  ].join(' ');
}

function isDone(value) {
  return value && typeof value === 'object' && value.done === true
    && typeof value.sentence === 'string' && value.sentence.trim();
}

/** Pure: the model's answer as { done, sentence }, or null. */
function parseVerdict(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj?.done === false) return { done: false, sentence: null };
    if (!isDone(obj)) return null;
    return { done: true, sentence: obj.sentence.trim().slice(0, 200) };
  } catch {
    return null;
  }
}

/**
 * The turn a look runs on: the DM's own model and key, asked through
 * homeroom-bot-mayor.js askModel, so a request that fails is asked again on a
 * fresh route and every failure is kept, as in every turn of the bot's. It
 * has its own usage, and no working card: the look's JSON is never shown as
 * it is written. Throws 'no_key' with no key, which the caller reads as no
 * answer.
 */
async function lookTurn(pool, { user, ctx, deps }) {
  const mayor = require('./homeroom-bot-mayor');
  const config = ctx?.config || {};
  const settings = ctx?.settings || {};
  const apiKey = deps.apiKey || await mayor.botKey(pool, config, ctx?.bot?.id);
  if (!apiKey) throw new Error('no_key');
  return {
    config, user, settings, ctx,
    message: ctx?.turn?.message || { id: 0 },
    model: require('./default-model').fromSettings(settings, config) || mayor.DEFAULT_MODEL,
    chat: deps.chat || require('./openrouter').streamChat,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    apiKey,
    route: 1,
    startedMs: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    failures: [],
    avoid: [],
  };
}

/** Pure: a look's tool calls as the turn engine keeps them. */
function lookCalls(toolCalls, round) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((c, i) => ({
    id: String(c.id || `look${round - 1}${i}`), type: 'function',
    function: { name: String(c.function?.name || ''), arguments: String(c.function?.arguments || '{}') },
  }));
}

function lookArgs(raw) {
  try { return JSON.parse(String(raw || '{}')) || {}; } catch { return {}; }
}

/**
 * One project's look: resolves { done, sentence } or null. Never throws for
 * the model's sake. 5 Nov 2026: a profile on Homeroom bot's turn engine
 * (homeroom-bot-turn-engine.js), as the chat's and the voice's turns are.
 */
async function one(pool, { user, app, title, details, deps, ctx, t = null }) {
  const mayor = require('./homeroom-bot-mayor');
  const ask = typeof deps.alreadyDoneAsk === 'function'
    ? (o) => deps.alreadyDoneAsk(o.messages, o.tools, o.toolChoice)
    : (o) => mayor.askModel(t, {
      ...o,
      attempts: 2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
      sessionId: `hrbot-already-${user?.id || 0}-${Date.now().toString(36)}`,
    });
  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        `App: ${app.name || app.slug}`,
        `Request title: ${title}`,
        '',
        'Request details:',
        String(details || '').slice(0, 4000),
        '',
        'Read its code, then answer with the JSON line.',
      ].join('\n'),
    },
  ];
  let reads = 0;
  // undefined until it answers or gives up; null is "no clear answer".
  let verdict;
  await turnEngine.runRounds({ rounds: 0, limit: MAX_ROUNDS }, {
    messages, ids: null, normalize: lookCalls, parseArgs: lookArgs, resultChars: 24000,
    ask,
    where: (n) => `look${n}`,
    done: () => verdict !== undefined,
    offer: () => ({ tools: READ_TOOLS, toolChoice: null }),
    onWords: (res) => { verdict = parseVerdict(res?.content); return 'stop'; },
    // Asked to read again once its reading is spent: no answer, the row stays ticked.
    onCalls: () => {
      if (reads < MAX_READS) return undefined;
      verdict = null;
      return 'stop';
    },
    call: async (call, name, args) => {
      if (reads >= MAX_READS) return { error: 'Enough reading: answer with the JSON line now.' };
      if (name === 'list_source' || name === 'read_source') {
        reads += 1;
        return botTools.run(name, args, { pool, user, scope: 'thread', app, deps: { ...deps, mayor } });
      }
      return { error: 'There is no such tool. Use list_source or read_source.' };
    },
  });
  return verdict === undefined ? null : verdict;
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * #6305: { [slug]: { done, sentence } | null } for each app, each looked at
 * in parallel and capped at 60 s. Never throws.
 *
 * 5 Nov 2026: what a look costs is counted. A look that ends while the turn
 * that asked for it (ctx.turn, the chat's or the voice's) is still waiting
 * adds its usage and failures to that turn, which records and debits them
 * with its own; one that ends after this answered, past its cap, is debited
 * on its own, since that turn may already be recorded. Nothing is counted
 * twice, and nothing is left out.
 */
async function alreadyDoes(pool, { user, apps, title, details, deps = {}, ctx = null }) {
  const out = {};
  const list = Array.isArray(apps) ? apps.filter((a) => a && a.slug) : [];
  const parent = ctx?.turn && ctx.turn.usage ? ctx.turn : null;
  let answered = false;
  const settle = async (t) => {
    if (!t) return;
    if (parent && !answered) {
      parent.usage.inputTokens += t.usage.inputTokens;
      parent.usage.outputTokens += t.usage.outputTokens;
      parent.usage.costUsd += t.usage.costUsd;
      if (Array.isArray(parent.failures)) for (const f of t.failures) parent.failures.push(`already:${f}`.slice(0, 80));
      return;
    }
    await turnEngine.chargeTurn(pool, ctx?.bot?.id, t.usage.costUsd, {
      what: 'a look before filing', category: 'homeroom-bot-already-done', deps,
    });
  };
  await Promise.all(list.map(async (app) => {
    try {
      const t = typeof deps.alreadyDoneAsk === 'function' ? null : await lookTurn(pool, { user, ctx, deps });
      const look = one(pool, { user, app, title, details, deps, ctx, t });
      look.then(() => settle(t), () => settle(t)).catch(() => {});
      out[app.slug] = await withTimeout(look, TIMEOUT_MS);
    } catch (err) {
      log.warn('homeroom-bot-already-done', 'Could not look at an app before drafting', { project: app.slug, err: err.message });
      out[app.slug] = null;
    }
  }));
  answered = true;
  return out;
}

module.exports = { alreadyDoes, parseVerdict, TIMEOUT_MS, MAX_READS };
