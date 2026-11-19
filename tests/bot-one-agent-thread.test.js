'use strict';

// Step 6 (docs/plans/bot-one-model.md, request #6864, 19 Nov 2026): one
// agent per private thread. Every message in a private thread is the chat's
// turn (homeroom-bot-mayor.js runDmTurn), which loads the thread's design or
// its open live draft as a capability (bot-profiles.js CAPABILITIES):
//
//   1. A pinned comment, a reply to a version, and every message under an
//      open draft reach the chat's turn; nothing hands a message to a
//      designer or a draft bot (homeroom-bot-dm.js answerUserMessage).
//   2. A design thread's turn has the design tools and section; a draft's
//      has the draft tools and section, and its reply is checked
//      (reply-claims.js draft_done); an ordinary thread has neither.
//   3. "lgtm, implement" in a design thread is offer_plan, whose card files
//      the design as the plan; offer_request on the design's own project is
//      sent back to offer_plan.
//   4. A question and a change in one message: one reply, the answer first,
//      then "Version N: <summary>" with the version it saved, the summary
//      written once and never cut mid-word (design-threads.js versionLine).
//   5. A request's thread decides only a tapped suggested answer, Build it
//      under a waiting plan, and a reply quoting the question or the plan;
//      a free-text question about a waiting plan reaches the turn, and is
//      not planned again.
//
// Run with: node --test tests/bot-one-agent-thread.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const draftBot = require('../src/services/live-draft-bot');
const realThreads = require('../src/services/design-threads');
const profiles = require('../src/services/bot-profiles');
const claims = require('../src/services/reply-claims');

const BOT = { id: 2, username: 'homeroom_bot' };
const EVAN = { id: 9, username: 'evan', hasPlatformAccess: true };
const APP_ROW = { id: 5, slug: 'recipebot', name: 'RecipeBot', view_visibility: 'public', moderation_suspended_at: null };

const DESIGN = Object.freeze({
  threadId: 7,
  rootId: 500,
  conversationId: 45,
  state: 'open',
  number: null,
  kind: 'ask',
  about: null,
  app: { slug: 'recipebot', name: 'RecipeBot' },
  title: 'Request page',
  surface: 'app',
  route: null,
  width: 1280,
  height: 900,
  latest: 3,
  versions: [
    { version: 1, author: 'bot', note: null, messageId: 600, at: null },
    { version: 2, author: 'bot', note: null, messageId: 610, at: null },
    { version: 3, author: 'bot', note: null, messageId: 620, at: null },
  ],
});
const CURRENT = '<html><body><main class="request"><h1>Request</h1><p class="replies">Replies</p></main></body></html>';

const DRAFT = Object.freeze({
  id: 31, state: 'open', user_id: 9, app_slug: 'garden', app_name: 'Garden club', root_message_id: 700, head_sha: 'a'.repeat(40),
  repo_url: 'https://github.com/x/garden',
});

const call = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });
function scripted(steps, seen = [], offered = []) {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req.messages));
    offered.push((req.tools || []).map((tool) => tool.function.name));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

