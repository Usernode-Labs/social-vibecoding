'use strict';

// Homeroom bot in a thread with an open live draft (services/live-drafts.js).
// The person says what to change; the bot reads the draft's code, changes it
// with exact find-and-replace edits (as a design thread changes a design:
// design-bot.js), and saves them. Saving (apply_changes) commits the edits
// on the draft's branch and writes them into the draft's running preview,
// which restarts the app in place and reloads beside the chat: no image is
// built, so the change shows seconds after the bot is done. What the restart
// said comes back to the bot in the same turn, so an edit that stopped the
// app is fixed (or put back) before the person looks.
//
// It runs on Homeroom bot's turn engine (homeroom-bot-turn-engine.js), with
// the chat's model, key, allowance and per-hour limit, recorded per turn like
// every DM turn (homeroom_bot_dm_turns). It answers only in the draft's own
// thread, and only while the draft is open (homeroom-bot-dm.js routes there).

const { DRAFT_LIMITS } = require('./bot-profiles');
const log = require('./logger');
const turnEngine = require('./homeroom-bot-turn-engine');
const botStop = require('./homeroom-bot-stop');
const { withoutEmDashes } = require('./em-dashes');

const MAX_ROUNDS = DRAFT_LIMITS.rounds;
const MAX_APPLIES = DRAFT_LIMITS.appliesPerTurn;
const MAX_EDITS = DRAFT_LIMITS.editsPerCall;
const MAX_HISTORY = DRAFT_LIMITS.history;
const MAX_REPLY_CHARS = DRAFT_LIMITS.replyChars;
const READ_CHUNK_CHARS = 12000;
const MAX_LISTED = 300;
const MAX_WRITE_CHARS = 200 * 1024;
const MAX_SEARCHED_FILES = 40;
const MAX_SEARCH_FILE_CHARS = 400 * 1024;
const MAX_SEARCH_HITS = 30;
const NOTES_CHARS = 4000;
const SECRET_PATH_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i;
const SKIP_SEARCH_RE = /(^|\/)(node_modules|\.git|vendor|dist|build)\/|(\.min\.(js|css)|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|mp4|webm|pdf|zip|lock))$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

const OFF_TEXT = 'I\'m switched off right now. I\'ll pick up again when an admin turns me back on.';
const BUSY_TEXT = 'You\'ve sent me a lot in the last hour. Give me a little while and ask again.';
const BROKEN_TEXT = 'I couldn\'t make that change just now: my model didn\'t answer. Try again in a minute.';
const NO_CODE_TEXT = 'I couldn\'t read this draft\'s code just now. Try again in a minute.';

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pure: a path as the model wrote it, relative and inside the app, or null. */
function filePath(value) {
  return require('./live-draft-supervisor').safePath(value);
}

/**
 * Pure: apply exact find-and-replace `edits` to `text`, in order. Each
 * `find` must occur exactly once in the text as it stands at that edit.
 * Resolves `{ text }` or `{ error }` naming the edit that could not apply.
 */
function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) return { error: 'No edits.' };
  if (edits.length > MAX_EDITS) return { error: `At most ${MAX_EDITS} edits in one call.` };
  let out = String(text);
  for (const [i, edit] of edits.entries()) {
    const find = typeof edit?.find === 'string' ? edit.find : '';
    const replace = typeof edit?.replace === 'string' ? edit.replace : null;
    if (!find) return { error: `Edit ${i + 1} has nothing to find.` };
    if (replace == null) return { error: `Edit ${i + 1} has no replace.` };
    const at = out.indexOf(find);
    if (at < 0) return { error: `Edit ${i + 1}: its find is not in the file as it stands (after the edits before it). Read the file again and copy the text exactly.` };
    if (out.indexOf(find, at + 1) >= 0) return { error: `Edit ${i + 1}: its find occurs more than once. Include more of the lines around it.` };
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return { text: out };
}

