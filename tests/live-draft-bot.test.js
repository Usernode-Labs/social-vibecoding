'use strict';

// Homeroom bot in a thread with an open live draft
// (src/services/live-draft-bot.js, the draft capability of the chat's turn
// since step 6): the pure edit rules (exact find, once; numbered reads), and
// whole chat turns against a scripted model, a stand-in draft (its files, its
// saves) and a stand-in chat: read, edit, save and reply; a save that
// stopped the app fixed in the same turn; changes the model forgot to save
// saved before its reply; secrets never read; the switched-off and busy
// answers; and a draft opened and changed in one turn.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const draftBot = require('../src/services/live-draft-bot');
const realMayor = require('../src/services/homeroom-bot-mayor');

test('applyEdits: each find exactly once, in order, as the text stands', () => {
  assert.deepEqual(draftBot.applyEdits('a b c', [{ find: 'b', replace: 'B' }]), { text: 'a B c' });
  assert.deepEqual(draftBot.applyEdits('a b c', [{ find: 'b', replace: 'x' }, { find: 'x c', replace: 'y' }]), { text: 'a y' });
  assert.match(draftBot.applyEdits('a b c', [{ find: 'z', replace: '' }]).error, /Edit 1: its find is not in the file/);
  assert.match(draftBot.applyEdits('a a', [{ find: 'a', replace: 'b' }]).error, /more than once/);
  assert.match(draftBot.applyEdits('a', [{ find: '', replace: 'b' }]).error, /nothing to find/);
  assert.match(draftBot.applyEdits('a', []).error, /No edits/);
  assert.match(draftBot.applyEdits('a', Array.from({ length: 17 }, () => ({ find: 'a', replace: 'a' }))).error, /At most 16/);
});

test('chunkOf numbers lines and says where the next part starts', () => {
  const out = draftBot.chunkOf('one\ntwo\nthree', 2);
  assert.deepEqual(out, { totalLines: 3, text: '2: two\n3: three' });
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const first = draftBot.chunkOf(long);
  assert.ok(first.nextLine > 1 && first.nextLine < 5000);
  assert.ok(first.text.startsWith('1: line 0'));
});

test('appliedWords says what the preview did, never more', () => {
  assert.equal(draftBot.appliedWords({ ok: true, preview: { ok: true, bootMs: 300 } }).preview, 'restarted');
  const crashed = draftBot.appliedWords({ ok: true, preview: { ok: false, crashed: true, log: 'TypeError: x' } });
  assert.deepEqual([crashed.preview, crashed.log], ['crashed', 'TypeError: x']);
  assert.equal(draftBot.appliedWords({ ok: true, preview: { ok: true, rebuilding: true, why: 'install' } }).preview, 'rebuilding');
  assert.equal(draftBot.appliedWords({ ok: false, error: 'nope' }).saved, false);
  // Homeroom's own failure is said as its, whether the change was kept or not.
  const kept = draftBot.appliedWords({ ok: true, preview: { ok: false, platform: true, error: 'x' } });
  assert.deepEqual([kept.saved, kept.preview], [true, 'platform']);
  assert.match(kept.note, /Homeroom had a problem on its side/);
  assert.match(kept.note, /Saved in the draft/);
  const lost = draftBot.appliedWords({ ok: false, platform: true, error: 'x' });
  assert.deepEqual([lost.saved, lost.preview], [false, 'platform']);
  assert.match(lost.note, /Not saved/);
  assert.doesNotMatch(lost.note, /fix the cause/);
  // The app's own build step failing is the app's, and says so.
  assert.match(draftBot.appliedWords({ ok: true, preview: { ok: false, crashed: true, why: 'build', log: 'x' } }).note,
    /fix the cause or its build/);
});