// A pool that knows one project (RecipeBot) and answers everything else empty.
function fakePool(sql = []) {
  return {
    async query(text, params) {
      sql.push(String(text));
      if (/FROM apps\s+WHERE slug = LOWER\(\$1\)/.test(text)) {
        return String(params?.[0] || '').toLowerCase() === 'recipebot' ? { rows: [APP_ROW] } : { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function designDeps({ versions, notes, offers }) {
  return {
    designThreads: {
      ...realThreads,
      async draftingThread() {
        return { rootId: 500, conversationId: 45, threadId: 7, kind: 'ask', app: { id: 5, slug: 'recipebot', name: 'RecipeBot' }, about: null };
      },
      async versionOf() { return { version: 3, html: CURRENT, design: DESIGN }; },
      async designFor() { return DESIGN; },
      async ensureDesign() { return DESIGN; },
      async addVersion(_pool, args) { versions.push(args); return { version: DESIGN.latest + versions.length }; },
      async noteVersionMessage(_pool, args) { notes.push(args); },
      async planTargetOf() { return null; },
    },
    botPictures: { async designPictures() { return []; } },
    // The look renders nothing here (design-capture.js is its own suite).
    designCapture: { async renderDesign() { return { ok: false }; }, findPage: () => null },
    mayor: Object.assign(Object.create(mayor), {
      async checkPlanOffer(_pool, { design, args }) {
        offers.push({ design, args });
        return {
          ok: true,
          offer: { kind: 'plan', app: { id: 5, slug: 'recipebot', name: 'RecipeBot' }, issueNumber: null, version: design.latest },
          note: `A card with "New request" goes under your reply: version ${design.latest} as its plan.`,
        };
      },
    }),
  };
}

function turn(steps, { message, deps: extra = {}, design = DESIGN } = {}) {
  const sent = [];
  const seen = [];
  const offered = [];
  const versions = [];
  const notes = [];
  const offers = [];
  const doings = [];
  const sql = [];
  const pool = fakePool(sql);
  const deps = {
    chat: scripted(steps, seen, offered), apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
    streamDraft: false,
    dmSvc: { ...dm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 45 }; } },
    doing: async (what) => { doings.push(what); },
    threadRootId: 500, threadDraft: { kind: 'ask', changeKind: 'design', appSlug: 'recipebot', appName: 'RecipeBot' }, threadKind: 'ask',
    ...(design ? { threadDesign: design } : {}),
    ...designDeps({ versions, notes, offers }),
    ...extra,
  };
  const run = mayor.runDmTurn(pool, { selfAppSlug: 'homeroom' }, {
    bot: BOT, user: EVAN, settings: { mode: 'live', perPerson: 2 }, conversationId: 45,
    message: message || { id: 80, content: 'Bring back the earlier steps line. And what would the 2 earlier steps be?', threadRootId: 500 },
    deps,
  });
  return { run, sent, seen, offered, versions, notes, offers, doings, sql };
}

const systemText = (seen) => seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');

// ── 1. Routing: every message in a private thread is the chat's turn ────

function routing(t, { design = DESIGN, draft = null } = {}) {
  const conversations = require('../src/services/conversations');
  const real = conversations.withLockedAudience;
  conversations.withLockedAudience = async (_pool, _actor, _id, callback) => { await callback([2, 9]); return [2, 9]; };
  t.after(() => { conversations.withLockedAudience = real; });
  const turns = [];
  const pool = {
    async query(sql) {
      if (/FROM platform_settings/.test(sql)) {
        return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }, { key: 'homeroom_bot_dm_chat', value: 'on' }] };
      }
      if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
  const deps = {
    bot: BOT,
    ws: { pushConversationEvent() { return 1; } },
    designThreads: { async threadOf() { return design; } },
    liveDrafts: { async threadOf() { return draft; } },
    mayor: {
      async decideOffer() { return null; },
      async decideTyped() { return null; },
      async reviseAttached() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args); return { turn: args.message.id }; },
    },
  };
  const send = (message) => dm.noteUserMessage(pool, {}, { user: EVAN, conversationId: 45, message, deps });
  return { turns, send };
}

test('a comment pinned on the preview and a reply to a version are answered by the chat\'s turn, told the design', async (t) => {
  const h = routing(t);
  assert.deepEqual(await h.send({ id: 71, content: 'Make this bigger', threadRootId: 500, metadata: { designPin: { version: 3, x: 0.4, y: 0.6 } } }), { turn: 71 });
  assert.deepEqual(await h.send({ id: 72, content: 'Version 2 was better: put the cards back', threadRootId: 500, reply: { id: 610 } }), { turn: 72 });
  assert.deepEqual(await h.send({ id: 73, content: 'what are you working on?', threadRootId: 500 }), { turn: 73 });
  assert.equal(h.turns.length, 3, 'one speaker: no designer answers in its place');
  for (const args of h.turns) assert.equal(args.deps.threadDesign, DESIGN, 'each turn is told the thread\'s design');
  assert.equal(profiles.kindInChat(h.turns[0].deps), 'private');
  assert.deepEqual(profiles.capabilitiesInChat(h.turns[0].deps), ['design']);
  assert.equal(typeof dm.designDirect, 'undefined', 'nothing decides a design\'s own message any more');
});

test('every message under an open live draft is the chat\'s turn, told the draft', async (t) => {
  const h = routing(t, { design: null, draft: DRAFT });
  assert.deepEqual(await h.send({ id: 74, content: 'Make the start button bigger', threadRootId: 700 }), { turn: 74 });
  assert.equal(h.turns[0].deps.threadLiveDraft, DRAFT);
  assert.deepEqual(profiles.capabilitiesInChat(h.turns[0].deps), ['draft']);
  assert.equal(h.turns[0].deps.threadDesign, undefined);
});