/** Pure: a file's lines from `from`, numbered, up to READ_CHUNK_CHARS. */
function chunkOf(text, from = 1) {
  const lines = String(text).split('\n');
  const start = Math.min(Math.max(1, Number.isInteger(Number(from)) ? Number(from) : 1), Math.max(lines.length, 1));
  const out = [];
  let used = 0;
  let line = start;
  for (; line <= lines.length; line += 1) {
    const row = `${line}: ${lines[line - 1]}`;
    if (out.length && used + row.length + 1 > READ_CHUNK_CHARS) break;
    out.push(row.length > READ_CHUNK_CHARS ? `${row.slice(0, READ_CHUNK_CHARS - 1)}…` : row);
    used += row.length + 1;
  }
  return { totalLines: lines.length, text: out.join('\n'), ...(line <= lines.length ? { nextLine: line } : {}) };
}

/** Pure: what the turn's last apply said, for the reply to rest on. */
function appliedWords(result) {
  if (!result) return null;
  if (!result.ok) return { saved: false, error: result.error || 'Not saved.' };
  const p = result.preview || {};
  if (p.rebuilding && p.why === 'starting') {
    return { saved: true, preview: 'starting', note: 'Saved. The preview is still starting for the first time; it shows this change once it is up, in a minute or two.' };
  }
  if (p.rebuilding) {
    return {
      saved: true, preview: 'rebuilding',
      note: p.why === 'install'
        ? 'Saved. It changes what the app installs, so the preview is being built again: about a minute or two.'
        : 'Saved. The preview is being built again to show it: about a minute or two.',
    };
  }
  if (p.ok) return { saved: true, preview: 'restarted', bootMs: p.bootMs ?? null, note: 'Saved, and the app restarted with it. Their view reloads by itself.' };
  if (p.crashed) {
    return {
      saved: true, preview: 'crashed', log: clip(p.log || '', 3000),
      note: 'Saved, but the app did not start with it. Read the log, fix the cause (or put the file back as it was), and apply again.',
    };
  }
  return { saved: true, preview: 'unknown', note: clip(p.error || 'The preview did not answer.', 300) };
}

const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'The draft\'s files, as they stand now (with the changes you saved). `match` keeps the paths containing all its words.',
      parameters: { type: 'object', properties: { match: { type: 'string' } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Find text in the draft\'s code: each line that contains `text` (any case), with its file and line number. '
        + '`path` limits it to one file or folder.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, path: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file of the draft, with its lines numbered, from `fromLine` (1 by default). '
        + 'It includes any edits you made this turn. A long file comes in parts: `nextLine` says where the next starts.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, fromLine: { type: 'integer', minimum: 1 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Change a file with exact find-and-replace edits, applied in order. Each `find` must be copied exactly '
        + 'from the file (without the line numbers read_file shows) and occur in it exactly once; `replace` takes its '
        + 'place (empty deletes it). Nothing is saved until apply_changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
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
        },
        required: ['path', 'edits'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a whole file: a new one, or a small one rewritten. Use edit_file to change part of a file. '
        + 'Nothing is saved until apply_changes.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_changes',
      description: 'Save the files you changed this turn to the draft and restart its running preview with them. '
        + '`summary` is one short line in plain words saying what changed for someone using the app '
        + '("Bigger Start workout button"). It answers whether the app started again, and its log when it did not.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply',
      description: 'Your answer in the thread, which ends the turn: one to three short sentences in plain words.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
  },
]);

// The chat's turn opened this draft for the message being answered
// (homeroom-bot-mayor.js open_app_preview): said once, before the rest.
const OPENING_NOTE = 'You just opened this live draft for their message, and its preview is starting beside the chat '
  + '(a minute or two the first time). If their message asks for a change, make it now: it is saved to the draft, and '
  + 'the preview shows it once it is up. If it only asks for the preview, reply in a sentence that it is starting, and '
  + 'to say what to change.';

