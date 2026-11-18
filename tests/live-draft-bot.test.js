'use strict';

// Homeroom bot in a thread with an open live draft
// (src/services/live-draft-bot.js): the pure edit rules (exact find, once;
// numbered reads), and whole turns against a scripted model, a stand-in
// draft (its files, its saves) and a stand-in chat: read, edit, save and
// reply; a save that stopped the app fixed in the same turn; changes the
// model forgot to save saved before its reply; secrets never read; and the
// switched-off and busy answers.

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
});

// ── A whole turn ───────────────────────────────────────────────────────

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
  let call = 0;
  let files = { ...FILES };
  const call_ = (name, args) => ({ id: `c${call}${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const mayor = {
    ...realMayor,
    answerKey: (id) => `key-${id}`,
    turnsLastHour: async () => turns,
    botKey: async () => 'sk-test',
    recordTurn: async () => {},
    askModel: async (_t, options) => {
      seenByModel.push(JSON.parse(JSON.stringify(options.messages)));
      const step = script[call] || { reply: 'Done.' };
      call += 1;
      if (typeof step === 'function') return step(options);
      if (step.reply) return { content: '', toolCalls: [call_('reply', { text: step.reply })] };
      return { content: '', toolCalls: step.calls.map(([name, args]) => call_(name, args)) };
    },
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
  const dm = { async sendDm(_pool, msg) { sent.push(msg); return { messageId: 99 }; } };
  const pool = { async query() { return { rows: [] }; } };
  const run = (content = 'Make the start button bigger') => draftBot.answer(pool, {}, {
    bot: { id: 1 }, user: { id: 10, username: 'evan' }, settings, conversationId: 7,
    message: { id: 60, content, threadRootId: 50 }, draft: DRAFT,
    deps: { mayor, liveDrafts, dm, apiKey: 'sk-test' },
  });
  return { run, sent, saved, seenByModel, files: () => files };
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
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].content, 'The Start workout button is bigger now.');
  assert.equal(s.sent[0].threadRootId, 50);
  assert.deepEqual(s.sent[0].metadata.liveDraft, { id: 3, head: 'b'.repeat(40), app: 'gym' });
  // The search found the line, and the prompt told the model what the draft is.
  const prompt = s.seenByModel[0][0].content;
  assert.match(prompt, /changing the app "Gym Tracker" together with @evan/);
  assert.match(prompt, /- Earlier change/);
  assert.match(prompt, /public\/index\.html/);
  const searched = s.seenByModel[1].find((m) => m.role === 'tool');
  assert.match(searched.content, /"line":1/);
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

test('switched off, or asked too much this hour, it says so and does nothing', async () => {
  const off = setup({ script: [], settings: { mode: 'off' } });
  await off.run();
  assert.equal(off.sent[0].content, draftBot.OFF_TEXT);
  assert.equal(off.seenByModel.length, 0);
  const busy = setup({ script: [], turns: 10_000 });
  await busy.run();
  assert.equal(busy.sent[0].content, draftBot.BUSY_TEXT);
});