test('the private profile is one speaker with its capabilities, and no design or draft kind is left', async () => {
  assert.deepEqual(profiles.KINDS, ['private', 'request', 'change', 'channel', 'reply']);
  // Artifacts, stage 2: a plain page's capability beside the design's and the draft's.
  assert.deepEqual(profiles.profileOf('private').capabilities, ['design', 'draft', 'artifact']);
  assert.throws(() => profiles.profileOf('design'), /no thread kind design/);
  assert.throws(() => profiles.profileOf('draft'), /no thread kind draft/);
  assert.deepEqual(profiles.turnLimits([]).rounds, profiles.CHAT_LIMITS.rounds, 'an ordinary turn keeps its limits');
  assert.deepEqual(profiles.turnLimits(['design']).outputTokens, profiles.DESIGN_LIMITS.outputTokens);
  assert.deepEqual(profiles.turnLimits(['draft']).rounds, profiles.DRAFT_LIMITS.rounds);
  await assert.rejects(require('../src/services/thread-bot').answer({}, {}, { kind: 'design', deps: {} }), /no thread kind design/);
});

// ── 2. Capabilities by thread state ──────────────────────────────────────

test('a design thread\'s turn has the design tools and section; an ordinary one has neither', async () => {
  const design = turn([{ calls: [call('reply', { text: 'They were Asked and Planned.' })] }]);
  await design.run;
  const tools = design.offered[0];
  for (const name of ['write_artifact', 'edit_artifact', 'capture_page', 'compare_versions', 'make_pictures', 'read_plan', 'offer_plan']) {
    assert.ok(tools.includes(name), `${name} in a design thread`);
  }
  assert.ok(!tools.includes('write_screen') && !tools.includes('edit_design'), 'stage 3: the generic names are offered; the old ones only still run');
  assert.ok(!tools.includes('start_design'), 'the design is there already');
  assert.ok(!tools.includes('draw_screen'), 'nothing hands drawing over');
  assert.ok(tools.includes('offer_request') && tools.includes('my_work'), 'and every tool a private thread has');
  const prompt = systemText(design.seen);
  assert.match(prompt, /THIS THREAD'S DESIGN/);
  assert.match(prompt, /THE CURRENT VERSION \(version 3\), its whole HTML:/);
  assert.match(prompt, /saved as version 4 when you reply/, 'it is told the number it saves');
  assert.match(prompt, /offer it with offer_plan: its card files the request with this design as\s+its plan/);
  assert.match(prompt, /offer_request is only for something that is not this design/);
  assert.doesNotMatch(prompt, /draw_screen|the designer answers/);

  const plain = turn([{ calls: [call('reply', { text: 'Nothing is under way for you.' })] }], {
    design: null, message: { id: 81, content: 'what are you working on?', threadRootId: 500 },
  });
  await plain.run;
  const plainTools = plain.offered[0];
  for (const name of ['write_screen', 'edit_design', 'edit_artifact', 'capture_page', 'offer_plan', 'list_files', 'edit_file', 'apply_changes']) {
    assert.ok(!plainTools.includes(name), `${name} is not offered in an ordinary thread`);
  }
  assert.ok(plainTools.includes('start_design'), 'a design can be started there');
  const plainPrompt = systemText(plain.seen);
  assert.doesNotMatch(plainPrompt, /THIS THREAD'S DESIGN|THIS THREAD'S LIVE DRAFT|THE CURRENT VERSION/);
  assert.ok(plainPrompt.length < prompt.length, 'an ordinary chat carries no design section');
  assert.equal(plain.sent.length, 1);
  assert.equal(plain.sent[0].metadata.kind, 'chat');
});

test('start_design loads the design for the rest of the turn, and that turn saves version 1 itself', async () => {
  const threadsMade = [];
  const steps = [
    { calls: [call('start_design', { what: 'A seed calendar', title: 'Seed calendar' })] },
    { calls: [call('write_screen', { title: 'Seed calendar', size: 'phone', html: '<html><body><h1>Seed calendar</h1><p>Sow peas in March</p></body></html>' })] },
    { calls: [call('reply', { text: 'Here is a first go.', summary: 'A month grid with what to sow each week' })] },
  ];
  const h = turn(steps, {
    design: null,
    message: { id: 82, content: 'Can you draw a seed calendar?', threadRootId: 500 },
    deps: {
      designThreads: {
        ...realThreads,
        async draftingThread() { return { rootId: 500, conversationId: 45, threadId: null, kind: 'ask', app: null, about: null }; },
        async designFor() { return null; },
        async ensureDesign(_pool, _config, args) { threadsMade.push(args); return { ...DESIGN, latest: 0, versions: [], app: null, title: 'Seed calendar' }; },
        async addVersion() { return { version: 1 }; },
        async noteVersionMessage() {},
        async planTargetOf() { return null; },
      },
    },
  });
  await h.run;
  assert.ok(!h.offered[0].includes('capture_page'), 'no design tools before it starts one');
  assert.ok(h.offered[1].includes('capture_page') && h.offered[1].includes('edit_artifact'), 'its tools from the next round');
  assert.ok(h.seen[1].some((m) => m.role === 'system' && /THIS THREAD'S DESIGN/.test(m.content)), 'and its section');
  assert.equal(threadsMade.length, 1, 'the thread holds the design now');
  assert.equal(h.sent.length, 1, 'one reply');
  assert.equal(h.sent[0].metadata.kind, 'design_version');
  assert.equal(h.sent[0].metadata.designVersion, 1);
  assert.equal(h.sent[0].content, 'Here is a first go.\n\nVersion 1: A month grid with what to sow each week.');
  assert.ok(h.doings.some((d) => d?.kind === 'drawing' && d.version === 1), 'the working card says the version it draws');
});

test('a draft thread\'s turn has the draft tools and section, and saves the change it says it made', async () => {
  const applied = [];
  const files = new Map([['public/index.html', '<button class="start">Start</button>']]);
  const liveDrafts = {
    async listFiles() { return [...files.keys()].map((path) => ({ path, size: files.get(path).length })); },
    async readFile(_draft, p) { return files.get(p) ?? null; },
    async editsOf() { return []; },
    async byId() { return { ...DRAFT, head_sha: 'b'.repeat(40) }; },
    async applyEdit(_pool, _config, args) { applied.push(args); return { ok: true, head: 'b'.repeat(40), preview: { ok: true, bootMs: 900 } }; },
  };
  const h = turn([
    { calls: [call('read_file', { path: 'public/index.html' })] },
    { calls: [call('edit_file', { path: 'public/index.html', edits: [{ find: 'class="start"', replace: 'class="start big"' }] })] },
    { calls: [call('apply_changes', { summary: 'Bigger Start button' })] },
    { calls: [call('reply', { text: 'I\'ve made the Start button bigger. The preview has it now.' })] },
  ], {
    design: null,
    message: { id: 83, content: 'Make the start button bigger', threadRootId: 700 },
    deps: { threadRootId: 700, threadDraft: null, threadLiveDraft: DRAFT, liveDrafts },
  });
  await h.run;
  for (const name of ['list_files', 'search_code', 'read_file', 'edit_file', 'write_file', 'apply_changes']) {
    assert.ok(h.offered[0].includes(name), `${name} under an open draft`);
  }
  assert.ok(h.offered[0].includes('offer_request') && h.offered[0].includes('my_work'), 'and every tool a private thread has');
  assert.match(systemText(h.seen), /THIS THREAD'S LIVE DRAFT/);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].files[0].content, '<button class="start big">Start</button>');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content, 'I\'ve made the Start button bigger. The preview has it now.');
  assert.deepEqual(h.sent[0].metadata.liveDraft, { id: 31, head: 'b'.repeat(40), app: 'garden' });
  assert.ok(h.doings.some((d) => d?.kind === 'changing_draft'), 'the working card says it is changing the draft');
});

test('a draft\'s reply is checked: a change it says it made with nothing saved goes back, and is never sent as done', async () => {
  const liveDrafts = {
    async listFiles() { return [{ path: 'public/index.html', size: 10 }]; },
    async readFile() { return '<p>x</p>'; },
    async editsOf() { return []; },
    async byId() { return DRAFT; },
    async applyEdit() { throw new Error('never saved'); },
  };
  const h = turn([
    { calls: [call('reply', { text: 'I\'ve made the Start button bigger.' })] },
    { calls: [call('reply', { text: 'I haven\'t changed it yet: which button do you mean, the one on the home screen?' })] },
  ], {
    design: null,
    message: { id: 84, content: 'Make the start button bigger', threadRootId: 700 },
    deps: { threadRootId: 700, threadDraft: null, threadLiveDraft: DRAFT, liveDrafts },
  });
  await h.run;
  const note = h.seen[1].at(-1);
  assert.equal(note.role, 'user');
  assert.match(note.content, /says you changed or saved the draft/);
  assert.match(note.content, /Nothing was saved to the draft this turn\. Make the change with edit_file and save it with apply_changes/);
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(h.sent[0].content, /I've made/);
  // The claim, by itself.
  const found = (text, turnFacts) => claims.check(claims.mentions(text), { turn: turnFacts }).map((p) => p.kind);
  assert.deepEqual(found('I\'ve made the button bigger.', { liveDraft: true, draftSaved: false }), ['draft_done']);
  assert.deepEqual(found('I\'ve made the button bigger.', { liveDraft: true, draftSaved: true }), []);
  assert.deepEqual(found('The preview now shows the change.', { liveDraft: true }), ['draft_done']);
  assert.deepEqual(found('I\'ve made the button bigger.', {}), [], 'only where a live draft is open');
});

// ── 3. Approval files the design ─────────────────────────────────────────

test('"lgtm, can you implement?" in a design thread is offer_plan, and its card files the design as the plan', async () => {
  const h = turn([
    { calls: [call('offer_plan', { target: 'new' })] },
    { calls: [call('reply', { text: 'New request files it on RecipeBot with version 3 as its plan, publicly, under your name.' })] },
  ], { message: { id: 85, content: 'Nice, yeah lgtm. Can you implement?', threadRootId: 500 } });
  await h.run;
  assert.equal(h.offers.length, 1, 'the design is offered as a plan');
  assert.equal(h.offers[0].design.latest, 3, 'the version it holds, none drawn this turn');
  assert.equal(h.sent.length, 1, 'one message: the plan card');
  assert.equal(h.sent[0].card.kind, 'post_design', 'File it attaches the design');
  assert.equal(h.sent[0].card.designVersion, 3);
  assert.equal(h.sent[0].card.privateThreadId, 7);
  assert.match(h.sent[0].content, /\*\*RecipeBot\*\* · a plan: version 3 of Request page/);
  assert.equal(h.versions.length, 0, 'nothing new is saved');
});

test('offer_request on the design\'s own project is sent back to offer_plan, unless it is something else', async () => {
  const draftArgs = { project: 'recipebot', title: 'Request page', details: 'Show the earlier steps.', doneWhen: ['It shows them.'] };
  const h = turn([
    { calls: [call('offer_request', draftArgs)] },
    { calls: [call('offer_plan', {})] },
    { calls: [call('reply', { text: 'Tap New request to file it with this design as its plan.' })] },
  ], { message: { id: 86, content: 'lgtm, file it', threadRootId: 500 } });
  await h.run;
  const refused = JSON.parse(h.seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'coffer_request').content);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /To file this design, offer it with offer_plan/);
  assert.match(refused.error, /notTheDesign: true/);
  assert.equal(h.offers.length, 1);
  assert.equal(h.sent[0].card.kind, 'post_design');
  assert.ok(h.offered[0].includes('offer_request'), 'offer_request stays for what is not this design');
  const offerTool = mayor.TOOLS.find((tool) => tool.function.name === 'offer_request');
  assert.equal('notTheDesign' in offerTool.function.parameters.properties, false, 'an ordinary thread\'s offer_request is unchanged');
});

// ── 4. One reply: the answer, then the version it saved ──────────────────

test('a question and a change in one message: answered first, then the version saved, with its card', async () => {
  const summary = 'The earlier steps are back, folded into one line above the replies';
  const h = turn([
    { calls: [call('edit_design', { edits: [{ find: '<p class="replies">Replies</p>', replace: '<p class="earlier">Show 2 earlier steps</p><p class="replies">Replies</p>' }] })] },
    { calls: [call('reply', { text: 'They were "Asked" and "Planned", from the line in your screenshot.', summary })] },
  ]);
  await h.run;
  const edited = JSON.parse(h.seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'cedit_design').content);
  assert.deepEqual([edited.ok, edited.version], [true, 4], 'the edit says the version it is saved as');
  assert.equal(h.versions.length, 1, 'one version for the turn');
  assert.equal(h.versions[0].note, summary, 'its note is the one summary, not the edits\' notes joined');
  assert.match(h.versions[0].html, /Show 2 earlier steps/);
  assert.equal(h.sent.length, 1, 'one reply, from one turn');
  assert.equal(h.sent[0].content, `They were "Asked" and "Planned", from the line in your screenshot.\n\nVersion 4: ${summary}.`);
  assert.deepEqual(
    [h.sent[0].metadata.kind, h.sent[0].metadata.designVersion, h.sent[0].metadata.appSlug, h.sent[0].metadata.designTitle],
    ['design_version', 4, 'recipebot', 'Request page'],
  );
  assert.deepEqual(h.notes, [{ threadId: 7, version: 4, messageId: 901 }], 'the version knows its message');
  assert.ok(h.doings.some((d) => d?.kind === 'drawing' && d.version === 4), '"Drawing version 4"');
  assert.ok(h.offered[0].includes('reply'));
  const replyTool = mayor.DESIGN_REPLY_TOOL.function.parameters.properties;
  assert.ok(replyTool.summary, 'the design\'s reply carries the summary');
  assert.match(replyTool.text.description, /First answer any question in their message/);
});

test('a long summary is said once, shortened at a word, in the turn\'s own version line', async () => {
  const summary = `The earlier steps are back above the replies, ${'with each step named in full and folded into one line '.repeat(8)}done`;
  const h = turn([
    { calls: [call('edit_design', { edits: [{ find: 'Replies', replace: 'Replies and steps' }] })] },
    { calls: [call('reply', { text: 'Done.', summary })] },
  ], { message: { id: 87, content: 'Bring back the earlier steps', threadRootId: 500 } });
  await h.run;
  const line = h.sent[0].content.split('\n\n')[1];
  assert.match(line, /^Version 4: The earlier steps are back above the replies, with each step/);
  assert.ok(line.length <= 'Version 4: '.length + 300 + 1, 'at most the note\'s room');
  assert.match(line, /\b(?:with|each|step|named|in|full|and|folded|into|one|line)…$/, 'cut at the end of a word, with an ellipsis');
  assert.equal(h.versions[0].note, summary, 'the version keeps the one summary (addVersion shortens it at a word)');
});

test('the version line names the version, with one summary shortened at a word, never mid-word', () => {
  assert.equal(realThreads.versionLine(4, 'The earlier steps are back'), 'Version 4: The earlier steps are back.');
  assert.equal(realThreads.versionLine(4, null), 'Version 4.');
  assert.equal(realThreads.versionLine(4, 'Version 3: kept the header'), 'Version 4: kept the header.', 'a number written into it goes');
  const joined = 'Styles for a public-thread shaped panel; Header card, earlier steps line; Removed the old composer markup';
  assert.equal(realThreads.versionLine(3, joined), `Version 3: ${joined}.`, 'one summary is said as it was written, never split or rejoined');
  const long = `${'word '.repeat(80)}Trimmed the right panel so the replies fit`;
  const line = realThreads.versionLine(5, long);
  assert.ok(line.length <= 'Version 5: '.length + 300 + 1);
  assert.match(line, /word…$/, 'cut at the end of a word, with an ellipsis');
  assert.equal(realThreads.clipWords('one two three', 9), 'one two…');
  assert.equal(realThreads.clipWords('supercalifragilistic', 6), 'super…', 'a single word longer than the room is the one cut');
  assert.equal(realThreads.clipWords('short', 20), 'short');
});

// ── 5. A request's thread: only unambiguous signals skip the model ───────

function requestThread(t, { open = null, plan = null, answers = [] } = {}) {
  const conversations = require('../src/services/conversations');
  const real = conversations.withLockedAudience;
  conversations.withLockedAudience = async (_pool, _actor, _id, callback) => { await callback([2, 9]); return [2, 9]; };
  t.after(() => { conversations.withLockedAudience = real; });
  const turns = [];
  const sent = [];
  const runs = [];
  const posts = [];
  const asked = [];
  const pool = {
    async query(sql, params) {
      asked.push(String(sql));
      if (/FROM platform_settings/.test(sql)) {
        return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }, { key: 'homeroom_bot_dm_chat', value: 'on' }] };
      }
      if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ '?column?': 1 }] };
      // The thread's root is the request's card (threadRequest).
      if (/JOIN apps a ON a\.id = d\.app_id/.test(sql) && /homeroom_bot_requesters/.test(sql)) {
        return { rows: [{ app_id: 5, issue_number: 12, slug: 'recipebot', name: 'RecipeBot', issue_title: 'Sort by date', first_version: false }] };
      }
      if (/WHERE user_id = \$1 AND question_status = 'open'/.test(sql)) return { rows: open ? [open] : [] };
      if (/metadata->'homeroomBot'->'answers' AS answers/.test(sql)) return { rows: [{ answers }] };
      if (/metadata->'homeroomBot'->'plan' AS plan/.test(sql)) return { rows: plan ? [plan] : [] };
      if (/FROM homeroom_bot_dm_messages WHERE message_id = \$1 AND user_id = \$2/.test(sql)) {
        if (plan && Number(params[0]) === Number(plan.message_id)) {
          return { rows: [{ message_id: plan.message_id, conversation_id: 45, app_id: 5, issue_number: 12, kind: 'plan', question_status: 'open', run_id: 77 }] };
        }
        if (open && Number(params[0]) === Number(open.message_id)) return { rows: [open] };
        return { rows: [] };
      }
      if (/SELECT id, slug, name FROM apps WHERE id = \$1/.test(sql)) return { rows: [{ id: 5, slug: 'recipebot', name: 'RecipeBot' }] };
      if (/UPDATE homeroom_bot_runs/.test(sql)) runs.push(params);
      return { rows: [] };
    },
  };
  const deps = {
    bot: BOT,
    ws: {
      pushConversationEvent() { return 1; },
      // A tapped answer is posted on the request at once (postOnRequest).
      async handleMessage(_pool, _who, msg) { posts.push(msg.content); return { ok: false, code: 'stopped_here' }; },
    },
    designThreads: { async threadOf() { return null; } },
    liveDrafts: { async threadOf() { return null; } },
    mayor: {
      async decideOffer() { return null; },
      async decideTyped() { return null; },
      async reviseAttached() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args); return { turn: args.message.id }; },
      async offerPost(_pool, args) { sent.push({ draft: args.text }); return { messageId: 950 }; },
    },
  };
  // What the deterministic paths go on to send is their own suites' (the
  // chat's transport needs a real database): here it is enough that they,
  // and not the model, took the message.
  const send = (message) => dm.noteUserMessage(pool, {}, { user: EVAN, conversationId: 45, message, deps })
    .catch((err) => ({ deterministic: true, err: err.message }));
  return { turns, sent, runs, posts, asked, send };
}