function draftPrompt({ username, draft, edits, files, notes, opening = false }) {
  const name = draft.app_name || draft.app_slug;
  const listed = files.slice(0, MAX_LISTED).map((f) => f.path).join('\n');
  const done = edits.length
    ? edits.slice(-20).map((e) => `- ${e.summary}`).join('\n')
    : '(none yet)';
  return [
    `You are Homeroom bot, changing the app "${name}" together with @${username}, in a live draft.`,
    'A running preview of the draft is open beside this chat. Every change you save with apply_changes is committed '
      + 'to the draft and written into that preview, which restarts the app in a few seconds and reloads their view. '
      + 'Nobody else sees the draft until they tap Propose, which puts it to the project\'s vote.',
    '',
    'How to work:',
    '1. Find the code: search_code and list_files, then read_file the part you will change. Never change what you have not read this turn.',
    '2. Change it with edit_file (exact find-and-replace, small and precise). Use write_file only for a new file or a small one.',
    `3. Call apply_changes once with a one-line summary. If the app did not start, read the log, fix the cause and apply again (at most ${MAX_APPLIES} applies a turn). If you cannot fix it, put the file back as it was and apply that.`,
    '4. Then reply: one to three short sentences saying what they will see now. Never say you changed something you did not apply.',
    'A question that needs no change is answered with reply alone. Ask back when what they want is unclear.',
    '',
    'Rules:',
    '- Do what they asked and nothing more. Keep the app working.',
    '- The app loads Homeroom\'s hosted files by relative path (/usernode-bridge/v1/bridge.js, /usernode-native/v1/native.css, '
      + '/usernode-tailwind/v1/tailwind.js): never write a hostname in front of them, never copy them in, and never add a '
      + '<script> from another site.',
    '- A change to what the app installs (package.json dependencies) builds the preview again, which takes a minute or two: add a package only when they ask for one.',
    '- No secrets or keys in the code. Nothing sexual, no realistic violence, no real-money gambling.',
    '- The preview runs on sample data: what they see there is not anyone\'s real data.',
    '',
    `Saved so far in this draft:\n${done}`,
    ...(notes ? ['', `The app's own notes for whoever changes it:\n${notes}`] : []),
    '',
    `The draft's files${files.length > MAX_LISTED ? ` (first ${MAX_LISTED} of ${files.length})` : ''}:\n${listed}`,
    ...(opening ? ['', OPENING_NOTE] : []),
  ].join('\n');
}

async function threadHistory(pool, { conversationId, rootId, botId, upToId }) {
  const { rows } = await pool.query(
    `SELECT id, sender_id, content FROM conversation_messages
      WHERE conversation_id = $1 AND (id = $2 OR thread_root_id = $2) AND id <= $3
        AND deleted_at IS NULL AND msg_type = 'message' AND moderation_hidden_at IS NULL
      ORDER BY id DESC LIMIT $4`,
    [Number(conversationId), Number(rootId), Number(upToId), MAX_HISTORY],
  );
  return rows.reverse().map((m) => (Number(m.sender_id) === Number(botId)
    ? { role: 'assistant', content: clip(m.content, 1500) || '(nothing)' }
    : { role: 'user', content: clip(m.content, 4000) || '(nothing)' }));
}

/**
 * Answer one message in a thread whose draft is open (`draft`, a
 * live-drafts row). Resolves what was sent.
 */
