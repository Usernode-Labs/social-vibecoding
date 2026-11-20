'use strict';

// Step 6 (#6864): one chat turn (homeroom-bot-mayor.js runDmTurn) in a
// private thread that holds a design, or in one where the turn starts one
// with start_design: the harness the design suites share, in place of the
// design bot's own answer (design-bot.js answer, gone). The design is the
// turn's capability (design-bot.js openSession); the model is a script, the
// database a stand-in that answers the thread's rows, and the version a turn
// saves is kept here.
//
//   steps     the model's answers, in order (the last repeats): a string is
//             words with no tool call, { calls, content } a round of calls.
//   design    the thread's design (design-threads.js designFor), or null for
//             a thread that holds none yet (script start_design first).
//   current   its newest version, { version, html }.
//   thread    the thread's rows, newest first, as the database answers them.
//
// Returns { run, sent, doings, seen, choices, offered, recorded, versions,
// versionArgs, reads, sql }: what was sent (dm.sendDm's arguments), what the
// working card said, each round's messages, tool choice and tool names, the
// turn's record, the versions saved (their HTML, and every argument), and the
// project files read.

const mayor = require('../../src/services/homeroom-bot-mayor');
const realDm = require('../../src/services/homeroom-bot-dm');
const realThreads = require('../../src/services/design-threads');

const call = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function scripted(steps, seen = [], choices = [], offered = []) {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req.messages));
    choices.push(req.toolChoice);
    offered.push((req.tools || []).map((tool) => tool.function.name));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (typeof step === 'function') return step(req);
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

function designChatTurn(steps, {
  design = null, current = null, surface = 'new', thread = [], ask = 'yep, can you do that? In the current thread?',
  settings = { mode: 'live', perPerson: 2 }, threads = {}, mayorOverrides = {}, deps: extra = {}, config = {},
  seesImages = false, message = null, room = null, files = null, canRead = true, filedTrack = null, pool: givenPool = null,
  answer = null,
} = {}) {
  const sent = [];
  const doings = [];
  const seen = [];
  const choices = [];
  const offered = [];
  const recorded = [];
  const versions = [];
  const versionArgs = [];
  const reads = [];
  const sql = [];
  const asked = message || { id: 71, content: ask, threadRootId: 500 };
  const mine = { id: asked.id, sender_id: 9, content: asked.content, metadata: asked.metadata || null, moderation_hidden_at: null };
  const rows = () => {
    const list = thread.map((m) => ({ metadata: null, moderation_hidden_at: null, ...m }));
    return list.some((m) => Number(m.id) === Number(asked.id)) ? list : [mine, ...list];
  };
  const pool = givenPool || {
    async query(text, params) {
      sql.push(String(text));
      // A suite's own rows for the queries it pins (`answer`), first.
      const own = typeof answer === 'function' ? answer(String(text), params || []) : undefined;
      if (own) return own;
      if (/INSERT INTO homeroom_bot_dm_turns/.test(text)) {
        recorded.push({ rounds: params[4], tools: params[5], error: params[9], failures: params[10], fallback: params[11] });
        return { rows: [{ id: recorded.length }] };
      }
      if (/FROM conversation_messages\b/.test(text) && /ORDER BY id DESC/.test(text)) return { rows: rows() };
      if (/FROM conversation_messages\s+WHERE id = \$1 AND conversation_id = \$2/.test(text)) return { rows: [mine] };
      return { rows: [] };
    },
  };
  const project = room?.app || { id: 3, slug: 'ear', name: 'Ear Trainer' };
  const designThreads = {
    ...realThreads,
    surfaceFor: () => surface,
    validHtml: (html) => (typeof html === 'string' && html.trim() ? html : null),
    async draftingThread() { return room || { rootId: 500, threadId: 7, conversationId: 41, kind: 'ask', app: project, about: null }; },
    async designFor() { return design; },
    async versionOf(_pool, args) {
      if (args?.version && current && Number(args.version) !== Number(current.version)) return null;
      return current;
    },
    async ensureDesign() { return design || { threadId: 7, rootId: 500, title: 'Main screen', app: { slug: project.slug, name: project.name }, latest: 0, versions: [] }; },
    async addVersion(_pool, args) {
      versionArgs.push(args);
      versions.push(args.html);
      return { version: (current?.version || 0) + versions.length };
    },
    async noteVersionMessage() {},
    async planTargetOf() { return null; },
    ...threads,
  };
  const code = files ? {
    async sourceRepo() {
      return canRead ? { app: { id: project.id, slug: project.slug }, repo: { owner: 'o', repo: project.slug } } : { error: 'No such project whose code they can read.' };
    },
  } : {};
  const deps = {
    chat: scripted(steps, seen, choices, offered), apiKey: 'sk-test', seesImages, sleep: async () => {}, openMcp: async () => null,
    streamDraft: false,
    dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; } },
    dm: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; } },
    doing: async (what) => { doings.push(what); },
    threadRootId: 500, threadDraft: null, threadKind: 'ask',
    ...(design ? { threadDesign: design } : {}),
    designThreads,
    botPictures: { async designPictures() { return []; } },
    designCapture: { async renderDesign() { return { ok: false }; }, findPage: () => null },
    mayor: Object.assign(Object.create(mayor), { ...code, ...mayorOverrides }),
    ...(files ? { github: { async getFileContent(_owner, _repo, filePath) { reads.push(filePath); return files[filePath] ?? null; } } } : {}),
    track: { async tracksForRequests(_pool, { numbers }) { return new Map(filedTrack ? [[numbers[0], filedTrack]] : []); } },
    ...extra,
  };
  const run = mayor.runDmTurn(pool, config, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings,
    conversationId: 41,
    message: asked,
    deps,
  });
  return { run, sent, doings, seen, choices, offered, recorded, versions, versionArgs, reads, sql };
}

/** The design section of a round's messages (THIS THREAD'S ARTIFACT), or ''. */
function designSection(messages) {
  return (messages || []).filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('THIS THREAD\'S ARTIFACT'))
    .map((m) => m.content).join('\n');
}

module.exports = { designChatTurn, scripted, call, designSection };
