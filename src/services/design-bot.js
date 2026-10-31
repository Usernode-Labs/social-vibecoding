'use strict';

// #6071: Homeroom bot in a design thread (services/design-threads.js). The
// person says what to change, in words or pinned to a point on the preview,
// and the bot makes the change: it reads the version shown now, edits it
// with exact find-and-replace pairs (edit_design), and its answer is the
// next version, said in the thread. The person never edits the code.
//
// It runs on the DM's engine (homeroom-bot-mayor.js askModel: retries on a
// fresh route, a failed provider left out), on the bot's key and allowance,
// recorded per turn like every DM turn (homeroom_bot_dm_turns). It reads the
// thread alone, never the main chat, and has no other tools: it cannot file,
// post or look anything up from here. Propose it is the person's own tap.

const log = require('./logger');
const { withoutEmDashes } = require('./em-dashes');

// The most of a version the model reads; a bigger one is not edited, and the
// person is asked to capture a smaller part of the screen.
const MAX_DESIGN_CHARS = 120_000;
// The thread's newest messages it reads.
const MAX_HISTORY = 16;
const MAX_ROUNDS = 4;
const MAX_EDITS = 16;
const MAX_FIND_CHARS = 4000;
const MAX_REPLACE_CHARS = 40_000;
// An edit's pairs and its words fit in this: room for a reasoning model's
// thinking and the edit after it (the transport's own ceiling).
const DESIGN_OUTPUT_TOKENS = 4096;
const MAX_REPLY_CHARS = 1500;

const BUSY_TEXT = 'You\'ve sent me a lot in the last hour. Give me a little while and ask again.';
const OFF_TEXT = 'I\'m switched off right now. I\'ll pick up again when an admin turns me back on.';
const BROKEN_TEXT = 'I couldn\'t make that change just now: my model didn\'t answer. Try again in a minute.';
const TOO_BIG_TEXT = 'This screen is too big for me to edit in one piece. Capture a smaller part of it and I\'ll take it from there.';
const CLOSED_TEXT = 'This design was proposed, so I won\'t change it here. Capture the screen again to start a new one.';

const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'edit_design',
      description: 'Change the design: exact find-and-replace edits on the current version\'s HTML, applied in order. '
        + 'Each `find` must be copied exactly from the HTML and occur in it exactly once; `replace` takes its place '
        + '(empty deletes it). Every call\'s edits together make the next version. Say in `note`, in a few words, what changed.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EDITS,
            items: {
              type: 'object',
              properties: { find: { type: 'string' }, replace: { type: 'string' } },
              required: ['find', 'replace'],
              additionalProperties: false,
            },
          },
          note: { type: 'string', description: 'What changed, in a few plain words (it names the version).' },
        },
        required: ['edits', 'note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply',
      description: 'Send your answer to the person and finish the turn: a sentence or two. Call it exactly once, last.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
]);

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pure: the turn's instructions, with the version shown now. */
function designPrompt({ username, design, version, html }) {
  const where = design.surface === 'app' ? `a screen of the app ${design.app?.name || design.app?.slug || ''}`.trim()
    : 'a page of Homeroom itself';
  return [
    `You are Homeroom bot, working on a design with @${username} in a private thread of their chat with you.`,
    `The design is ${where}, "${design.title}", captured from what they saw, and drawn at ${design.width} by ${design.height}`,
    'pixels in a preview beside this chat with the screen\'s own stylesheets. They tell you what to change, in words or',
    'with a comment pinned to a point on the preview; you make the change with edit_design, then reply.',
    '',
    'HOW TO EDIT',
    '- Edit the current version below with exact find-and-replace pairs. Copy each `find` exactly from it, long enough',
    '  to occur once. Keep the screen\'s own classes and structure where you can: the real change will be built from',
    '  this design, in the project\'s own code.',
    '- You may add a <style> block, inline styles and small inline <script>s for interactive states. Nothing may load',
    '  from the network: no external src, href, @import, fetch or font. The preview blocks it anyway.',
    '- A pinned comment names the version it was pinned on and the element under the point. When it was pinned on an',
    '  older version, find the same element in this one.',
    '- If what they ask is unclear, ask one short question instead of guessing. Never say you changed something you',
    '  did not change with edit_design. You cannot file, post or propose anything: Propose it is their own button above',
    '  the preview, which files a request with the first version and the one they choose side by side.',
    '- Keep every reply to a sentence or two, in plain words, without em dashes. Content rules: nothing sexual, violent,',
    '  or about weapons or gambling, in the design or in your words.',
    '',
    `THE CURRENT VERSION (version ${version}), its whole HTML:`,
    html,
  ].join('\n');
}