const QUESTION = { message_id: 400, conversation_id: 45, app_id: 5, issue_number: 12, kind: 'question', question_status: 'open' };
const PLAN = { message_id: 410, conversation_id: 45, action_id: 3, plan: { bullets: ['Add a sort menu', 'Sort by date', 'Remember the choice'] }, thread_root_id: 300 };

test('a request\'s thread: a typed reply to an open question reaches the turn; a tapped answer is decided at once', async (t) => {
  const h = requestThread(t, { open: QUESTION, answers: ['Newest first', 'Oldest first'] });
  assert.deepEqual(await h.send({ id: 90, content: 'whichever was changed last, and when will it be ready?', threadRootId: 300 }), { turn: 90 });
  assert.equal(h.turns.length, 1, 'typed words are the turn\'s, which drafts them with answer_question when they answer it');
  assert.deepEqual(h.turns[0].deps.threadRequest.issueNumber, 12);
  assert.ok(mayor.TOOLS.some((tool) => tool.function.name === 'answer_question'));
  assert.deepEqual(h.posts, [], 'and nothing typed is posted on the request');
  // A tapped chip sends the suggested answer's own words: no model.
  const tapped = await h.send({ id: 91, content: 'Oldest first', threadRootId: 300 });
  assert.equal(h.turns.length, 1, 'a tapped answer never waits on the model');
  assert.notDeepEqual(tapped, { turn: 91 });
  assert.equal(h.posts.length, 1, 'it is posted on the request, as the tap chose');
  assert.match(h.posts[0], /^Oldest first\n\n\(Answered in a chat with Homeroom bot\.\)$/);
});

