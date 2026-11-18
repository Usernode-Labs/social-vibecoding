'use strict';

// The layout pass (18 Nov 2026): a long reply of Homeroom bot's, laid out
// from its final words.
//
// Production, 6 to 18 Nov: 56 of 74 chat replies were longer than two short
// lines and only 11 carried a laid-out copy (11% of the voice's long replies
// in a project's threads). The model often wrote none, and the copy it did
// write was dropped whenever the words sent were not exactly its reply's:
// words written beside a call, a repeat or a draft's echo taken out, a claim
// cut. Now, once every one of those has happened, a long reply with no
// usable copy is laid out by one more request to the same cheap model, from
// the words that are sent and nothing else, and the copy is held to the same
// words test as the model's own (homeroom-bot-html.js matchesWords). So it
// can never say more or less than the words, and what the claims checker cut
// is never in it.
//
// BOUNDED. One request, no tools but its answer, no reasoning, temperature 0,
// an output ceiling sized from the words (layoutTokens), and a time limit.
// The reply waits for it WAIT_MS at most: a copy that comes later is put on
// the message when it lands (the chat redraws it in place), and one that
// fails, is late past TIMEOUT_MS, or does not match the words leaves the
// words as they are. Its cost is the turn's, counted where the turn's is.

const replyHtml = require('./homeroom-bot-html');

// How long the reply waits for its copy before it goes as words.
const WAIT_MS = 3500;
// How long the copy may take at all; past it, the words stand.
const TIMEOUT_MS = 30000;
// The copy's output ceiling: room for the markup around the words, and no
// more than a long answer's table needs.
const MIN_TOKENS = 500;
const MAX_TOKENS = 3000;
// A heading or two of its own, never a number (matchesWords).
const LAYOUT_NOVEL_WORDS = 6;

const LAYOUT_TOOL = 'layout';

/** Pure: the output ceiling for laying out `text`. */
function layoutTokens(text) {
  const n = String(text ?? '').length;
  return Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, 300 + Math.ceil(n * 0.75)));
}

/** Pure: what the layout request is told. */
function layoutSystem() {
  return [
    'You lay out one chat reply from Homeroom bot as a small HTML fragment. The chat draws it in place of the reply\'s',
    'words, so it must say exactly what they say: every sentence, name, number, request number and link, in their',
    'order, and nothing else. Never add, drop, reword, sum up or explain. You may add a short heading where the reply',
    'has parts, and nothing more of your own.',
    'Markdown in it becomes HTML: **bold** as <strong>, a list as <ul> or <ol>, a [label](address) link as',
    '<a href="address">label</a> with the same address. Use what fits the words: short headings, short paragraphs,',
    'lists, steps, a table or option cards.',
    replyHtml.REPLY_HTML_STYLE,
    `Answer only with the ${LAYOUT_TOOL} tool.`,
  ].join(' ');
}

const TOOLS = Object.freeze([{
  type: 'function',
  function: {
    name: LAYOUT_TOOL,
    description: 'The reply, laid out.',
    parameters: {
      type: 'object',
      properties: { html: { type: 'string', description: 'The fragment.' } },
      required: ['html'],
      additionalProperties: false,
    },
  },
}]);

/** Pure: the fragment a layout answer carries: its tool call's, else its words. */
function answerOf(res) {
  const calls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
  for (const call of calls) {
    if (call?.function?.name !== LAYOUT_TOOL) continue;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      if (typeof args.html === 'string') return args.html;
    } catch { /* its words, then */ }
  }
  return typeof res?.content === 'string' ? res.content : '';
}

/**
 * Lay `text` out. `chat` is the turn's transport (openrouter.streamChat's
 * shape), asked once. Never throws. Resolves { html, code, usage }: `code`
 * 'layout' with the copy, else why there is none: 'short' (the words are
 * short enough as they are), 'off' (no transport), 'timeout', 'error',
 * 'unusable' (no markup in its answer), 'unfaithful' (its words are not
 * the reply's) or 'claims' (the claims checker found a claim in it).
 */
async function layOut({ text, chat, apiKey, config = {}, model, sessionId = null, timeoutMs = TIMEOUT_MS, signal = null, check = null }) {
  if (!replyHtml.wantsLayout(text)) return { html: null, code: 'short', usage: null };
  if (typeof chat !== 'function' || !model) return { html: null, code: 'off', usage: null };
  let res;
  try {
    res = await chat({
      apiKey,
      baseUrl: config.openrouterApiBase,
      origin: config.openrouterOrigin,
      model,
      reasoning: 'none',
      temperature: 0,
      messages: [
        { role: 'system', content: layoutSystem() },
        { role: 'user', content: String(text) },
      ],
      tools: TOOLS,
      toolChoice: { type: 'function', function: { name: LAYOUT_TOOL } },
      maxOutputTokens: layoutTokens(text),
      parallelToolCalls: null,
      timeoutMs,
      ...(sessionId ? { sessionId } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    return { html: null, code: err?.code === 'timeout' ? 'timeout' : 'error', usage: null };
  }
  const usage = res?.usage || null;
  const html = replyHtml.cleanReplyHtml(answerOf(res));
  if (!html) return { html: null, code: 'unusable', usage };
  if (!replyHtml.matchesWords(html, text, { novel: LAYOUT_NOVEL_WORDS })) return { html: null, code: 'unfaithful', usage };
  // The claims checker's guarantees hold for the copy as for the words
  // (reply-claims.js): `check` is the turn's, and a copy it finds a claim in,
  // or that it cannot check, is not sent.
  if (typeof check === 'function') {
    let clear = false;
    try { clear = await check(html); } catch { clear = false; }
    if (!clear) return { html: null, code: 'claims', usage };
  }
  return { html, code: 'layout', usage };
}

/**
 * Start laying `text` out and wait for it `waitMs` at most. Resolves
 * { now, later }: `now` the finished result when it came in time, else
 * null, and `later` the same layout's promise, for the caller to put a late
 * copy on the message it already sent. Never throws.
 */
async function layOutInTime(options, { waitMs = WAIT_MS, sleep = null } = {}) {
  const later = layOut(options);
  let timer = null;
  const waited = sleep
    ? sleep(waitMs).then(() => null)
    // Not unref'd: a few seconds at most, and the reply waits on it.
    : new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const first = await Promise.race([later, waited]);
  if (timer) clearTimeout(timer);
  return { now: first, later };
}

/**
 * Pure: how a reply's laid-out copy went, for its turn's record
 * (homeroom_bot_dm_turns.html_status, homeroom_bot_voice_turns.html_status):
 *   'model'  the model's own copy was sent;
 *   'layout' the layout pass made it in time;
 *   'late'   the layout pass made it after the words were sent;
 *   'short'  no copy was needed;
 *   'failed' a long reply went as words: the layout pass failed (its code is
 *            one of the turn's failures, `layout:<code>`);
 *   'none'   a long reply went as words with no layout pass (an offer's line,
 *            a fallback, a turn with no transport for it).
 * And what the model gave (`html_model`): 'kept', 'dropped' or 'none'.
 */
function htmlModel({ wrote, kept }) {
  if (!wrote) return 'none';
  return kept ? 'kept' : 'dropped';
}

module.exports = {
  WAIT_MS,
  TIMEOUT_MS,
  MIN_TOKENS,
  MAX_TOKENS,
  LAYOUT_NOVEL_WORDS,
  layoutTokens,
  layoutSystem,
  answerOf,
  layOut,
  layOutInTime,
  htmlModel,
};