/** Pure: a person's message as the model reads it, with the pin it carries. */
function personLine(message) {
  const text = String(message.content || '').trim() || '(no words)';
  const pin = message.metadata?.designPin;
  if (!pin) return text;
  const el = pin.element || {};
  const what = [el.tag ? `<${el.tag}>` : '', el.text ? `"${el.text}"` : ''].filter(Boolean).join(' ');
  const at = `${Math.round(Number(pin.x) * 100)}% across, ${Math.round(Number(pin.y) * 100)}% down`;
  return `[Pinned on version ${Number(pin.version)} at ${at}${what ? `, on ${what}` : ''}]\n${text}`;
}

/** The thread as the model reads it: the person's messages and the bot's, newest MAX_HISTORY, up to `upToId`. */
async function historyOf(pool, { conversationId, rootId, botId, upToId }) {
  const { rows } = await pool.query(
    `SELECT id, sender_id, content, metadata FROM conversation_messages
      WHERE conversation_id = $1 AND thread_root_id = $2 AND id <= $3 AND deleted_at IS NULL
        AND msg_type = 'message'
      ORDER BY id DESC LIMIT $4`,
    [Number(conversationId), Number(rootId), Number(upToId), MAX_HISTORY],
  );
  return rows.reverse().map((m) => (Number(m.sender_id) === Number(botId)
    ? { role: 'assistant', content: clip(m.content, 1500) || '(nothing)' }
    : { role: 'user', content: personLine(m) }));
}

/**
 * Pure: `html` with each edit applied in order, or { error } naming the first
 * that does not apply (its find missing, or found more than once).
 */