test('a request\'s thread: a reply quoting the question or the plan card stays deterministic', async (t) => {
  const asked = requestThread(t, { open: QUESTION });
  await asked.send({ id: 92, content: 'whichever was changed last', threadRootId: 300, reply: { id: 400 } });
  assert.equal(asked.turns.length, 0, 'a reply quoting the question is its answer');
  assert.deepEqual(asked.sent, [{ draft: 'whichever was changed last' }], 'drafted under the bot\'s reply with Post it, as before');

  const planned = requestThread(t, { plan: PLAN });
  await planned.send({ id: 93, content: 'Make it work for my partner too', threadRootId: 300, reply: { id: 410 } });
  assert.equal(planned.turns.length, 0, 'a reply quoting the plan changes it');
  assert.equal(planned.runs.length, 1, 'planned again with their words');
  assert.equal(planned.runs[0][1], 'Make it work for my partner too');
});

test('a request\'s thread: a question about a waiting plan reaches the turn, and nothing is planned again', async (t) => {
  const h = requestThread(t, { plan: PLAN });
  assert.deepEqual(await h.send({ id: 94, content: 'what does step 3 mean?', threadRootId: 300 }), { turn: 94 });
  assert.equal(h.runs.length, 0, 'no new plan for a question');
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadRequest.issueNumber, 12);
  assert.ok(mayor.TOOLS.some((tool) => tool.function.name === 'change_plan'), 'the turn plans it again only when asked to (change_plan)');
  assert.ok(profiles.profileOf('private').tools.includes('change_plan'));
  const lines = mayor.systemPrompt({ username: 'evan', request: { appSlug: 'recipebot', appName: 'RecipeBot', issueNumber: 12 } });
  assert.match(lines, /a question about the plan \(what a step\s+means, why\) is answered from the plan and changes nothing; asking for something in it to change is change_plan/);
});