async function answer(pool, config, { bot, user, settings, conversationId, message, draft, opening = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const liveDrafts = deps.liveDrafts || require('./live-drafts');
  const rootId = Number(draft.root_message_id);
  const key = mayor.answerKey(message.id);
  const say = (content, extra = {}) => dm.sendDm(pool, {
    bot, userId: user.id, content: withoutEmDashes(content), idempotencyKey: key, replyToId: message.id, moment: 'reply',
    threadRootId: rootId, ...extra,
  });
  if (settings.mode === 'off') return say(OFF_TEXT);
  // A draft the chat's turn just opened is that turn's answer: it counted already.
  if (!opening && await mayor.turnsLastHour(pool, user.id) >= mayor.MAX_TURNS_PER_HOUR) return say(BUSY_TEXT);

  const project = { slug: draft.app_slug, name: draft.app_name || draft.app_slug };
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
    signal: deps.stop?.signal || null,
  };
  const tools = [];
  const turnRounds = { rounds: 0, limit: MAX_ROUNDS };
  let error = null;
  let replyText = '';
  // This turn's changed files, by path: what read_file and the next edit read.
  const pending = new Map();
  // What was read from the draft's head this turn.
  const cache = new Map();
  let fileList = null;
  let applies = 0;
  let lastApply = null;
  let held = false;
  let current = draft;

  const doing = (what) => {
    if (typeof deps.doing !== 'function') return;
    Promise.resolve(deps.doing(what)).catch(() => {});
  };
  const read = async (p) => {
    if (pending.has(p)) return pending.get(p);
    if (cache.has(p)) return cache.get(p);
    const text = await liveDrafts.readFile(current, p, deps);
    cache.set(p, text);
    return text;
  };
  const listAll = async () => {
    if (!fileList) fileList = (await liveDrafts.listFiles(current, deps)) || [];
    const paths = new Map(fileList.map((f) => [f.path, f]));
    for (const [p, text] of pending) if (!paths.has(p)) paths.set(p, { path: p, size: text.length });
    return [...paths.values()].filter((f) => !SECRET_PATH_RE.test(f.path));
  };

  const apply = async (summary) => {
    if (!pending.size) return { ok: false, error: 'Nothing changed this turn: edit a file first.' };
    if (applies >= MAX_APPLIES) return { ok: false, error: `That is ${MAX_APPLIES} applies this turn: reply now with where it stands.` };
    applies += 1;
    const files = [...pending].map(([path, content]) => ({ path, content }));
    const result = await liveDrafts.applyEdit(pool, config, {
      draftId: draft.id, userId: user.id, files, summary: clip(summary || 'Live draft edit', 200), deps,
    });
    if (result.ok) {
      // Saved: what was pending is the draft's head now.
      for (const [p, text] of pending) cache.set(p, text);
      pending.clear();
      current = (await liveDrafts.byId(pool, draft.id)) || { ...current, head_sha: result.head };
      fileList = null;
    }
    lastApply = result;
    return appliedWords(result);
  };

  try {
    if (t.apiKey === undefined) t.apiKey = await mayor.botKey(pool, config, bot.id).catch(() => null);
    if (!t.apiKey) throw Object.assign(new Error('no key'), { code: 'no_key' });
    const files = await liveDrafts.listFiles(current, deps);
    if (!files) throw Object.assign(new Error('no code'), { code: 'no_code' });
    fileList = files;
    const edits = await liveDrafts.editsOf(pool, draft.id);
    const notesPath = ['CLAUDE.md', 'AGENTS.md'].find((p) => files.some((f) => f.path === p));
    const notes = notesPath ? clip(await read(notesPath).catch(() => null) || '', NOTES_CHARS) : null;
    const history = await threadHistory(pool, { conversationId, rootId, botId: bot.id, upToId: message.id });
    if (!history.length || history[history.length - 1].role !== 'user') {
      history.push({ role: 'user', content: clip(message.content, 4000) || '(nothing)' });
    }
    const messages = [
      { role: 'system', content: draftPrompt({ username: user.username, draft, edits, files, notes, opening }) },
      ...history,
    ];
    const seenIds = new Set();
    const profile = {
      messages, ids: seenIds, normalize: mayor.normalizeCalls, parseArgs: mayor.parseArgs,
      resultChars: mayor.MAX_TOOL_RESULT_CHARS, cut: clip,
      ask: (options) => mayor.askModel(t, {
        ...options,
        maxOutputTokens: DRAFT_LIMITS.outputTokens,
        retryOutputTokens: DRAFT_LIMITS.retryOutputTokens,
        timeoutMs: DRAFT_LIMITS.requestTimeoutMs,
      }),
      signal: t.signal,
      where: (n) => `l${n}`,
      done: () => !!replyText,
      offer: ({ last }) => ({
        tools: TOOLS,
        toolChoice: last ? { type: 'function', function: { name: 'reply' } } : 'auto',
      }),
      onWords: async (res) => {
        replyText = String(res.content || '').trim();
        return 'stop';
      },
      call: async (_call, name, args) => {
        tools.push(name.slice(0, 40));
        let result;
        if (name === 'list_files') {
          doing(mayor.doingFor('list_source', args, { project: project.name }));
          const words = String(args?.match || '').toLowerCase().split(/\s+/).filter(Boolean);
          const all = (await listAll()).filter((f) => words.every((w) => f.path.toLowerCase().includes(w)));
          result = { files: all.slice(0, MAX_LISTED).map((f) => f.path), more: Math.max(0, all.length - MAX_LISTED) };
        } else if (name === 'read_file') {
          doing(mayor.doingFor('read_source', args, { project: project.name }));
          const p = filePath(args?.path);
          if (!p) result = { ok: false, error: 'That is not a file path in the app.' };
          else if (SECRET_PATH_RE.test(p)) result = { ok: false, error: 'That file holds secrets, so it is never read.' };
          else {
            const text = await read(p);
            if (text == null) result = { ok: false, error: 'No such file. Use list_files or search_code to find it.' };
            else if (text.includes('\u0000')) result = { ok: false, error: 'That file is not text.' };
            else result = { path: p, ...chunkOf(text, args?.fromLine) };
          }
        } else if (name === 'search_code') {
          doing(mayor.doingFor('read_source', args, { project: project.name }));
          const needle = String(args?.text || '').toLowerCase();
          const under = args?.path ? filePath(args.path) : null;
          if (!needle) result = { ok: false, error: 'Say what text to find.' };
          else {
            const candidates = (await listAll()).filter((f) => !SKIP_SEARCH_RE.test(f.path)
              && (!under || f.path === under || f.path.startsWith(`${under}/`))
              && (f.size || 0) <= MAX_SEARCH_FILE_CHARS);
            const hits = [];
            for (const f of candidates.slice(0, MAX_SEARCHED_FILES)) {
              const text = await read(f.path).catch(() => null);
              if (typeof text !== 'string' || text.includes('\u0000')) continue;
              const lines = text.split('\n');
              for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i += 1) {
                if (lines[i].toLowerCase().includes(needle)) hits.push({ path: f.path, line: i + 1, text: clip(lines[i].trim(), 200) });
              }
              if (hits.length >= MAX_SEARCH_HITS) break;
            }
            result = {
              hits,
              ...(candidates.length > MAX_SEARCHED_FILES ? { note: `Only the first ${MAX_SEARCHED_FILES} files were searched: give a path to search elsewhere.` } : {}),
            };
          }
        } else if (name === 'edit_file') {
          doing(mayor.doingFor('edit_design', args));
          const p = filePath(args?.path);
          const text = p ? await read(p) : null;
          if (!p) result = { ok: false, error: 'That is not a file path in the app.' };
          else if (text == null) result = { ok: false, error: 'No such file. Use write_file for a new one.' };
          else {
            const changed = applyEdits(text, args?.edits);
            if (changed.error) result = { ok: false, error: changed.error };
            else {
              pending.set(p, changed.text);
              result = { ok: true, path: p, saved: false, next: 'apply_changes saves it and restarts the preview.' };
            }
          }
        } else if (name === 'write_file') {
          doing(mayor.doingFor('edit_design', args));
          const p = filePath(args?.path);
          const content = typeof args?.content === 'string' ? args.content : null;
          if (!p) result = { ok: false, error: 'That is not a file path in the app.' };
          else if (SECRET_PATH_RE.test(p)) result = { ok: false, error: 'That path is for secrets: keys go in the project\'s Secrets, never in its files.' };
          else if (content == null) result = { ok: false, error: 'No content.' };
          else if (content.length > MAX_WRITE_CHARS) result = { ok: false, error: 'That file is too big to write whole: change it with edit_file.' };
          else {
            pending.set(p, content);
            result = { ok: true, path: p, saved: false, next: 'apply_changes saves it and restarts the preview.' };
          }
        } else if (name === 'apply_changes') {
          result = await apply(args?.summary);
        } else if (name === 'reply') {
          if (pending.size && !held) {
            // Changes made and never saved: saved now, and the model tells
            // them what they see.
            held = true;
            const saved = await apply(String(args?.text || '').split(/(?<=[.!?])\s/)[0]);
            result = { ok: false, error: 'Your changes were not saved yet, so they were saved now. Reply again with what they see.', applied: saved };
          } else {
            replyText = String(args?.text || '').trim();
            result = { ok: true };
          }
        } else {
          result = { ok: false, error: `There is no tool called ${name}.` };
        }
        await deps.stop?.note?.(name, args, result);
        return result;
      },
    };
    await turnEngine.runRounds(turnRounds, profile);
  } catch (err) {
    error = err?.code === 'no_code' ? 'no_code' : mayor.codeOf(err);
    if (!botStop.isStop(err)) log.warn('live-draft-bot', 'A draft turn failed', { userId: user.id, draftId: draft.id, code: error });
  }
  const record = (fallback) => mayor.recordTurn(pool, {
    userId: user.id, conversationId, messageId: message.id, model: t.model, rounds: turnRounds.rounds, tools,
    inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, costUsd: t.usage.costUsd,
    error, failures: t.failures, fallback,
  });
  if (deps.stop?.signal?.aborted) {
    await record('stopped');
    await turnEngine.chargeTurn(pool, bot.id, t.usage.costUsd, { what: 'a draft turn', category: 'live-draft-bot' });
    return say(botStop.stoppedText(deps.stop.did));
  }
  await record(error ? 'draft_broken' : null);
  await turnEngine.chargeTurn(pool, bot.id, t.usage.costUsd, { what: 'a draft turn', category: 'live-draft-bot' });
  if (error === 'no_key') return say(mayor.KEY_TEXT);
  if (error === 'no_code') return say(NO_CODE_TEXT);
  const words = clip(replyText, MAX_REPLY_CHARS)
    || (lastApply?.ok ? 'Done. The preview has the change.' : BROKEN_TEXT);
  const head = lastApply?.ok ? lastApply.head : null;
  return say(words, {
    metadata: { kind: 'chat', liveDraft: { id: Number(draft.id), ...(head ? { head } : {}), app: project.slug } },
  });
}

/**
 * The chat's turn opened draft `draftId` for `message` (open_app_preview,
 * which ends that turn without a reply): this answers it, in the draft's
 * own way, from the draft's first edit. Resolves what was sent.
 */
async function opened(pool, config, { draftId, deps = {}, ...args }) {
  const liveDrafts = deps.liveDrafts || require('./live-drafts');
  const draft = await liveDrafts.byId(pool, draftId, { userId: args.user?.id });
  if (!draft) {
    const dm = deps.dm || require('./homeroom-bot-dm');
    const mayor = deps.mayor || require('./homeroom-bot-mayor');
    return dm.sendDm(pool, {
      bot: args.bot, userId: args.user.id, content: BROKEN_TEXT, idempotencyKey: mayor.answerKey(args.message.id),
      replyToId: args.message.id, moment: 'reply',
    });
  }
  return answer(pool, config, { ...args, draft, opening: true, deps });
}

module.exports = {
  answer, opened, OPENING_NOTE, applyEdits, chunkOf, appliedWords, draftPrompt, filePath, TOOLS,
  OFF_TEXT, BUSY_TEXT, BROKEN_TEXT, NO_CODE_TEXT,
};