test('the draft prompt is the skill, written against the chat\'s question rule', () => {
  const prompt = draftBot.draftPrompt({
    username: 'evan', draft: { app_slug: 'gym', app_name: 'Gym Tracker' }, edits: [], files: [{ path: 'server.js' }], notes: null,
  });
  assert.match(prompt, /Never ask a bare question/);
  assert.match(prompt, /what you found in the code that makes the question necessary and what its answer changes/);
  assert.match(prompt, /its own copy of the app's data/);
  assert.doesNotMatch(prompt, /Ask back/);
  assert.doesNotMatch(prompt, /sample data/i);
  // Every sentence asking a question says what makes it necessary; nothing
  // contradicts the chat's rule with a bare "ask back".
  for (const line of prompt.split('\n')) {
    if (/question|ask them|ask back/i.test(line) && /answer changes|makes the question necessary|needs no change|bare question/i.test(line) === false) {
      assert.fail(`a question with no reason in the prompt: ${line}`);
    }
  }
});

test('the draft skill states the chat\'s question rule, promises nothing later, and has no em dash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'prompts', 'artifact-draft.md'), 'utf8');
  for (const line of text.split('\n')) {
    assert.doesNotMatch(line, /ask back|bare question.*allowed|will (look|follow|fix) .*later/i);
  }
  assert.match(text, /what you found in the code that makes the question necessary and what its answer changes/);
  assert.match(text, /Never ask a bare question/);
  assert.doesNotMatch(text, /sample data/i);
  assert.doesNotMatch(text, /—/);
});

// ── A whole turn ───────────────────────────────────────────────────────
//
// Step 6 (#6864): the draft is a capability of the chat's own turn
// (homeroom-bot-mayor.js runDmTurn, told the open draft as
// deps.threadLiveDraft): its tools beside the chat's, its section in the
// prompt, and the chat's one reply, checked as every reply is.

const DRAFT = {
  id: 3, user_id: 10, root_message_id: 50, app_slug: 'gym', app_name: 'Gym Tracker', head_sha: 'a'.repeat(40), state: 'open',
};
const FILES = {
  'server.js': 'const PORT = process.env.PORT;\napp.get("/", (q, r) => r.send(page));\n',
  'public/index.html': '<button class="start">Start workout</button>\n',
  '.env': 'SECRET=1',
};