test('change_plan runs the plan card\'s own change, as a tool: nothing is sent from it, and the turn says what it did', async () => {
  const changed = [];
  const ctx = {
    bot: BOT, user: EVAN, settings: {}, messageId: 96, userText: 'Make it work for my partner too', appIds: new Set(), cards: [],
    deps: {
      threadRequest: { appId: 5, appSlug: 'recipebot', appName: 'RecipeBot', issueNumber: 12 },
      dmSvc: {
        async waitingPlan() { return { messageId: 410 }; },
        async quotedTarget() { return { message_id: 410, app_id: 5, issue_number: 12, kind: 'plan', run_id: 77 }; },
        async changePlan(_pool, args) { changed.push(args); return { said: 'Thanks. I\'ll work that into a new plan for RecipeBot and send it here.', replanned: true }; },
      },
    },
  };
  const out = await mayor.changePlanTool(fakePool(), ctx, {});
  assert.deepEqual([out.ok, out.said], [true, 'Thanks. I\'ll work that into a new plan for RecipeBot and send it here.']);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].asTool, true, 'run as a tool: its words are the turn\'s, not a message of its own');
  assert.equal(changed[0].message.content, 'Make it work for my partner too');
  assert.equal(ctx.started, 'RecipeBot', 'the reply may say it is planned again');
  // A complicated change's plan: their words drafted for the request, under the reply.
  const draftCtx = { ...ctx, started: null, offer: null, deps: { ...ctx.deps, dmSvc: { ...ctx.deps.dmSvc, async changePlan() { return { draft: true }; } } } };
  const drafted = await mayor.changePlanTool(fakePool(), draftCtx, {});
  assert.equal(drafted.ok, true);
  assert.deepEqual([draftCtx.offer.kind, draftCtx.offer.title, draftCtx.offer.targetMessageId], ['post_reply', 'plan_change', 410]);
  assert.equal(draftCtx.planChangeDrafted, 410);
  // No request named and none in the thread: it asks.
  assert.equal((await mayor.changePlanTool(fakePool(), { ...ctx, started: null, deps: {} }, {})).ok, false);
});