function applyEdits(html, edits) {
  if (!Array.isArray(edits) || !edits.length) return { error: 'Give at least one edit.' };
  if (edits.length > MAX_EDITS) return { error: `At most ${MAX_EDITS} edits in one call.` };
  let out = String(html);
  for (let i = 0; i < edits.length; i += 1) {
    const find = typeof edits[i]?.find === 'string' ? edits[i].find : '';
    const replace = typeof edits[i]?.replace === 'string' ? edits[i].replace : null;
    if (!find || replace == null) return { error: `Edit ${i + 1} needs both find and replace.` };
    if (find.length > MAX_FIND_CHARS || replace.length > MAX_REPLACE_CHARS) return { error: `Edit ${i + 1} is too long.` };
    const at = out.indexOf(find);
    if (at < 0) return { error: `Edit ${i + 1}: its find is not in the HTML. Copy it exactly from the current version.` };
    if (out.indexOf(find, at + 1) >= 0) return { error: `Edit ${i + 1}: its find occurs more than once. Make it longer.` };
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return { html: out };
}

/**
 * Answer one message in a design thread. `design` is the thread
 * (design-threads.js designFor). Resolves what was sent, or null.
 */
async function answer(pool, config, { bot, user, settings, conversationId, message, design, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const threads = deps.designThreads || require('./design-threads');
  // Under the key the DM's answers use, so a retry after a restart finds it
  // said (homeroom-bot-dm.js answeredAlready).
  const key = mayor.answerKey(message.id);
  const say = (content, extra = {}) => dm.sendDm(pool, {
    bot, userId: user.id, content: withoutEmDashes(content), idempotencyKey: key, replyToId: message.id, moment: 'reply', ...extra,
  });
  if (settings.mode === 'off') return say(OFF_TEXT);
  if (await mayor.turnsLastHour(pool, user.id) >= mayor.MAX_TURNS_PER_HOUR) return say(BUSY_TEXT);
  if (design.state !== 'open') return say(CLOSED_TEXT);
  const current = await threads.versionOf(pool, { userId: user.id, rootId: design.rootId });
  if (!current) return say(BROKEN_TEXT);
  if (current.html.length > MAX_DESIGN_CHARS) return say(TOO_BIG_TEXT);

  const t = {
    config, user, settings, message,
    model: require('./default-model').fromSettings(settings, config) || mayor.DEFAULT_MODEL,
    chat: deps.chat || require('./openrouter').streamChat,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    apiKey: deps.apiKey,
    route: 1,
    startedMs: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    failures: [],
    avoid: [],
  };
  const tools = [];
  let rounds = 0;
  let error = null;
  let html = current.html;
  const notes = [];
  let replyText = '';
  try {
    if (t.apiKey === undefined) t.apiKey = await mayor.botKey(pool, config, bot.id).catch(() => null);
    if (!t.apiKey) throw Object.assign(new Error('no key'), { code: 'no_key' });
    const history = await historyOf(pool, { conversationId, rootId: design.rootId, botId: bot.id, upToId: message.id });
    if (!history.length || history[history.length - 1].role !== 'user') history.push({ role: 'user', content: personLine(message) });
    const messages = [
      { role: 'system', content: designPrompt({ username: user.username, design, version: current.version, html: current.html }) },
      ...history,
    ];
    const ids = new Set();
    while (rounds < MAX_ROUNDS && !replyText) {
      rounds += 1;
      const last = rounds === MAX_ROUNDS;
      const res = await mayor.askModel(t, {
        messages, tools: TOOLS, where: `d${rounds}`, maxOutputTokens: DESIGN_OUTPUT_TOKENS,
        toolChoice: last ? { type: 'function', function: { name: 'reply' } } : 'auto',
      });
      const calls = mayor.normalizeCalls(res.toolCalls, rounds, ids);
      if (!calls.length) { replyText = String(res.content || '').trim(); break; }
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function.name;
        tools.push(name.slice(0, 40));
        const args = mayor.parseArgs(call.function.arguments);
        let result;
        if (name === 'edit_design') {
          const applied = applyEdits(html, args.edits);
          if (applied.error) result = { ok: false, error: applied.error };
          else if (!threads.validHtml(applied.html)) result = { ok: false, error: 'That makes the design too big.' };
          else {
            html = applied.html;
            if (args.note) notes.push(clip(args.note, 120));
            result = { ok: true, chars: html.length };
          }
        } else if (name === 'reply') {
          replyText = String(args.text || '').trim();
          result = { ok: true };
        } else {
          result = { ok: false, error: `There is no tool called ${name}.` };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (err) {
    error = mayor.codeOf(err);
    log.warn('design-bot', 'A design turn failed', { userId: user.id, messageId: message.id, code: error });
  }
  const changed = html !== current.html;
  await mayor.recordTurn(pool, {
    userId: user.id, conversationId, messageId: message.id, model: t.model, rounds, tools,
    inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, costUsd: t.usage.costUsd,
    error, failures: t.failures, fallback: error ? 'design_broken' : null,
  });
  if (t.usage.costUsd > 0) {
    try {
      if (await require('./openrouter-managed-keys').usesIncludedKey(pool, bot.id)) {
        await require('./limits').recordSpend(pool, bot.id, Math.round(t.usage.costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('design-bot', 'Could not record a design turn\'s spend', { err: err.message });
    }
  }
  if (!changed) {
    if (error === 'no_key') return say(mayor.KEY_TEXT);
    return say(clip(replyText, MAX_REPLY_CHARS) || BROKEN_TEXT);
  }
  // Every edit of the turn is one version, said by its answer.
  const made = await threads.addVersion(pool, { threadId: design.threadId, html, author: 'bot', note: notes.join('; ') || null });
  if (!made) return say('I couldn\'t keep that change: this design has as many versions as it can hold, or it grew too big.');
  const words = [
    threads.versionLine(made.version, notes.join('; ') || null),
    clip(replyText, MAX_REPLY_CHARS),
  ].filter(Boolean).join('\n\n');
  const sent = await say(words, {
    metadata: {
      kind: 'design_version', appSlug: design.app?.slug || null, appName: design.app?.name || null, designVersion: made.version,
    },
  });
  await threads.noteVersionMessage(pool, { threadId: design.threadId, version: made.version, messageId: sent?.messageId });
  return sent;
}

module.exports = {
  MAX_DESIGN_CHARS,
  DESIGN_OUTPUT_TOKENS,
  TOOLS,
  designPrompt,
  personLine,
  applyEdits,
  historyOf,
  answer,
};