function setup({ script, previews = [], settings = {}, turns = 0 }) {
  const sent = [];
  const saved = [];
  const seenByModel = [];
  const offered = [];
  let call = 0;
  const files = { ...FILES };
  const call_ = (name, args) => ({ id: `c${call}${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const chat = async (options) => {
    seenByModel.push(JSON.parse(JSON.stringify(options.messages)));
    offered.push((options.tools || []).map((tool) => tool.function.name));
    const step = script[call] || { reply: 'Done.' };
    call += 1;
    if (typeof step === 'function') return step(options);
    if (step.reply) return { content: '', toolCalls: [call_('reply', { text: step.reply })] };
    return { content: '', toolCalls: step.calls.map(([name, args]) => call_(name, args)) };
  };
  const liveDrafts = {
    async listFiles() { return Object.keys(files).map((path) => ({ path, size: files[path].length })); },
    async readFile(_d, p) { return files[p] ?? null; },
    async editsOf() { return [{ summary: 'Earlier change' }]; },
    async byId() { return { ...DRAFT, head_sha: 'b'.repeat(40) }; },
    async applyEdit(_pool, _config, args) {
      saved.push(args);
      for (const f of args.files) files[f.path] = f.content;
      const preview = previews.shift() || { ok: true, bootMs: 250 };
      return { ok: true, head: 'b'.repeat(40), preview };
    },
  };
  const dmSvc = { ...require('../src/services/homeroom-bot-dm'), async sendDm(_pool, msg) { sent.push(msg); return { messageId: 99 }; } };
  const pool = {
    async query(sql) {
      if (/FROM homeroom_bot_dm_turns/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: turns }] };
      return { rows: [] };
    },
  };
  const run = (content = 'Make the start button bigger') => realMayor.runDmTurn(pool, {}, {
    bot: { id: 1, username: 'homeroom_bot' }, user: { id: 10, username: 'evan' }, settings: { mode: 'live', ...settings }, conversationId: 7,
    message: { id: 60, content, threadRootId: 50 },
    deps: {
      chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {}, streamDraft: false,
      dmSvc, liveDrafts, threadRootId: 50, threadDraft: null, threadKind: 'ask', threadLiveDraft: DRAFT,
    },
  });
  return { run, sent, saved, seenByModel, offered, files: () => files };
}

test('a turn reads, edits, saves and replies; the preview restarts with it', async () => {
  const s = setup({
    script: [
      { calls: [['search_code', { text: 'start workout' }]] },
      { calls: [['read_file', { path: 'public/index.html' }]] },
      { calls: [['edit_file', { path: 'public/index.html', edits: [{ find: 'class="start"', replace: 'class="start big"' }] }]] },
      { calls: [['apply_changes', { summary: 'Bigger Start workout button' }]] },
      { reply: 'The Start workout button is bigger now.' },
    ],
  });
  await s.run();
  assert.equal(s.saved.length, 1);
  assert.deepEqual(s.saved[0].files, [{ path: 'public/index.html', content: '<button class="start big">Start workout</button>\n' }]);
  assert.equal(s.saved[0].summary, 'Bigger Start workout button');
  assert.equal(s.sent.length, 1, 'one reply, the chat turn\'s');
  assert.equal(s.sent[0].content, 'The Start workout button is bigger now.');
  assert.deepEqual(s.sent[0].metadata.liveDraft, { id: 3, head: 'b'.repeat(40), app: 'gym' });
  // The search found the line, and the prompt told the model what the draft is.
  const prompt = s.seenByModel[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.match(prompt, /THIS THREAD'S LIVE DRAFT/);
  assert.match(prompt, /changing the app "Gym Tracker" together with @evan/);
  assert.match(prompt, /- Earlier change/);
  assert.match(prompt, /public\/index\.html/);
  const searched = s.seenByModel[1].find((m) => m.role === 'tool');
  assert.match(searched.content, /"line":1/);
  // The chat's own tools are there too: a draft's thread can still file a request.
  assert.ok(s.offered[0].includes('offer_request') && s.offered[0].includes('apply_changes'));
});

test('a save that stops the app comes back with its log, and the fix is saved in the same turn', async () => {
  const s = setup({
    previews: [{ ok: false, crashed: true, log: 'ReferenceError: page is not defined' }, { ok: true, bootMs: 200 }],
    script: [
      { calls: [['read_file', { path: 'server.js' }]] },
      { calls: [['edit_file', { path: 'server.js', edits: [{ find: 'r.send(page)', replace: 'r.send(pages)' }] }]] },
      { calls: [['apply_changes', { summary: 'Typo' }]] },
      (options) => {
        const last = options.messages[options.messages.length - 1];
        assert.equal(last.role, 'tool');
        assert.match(last.content, /"preview":"crashed"/);
        assert.match(last.content, /page is not defined/);
        return { content: '', toolCalls: [{ id: 'fix1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'server.js', edits: [{ find: 'r.send(pages)', replace: 'r.send(page)' }] }) } }] };
      },
      { calls: [['apply_changes', { summary: 'Put the page back' }]] },
      { reply: 'Fixed: the app is running again.' },
    ],
  });
  await s.run();
  assert.equal(s.saved.length, 2);
  assert.equal(s.files()['server.js'], FILES['server.js']);
  assert.equal(s.sent[0].content, 'Fixed: the app is running again.');
});

test('changes the model forgot to save are saved before its reply', async () => {
  const s = setup({
    script: [
      { calls: [['read_file', { path: 'public/index.html' }]] },
      { calls: [['edit_file', { path: 'public/index.html', edits: [{ find: 'Start workout', replace: 'Start' }] }]] },
      { reply: 'Renamed the button. It says Start now.' },
      { reply: 'The button says Start now.' },
    ],
  });
  await s.run();
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0].summary, 'Renamed the button.');
  assert.equal(s.sent[0].content, 'The button says Start now.');
});

test('a secret file is never read, and nothing outside the app is touched', async () => {
  const s = setup({
    script: [
      { calls: [['read_file', { path: '.env' }], ['write_file', { path: '../x.js', content: 'x' }], ['list_files', {}]] },
      (options) => {
        const results = options.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        assert.match(results[0], /holds secrets/);
        assert.match(results[1], /not a file path/);
        assert.doesNotMatch(results[2], /\.env/);
        return { content: '', toolCalls: [{ id: 'r1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: 'Nothing to change.' }) } }] };
      },
    ],
  });
  await s.run();
  assert.equal(s.saved.length, 0);
  assert.equal(s.sent[0].content, 'Nothing to change.');
});

test('switched off, or asked too much this hour, it says so and does nothing, as any chat turn does', async () => {
  const off = setup({ script: [], settings: { mode: 'off' } });
  await off.run();
  assert.equal(off.sent[0].content, realMayor.OFF_TEXT);
  assert.equal(off.seenByModel.length, 0);
  const busy = setup({ script: [], turns: 10_000 });
  await busy.run();
  assert.equal(busy.sent[0].content, realMayor.BUSY_TEXT);
  assert.equal(busy.seenByModel.length, 0);
});

test('a draft whose code cannot be read is said in the turn\'s prompt, and its tools are not offered', async () => {
  const s = setup({ script: [{ reply: draftBot.NO_CODE_TEXT }] });
  const dmSvc = { ...require('../src/services/homeroom-bot-dm'), async sendDm(_pool, msg) { s.sent.push(msg); return { messageId: 99 }; } };
  await realMayor.runDmTurn({ async query() { return { rows: [] }; } }, {}, {
    bot: { id: 1 }, user: { id: 10, username: 'evan' }, settings: { mode: 'live' }, conversationId: 7,
    message: { id: 62, content: 'make it blue', threadRootId: 50 },
    deps: {
      chat: async (options) => { s.offered.push(options.tools.map((t) => t.function.name)); s.seenByModel.push(options.messages); return { content: '', toolCalls: [{ id: 'r', function: { name: 'reply', arguments: JSON.stringify({ text: 'Its code cannot be read just now.' }) } }] }; },
      apiKey: 'sk', openMcp: async () => null, seesImages: false, streamDraft: false, dmSvc,
      liveDrafts: { async listFiles() { return null; } }, threadRootId: 50, threadDraft: null, threadLiveDraft: DRAFT,
    },
  });
  assert.ok(!s.offered[0].includes('apply_changes'));
  const prompt = s.seenByModel[0][0].content;
  assert.match(prompt, /A live draft of Gym Tracker is open beside this thread, but its code cannot be read just now/);
  assert.match(prompt, new RegExp(draftBot.NO_CODE_TEXT.replace(/[.']/g, '.')));
});

test('open_app_preview opens the thread\'s draft and loads its tools for the rest of the turn; it asks which project when there is none', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  let appId = null;
  const pool = {
    async query(sql, params) {
      if (/FROM private_threads WHERE root_message_id/.test(sql)) return { rows: [{ id: 4, app_id: appId }] };
      if (/UPDATE private_threads SET app_id/.test(sql)) { appId = params[2]; return { rows: [] }; }
      return { rows: [] };
    },
  };
  const opened = [];
  const loaded = [];
  const ctx = (extra = {}) => ({
    user: { id: 10, username: 'evan' }, config: {},
    loadDraft: async (id) => { loaded.push(id); return { ok: true }; },
    deps: { threadRootId: 50, liveDrafts: { open: async (_p, _c, args) => { opened.push(args.rootId); return { status: 200, body: { ok: true, draft: { id: 3 } } }; } }, ...extra },
  });
  const none = await mayor.openAppPreview(pool, ctx(), {});
  assert.equal(none.ok, false);
  assert.match(none.error, /ask which project/);
  const unknown = await mayor.openAppPreview(pool, ctx(), { project: 'nowhere' });
  assert.match(unknown.error, /no project called nowhere/);
  appId = 21;
  const c = ctx();
  const out = await mayor.openAppPreview(pool, c, {});
  assert.deepEqual([out.ok, c.openPreview, opened, loaded], [true, { draftId: 3 }, [50], [3]]);
  assert.match(out.note, /the draft's tools are yours\s+for the rest of this turn/);
  assert.doesNotMatch(out.note, /do not reply/, 'nothing hands the turn over');
  const refused = await mayor.openAppPreview(pool, ctx({ liveDrafts: { open: async () => ({ status: 409, body: { error: 'too_many', message: 'You can have 2 app previews open at once.' } }) } }), {});
  assert.deepEqual([refused.ok, refused.error], [false, 'You can have 2 app previews open at once.']);
  const noThread = await mayor.openAppPreview(pool, { user: { id: 10 }, config: {}, deps: {} }, {});
  assert.match(noThread.error, /New chat/);
  const first = await mayor.openAppPreview(pool, ctx({ threadKind: 'first_version' }), {});
  assert.match(first.error, /first version/);
  // The turn ends with its own reply.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/homeroom-bot-mayor.js'), 'utf8');
  assert.match(src, /done: \(\) => !!ctx\.reply,/);
  assert.doesNotMatch(src, /\)\.opened\(pool, config, \{/);
});

test('a draft the turn just opened makes the change asked for in that same turn, counted once', async () => {
  const sent = [];
  const saved = [];
  const seen = [];
  const files = { 'public/index.html': '<button class="start">Start workout</button>\n' };
  let i = 0;
  const steps = [
    { name: 'open_app_preview', args: {} },
    { name: 'read_file', args: { path: 'public/index.html' } },
    { name: 'edit_file', args: { path: 'public/index.html', edits: [{ find: 'class="start"', replace: 'class="start big"' }] } },
    { name: 'apply_changes', args: { summary: 'Bigger Start button' } },
    { name: 'reply', args: { text: 'The preview is starting with a bigger Start button.' } },
  ];
  const pool = {
    async query(sql) {
      if (/FROM private_threads WHERE root_message_id/.test(sql)) return { rows: [{ id: 4, app_id: 21 }] };
      return { rows: [] };
    },
  };
  await realMayor.runDmTurn(pool, {}, {
    bot: { id: 1 }, user: { id: 10, username: 'evan' }, settings: { mode: 'live' }, conversationId: 7,
    message: { id: 61, content: 'I want to change an app live: make the start button bigger', threadRootId: 50 },
    deps: {
      chat: async (options) => {
        seen.push({ tools: options.tools.map((t) => t.function.name), messages: JSON.parse(JSON.stringify(options.messages)) });
        const step = steps[Math.min(i, steps.length - 1)];
        i += 1;
        return { content: '', toolCalls: [{ id: `c${i}`, function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
      },
      apiKey: 'sk', openMcp: async () => null, seesImages: false, streamDraft: false,
      dmSvc: { ...require('../src/services/homeroom-bot-dm'), async sendDm(_p, msg) { sent.push(msg); return { messageId: 1 }; } },
      threadRootId: 50, threadDraft: null, threadKind: 'ask',
      liveDrafts: {
        open: async () => ({ status: 200, body: { ok: true, draft: { id: 3 } } }),
        byId: async () => DRAFT, listFiles: async () => [{ path: 'public/index.html', size: 10 }],
        readFile: async (_d, p) => files[p] ?? null, editsOf: async () => [],
        applyEdit: async (_p, _c, args) => { saved.push(args); return { ok: true, head: 'c'.repeat(40), preview: { rebuilding: true, why: 'starting' } }; },
      },
    },
  });
  assert.ok(!seen[0].tools.includes('apply_changes'), 'no draft tools before it opens');
  assert.ok(seen[1].tools.includes('apply_changes'), 'its tools from the next round');
  assert.ok(seen[1].messages.some((m) => m.role === 'system' && m.content.includes(draftBot.OPENING_NOTE)), 'told it just opened it');
  assert.equal(saved.length, 1);
  assert.equal(sent.length, 1, 'one reply: the turn\'s');
  assert.equal(sent[0].content, 'The preview is starting with a bigger Start button.');
  assert.equal(sent[0].idempotencyKey, realMayor.answerKey(61), 'the answer to their message, under its own key');
  assert.deepEqual(sent[0].metadata.liveDraft, { id: 3, head: 'c'.repeat(40), app: 'gym' });
});