test('a request\'s thread: Build it under a waiting plan is its button, decided without the model', async (t) => {
  const h = requestThread(t, { plan: PLAN });
  await h.send({ id: 95, content: 'Build it', threadRootId: 300 });
  assert.equal(h.turns.length, 0, 'Build it is the plan card\'s button');
  assert.ok(h.asked.some((sql) => /FROM bot_cards WHERE message_id = \$1 AND user_id = \$2 AND kind = 'build_plan'/.test(sql)),
    'it looks for the plan\'s Build it, as a tap would');
});

// ── 7. Asking says why ───────────────────────────────────────────────────

test('a question to them says first what was found that makes it necessary', () => {
  const prompt = mayor.systemPrompt({ username: 'evan' });
  assert.match(prompt, /When you ask them something, first say in one clause what you found that makes the question necessary/);
  assert.doesNotMatch(prompt, /draw_screen/);
  assert.match(prompt, /\(start_design\): it gives you the design tools for the rest of this turn/);
  assert.doesNotMatch(mayor.systemPrompt({ username: 'evan', designing: true }), /\(start_design\)/,
    'a thread that holds a design is told how it draws there instead');
});

test('the design and draft sessions keep their handlers: no answer loop of their own is left', () => {
  for (const name of ['answer', 'draw']) assert.equal(typeof designBot[name], 'undefined', `design-bot.js ${name}`);
  for (const name of ['answer', 'opened']) assert.equal(typeof draftBot[name], 'undefined', `live-draft-bot.js ${name}`);
  assert.equal(typeof designBot.openSession, 'function');
  assert.equal(typeof draftBot.openSession, 'function');
  const designNames = designBot.TOOLS.map((tool) => tool.function.name);
  assert.ok(!designNames.includes('reply') && !designNames.includes('offer_request') && !designNames.includes('close_thread'),
    'the chat\'s own reply, offer_request and close_thread serve a design thread');
  for (const tool of ['write_artifact', 'edit_artifact']) {
    const props = designBot.TOOLS.find((t) => t.function.name === tool).function.parameters.properties;
    assert.equal('note' in props, false, `${tool} takes no note: the reply's summary is the version's one line`);
  }
  assert.equal(draftBot.TOOLS.some((tool) => tool.function.name === 'reply'), false);
});
