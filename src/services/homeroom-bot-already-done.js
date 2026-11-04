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

const TIMEOUT_MS = 60 * 1000;
const MAX_READS = 4;
const MAX_ROUNDS = MAX_READS + 2;
const CALL_TIMEOUT_MS = 20 * 1000;
const MAX_OUTPUT_TOKENS = 300;

const READ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_source',
      description: 'Files in the project\'s code on main, by folder or name.',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string' }, match: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source',
      description: 'Read one file of the project\'s code on main.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, fromLine: { type: 'integer' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

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
 * The default ask: one model request per round, on the DM's own model and
 * key. Resolves the provider's answer ({ content, toolCalls }). Never throws
 * for a missing key: the caller reads that as no answer.
 */
async function defaultAsk(pool, ctx, deps, messages, tools, toolChoice = null) {
  const mayor = require('./homeroom-bot-mayor');
  const config = ctx?.config || {};
  const settings = ctx?.settings || {};
  const apiKey = deps.apiKey || await mayor.botKey(pool, config, ctx?.bot?.id);
  if (!apiKey) throw new Error('no_key');
  const chat = deps.chat || require('./openrouter').streamChat;
  const model = require('./default-model').fromSettings(settings, config) || mayor.DEFAULT_MODEL;
  return chat({
    apiKey,
    baseUrl: config.openrouterApiBase,
    origin: config.openrouterOrigin,
    model,
    reasoning: 'low',
    messages,
    tools,
    toolChoice,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: CALL_TIMEOUT_MS,
    sessionId: `hrbot-already-${ctx?.user?.id || 0}-${Date.now().toString(36)}`,
  });
}

/** One project's look: resolves { done, sentence } or null. Never throws. */
async function one(pool, { user, app, title, details, deps, ctx }) {
  const mayor = require('./homeroom-bot-mayor');
  const ask = typeof deps.alreadyDoneAsk === 'function'
    ? deps.alreadyDoneAsk
    : (messages, tools, toolChoice) => defaultAsk(pool, ctx, deps, messages, tools, toolChoice);
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
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const res = await ask(messages, READ_TOOLS, null);
    const calls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
    if (!calls.length) return parseVerdict(res?.content);
    if (reads >= MAX_READS) return null;
    messages.push({
      role: 'assistant',
      content: res?.content || '',
      tool_calls: calls.map((c, i) => ({
        id: String(c.id || `look${round}${i}`), type: 'function',
        function: { name: String(c.function?.name || ''), arguments: String(c.function?.arguments || '{}') },
      })),
    });
    for (const call of calls) {
      const name = call?.function?.name;
      const args = (() => {
        try { return JSON.parse(String(call?.function?.arguments || '{}')) || {}; } catch { return {}; }
      })();
      let out;
      if (reads >= MAX_READS) {
        out = { error: 'Enough reading: answer with the JSON line now.' };
      } else if (name === 'list_source') {
        reads += 1;
        out = await mayor.listSource(pool, { user, project: app.slug, dir: args.dir, match: args.match, deps });
      } else if (name === 'read_source') {
        reads += 1;
        out = await mayor.readSource(pool, { user, project: app.slug, path: args.path, fromLine: args.fromLine, deps });
      } else {
        out = { error: 'There is no such tool. Use list_source or read_source.' };
      }
      messages.push({
        role: 'tool', tool_call_id: String(call.id || ''), content: JSON.stringify(out).slice(0, 24000),
      });
    }
  }
  return null;
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
 */
async function alreadyDoes(pool, { user, apps, title, details, deps = {}, ctx = null }) {
  const out = {};
  const list = Array.isArray(apps) ? apps.filter((a) => a && a.slug) : [];
  await Promise.all(list.map(async (app) => {
    try {
      out[app.slug] = await withTimeout(one(pool, { user, app, title, details, deps, ctx }), TIMEOUT_MS);
    } catch (err) {
      log.warn('homeroom-bot-already-done', 'Could not look at an app before drafting', { project: app.slug, err: err.message });
      out[app.slug] = null;
    }
  }));
  return out;
}

module.exports = { alreadyDoes, parseVerdict, TIMEOUT_MS, MAX_READS };
