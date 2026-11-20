'use strict';

// #6683: a thread that holds a design answers like any other chat thread.
//
// Step 6 (19 Nov 2026, #6864): and every message there, the design's own
// included, is the chat's turn (homeroom-bot-mayor.js runDmTurn): a comment
// pinned on the preview and a reply to one of its versions reach it too, told
// the design, its project and its version (designThreadLines). The turn
// draws and changes the design itself with the design capability
// (design-bot.js openSession): a later version edits what the thread holds,
// and only a first drawing reads the app's entry page.

const test = require('node:test');
const assert = require('node:assert/strict');

const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const profiles = require('../src/services/bot-profiles');

const BOT = { id: 2, username: 'homeroom_bot' };
const ADA = { id: 9, username: 'ada', hasPlatformAccess: true };

const DESIGN = {
  threadId: 7,
  rootId: 500,
  conversationId: 45,
  state: 'open',
  number: null,
  kind: 'ask',
  about: null,
  app: { slug: 'recipebot', name: 'RecipeBot' },
  title: 'RecipeBot home screen',
  surface: 'app',
  route: null,
  width: 390,
  height: 844,
  latest: 2,
  versions: [
    { version: 1, author: 'bot', note: null, messageId: 600, at: null },
    { version: 2, author: 'bot', note: null, messageId: 610, at: null },
  ],
};

// The queries noteUserMessage makes before the routing: a DM pair, the bot's
// settings, and nothing else. Everything else is an empty result.
function fakePool() {
  return {
    async query(sql) {
      if (/FROM platform_settings/.test(sql)) {
        return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }, { key: 'homeroom_bot_dm_chat', value: 'on' }] };
      }
      if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
}

// typingHarness, as tests/homeroom-bot-dm.test.js has it: the bot's typing
// goes to the conversation, which needs the pair's members.
function typingHarness(t) {
  const conversations = require('../src/services/conversations');
  const real = conversations.withLockedAudience;
  conversations.withLockedAudience = async (_pool, _actor, _conversationId, callback) => {
    await callback([2, 9]);
    return [2, 9];
  };
  t.after(() => { conversations.withLockedAudience = real; });
  const ws = { pushConversationEvent() { return 1; } };
  return { ws };
}

function harness(t, { design = DESIGN } = {}) {
  const { ws } = typingHarness(t);
  const turns = [];
  const deps = {
    bot: BOT,
    ws,
    designThreads: { async threadOf() { return design; } },
    liveDrafts: { async threadOf() { return null; } },
    mayor: {
      async decideOffer() { return null; },
      async decideTyped() { return null; },
      async reviseAttached() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args); return { turn: args.message.id }; },
    },
  };
  const send = async (message) => dm.noteUserMessage(fakePool(), {}, { user: ADA, conversationId: 45, message, deps });
  return { turns, send };
}

test('a plain message in a design thread runs the chat turn, told which design the thread holds', async (t) => {
  const h = harness(t);
  const said = await h.send({ id: 70, content: 'The Homeroom sidebar cut off my community menu. Can you file that?', threadRootId: 500 });
  assert.deepEqual(said, { turn: 70 });
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, DESIGN, 'the chat turn is told the design, its project and its versions');
  assert.equal(profiles.kindInChat(h.turns[0].deps), 'private');
  assert.deepEqual(profiles.capabilitiesInChat(h.turns[0].deps), ['design'], 'with the design capability');
  const offered = profiles.profileOf(profiles.kindInChat({})).tools;
  for (const tool of ['offer_request', 'start_request', 'comment_on_request', 'my_work', 'start_design']) {
    assert.ok(offered.includes(tool), `${tool} is offered in a design thread as in any other`);
  }
});

test('step 6: a comment pinned on the preview is the chat turn\'s too, told the design', async (t) => {
  const h = harness(t);
  const said = await h.send({
    id: 71, content: 'Make this bigger', threadRootId: 500,
    metadata: { designPin: { version: 2, x: 0.4, y: 0.6 } },
  });
  assert.deepEqual(said, { turn: 71 }, 'no designer answers in its place');
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, DESIGN);
  assert.deepEqual(h.turns[0].message.metadata.designPin, { version: 2, x: 0.4, y: 0.6 }, 'with its pin');
});

test('step 6: a reply to one of its versions, and to anything else in the thread, is the chat turn\'s', async (t) => {
  const h = harness(t);
  await h.send({ id: 72, content: 'Version 2 is worse: put the cards back', threadRootId: 500, reply: { id: 610 } });
  await h.send({ id: 73, content: 'And what happened to my timer change?', threadRootId: 500, reply: { id: 555 } });
  assert.equal(h.turns.length, 2);
  for (const args of h.turns) assert.equal(args.deps.threadDesign, DESIGN);
});

test('a thread that holds no design is unchanged: the chat turn, and no design', async (t) => {
  const h = harness(t, { design: null });
  await h.send({ id: 74, content: 'file a request for a shopping list', threadRootId: 501 });
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, undefined);
  assert.deepEqual(profiles.capabilitiesInChat(h.turns[0].deps), []);
});

// The spec's edge case: a closed design (`state` not open, posted or filed)
// is still the chat turn's thread, which says it is not changed there
// (design-bot.js openSession refuses it: CLOSED_TEXT) and answers the rest.
test('a closed design still answers the thread: its own message too, and the turn is told it is put away', async (t) => {
  const closed = { ...DESIGN, state: 'closed' };
  const h = harness(t, { design: closed });
  await h.send({ id: 76, content: 'Where does my timer change stand?', threadRootId: 500 });
  await h.send({ id: 77, content: 'Darken the header', threadRootId: 500, metadata: { designPin: { version: 2, x: 0.5, y: 0.5 } } });
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[1].deps.threadDesign, closed);
  const session = await designBot.openSession({ async query() { return { rows: [] }; } }, {}, {
    bot: BOT, user: ADA, settings: {}, conversationId: 45, message: { id: 77 }, design: closed,
    room: { rootId: 500, threadId: 7, conversationId: 45, app: null },
  });
  assert.deepEqual(session, { refused: designBot.CLOSED_TEXT, why: 'closed' });
  const prompt = mayor.systemPrompt({ username: 'ada', thread: { design: closed, designRefused: designBot.CLOSED_TEXT } });
  assert.match(prompt, /It cannot be changed in this turn\. If they ask you to change it, say so: "This thread was put away/);
  assert.doesNotMatch(prompt, /You draw, change and redraw it yourself/);
});

test('the chat turn in a design thread is told the design, its project and its version, and that it draws it itself', () => {
  const prompt = mayor.systemPrompt({ username: 'ada', thread: { design: DESIGN }, designing: true });
  assert.match(prompt, /This thread holds a design, "RecipeBot home screen", of the screen of project "recipebot"\./);
  assert.match(prompt, /Its newest version is version 2\./);
  assert.match(prompt, /You draw, change and redraw it yourself, here, with the design tools/);
  assert.match(prompt, /your one reply says the version you saved/);
  assert.doesNotMatch(prompt, /draw_screen|designer/);
  assert.match(prompt, /a request may\s+be offered on any project they can see/);
  assert.match(prompt, /Never say\s+something cannot be done in this thread/);
  assert.match(prompt, /never tell them to do it themselves somewhere else/);
  // A design for no project yet, and one of Homeroom's own pages, are named as those.
  assert.match(mayor.systemPrompt({ username: 'ada', thread: { design: { ...DESIGN, surface: 'new', app: null } } }),
    /of a project that does not exist yet/);
  assert.match(mayor.systemPrompt({ username: 'ada', thread: { design: { ...DESIGN, surface: 'platform', app: null } } }),
    /of a page of Homeroom itself/);
  // A thread with no design says none of it.
  assert.doesNotMatch(mayor.systemPrompt({ username: 'ada', thread: { draft: null } }), /holds a design/);
});

test('start_design uses the design\'s title and refuses another project\'s screen', async () => {
  const pool = {
    async query(sql, params) {
      if (/FROM apps/.test(sql)) {
        const slug = String(params?.[0] || '').toLowerCase();
        if (slug === 'recipebot') return { rows: [{ id: 5, slug: 'recipebot', name: 'RecipeBot', view_visibility: 'public', moderation_suspended_at: null }] };
        if (slug === 'geneva-hikes') return { rows: [{ id: 6, slug: 'geneva-hikes', name: 'Geneva Hikes', view_visibility: 'public', moderation_suspended_at: null }] };
      }
      return { rows: [] };
    },
  };
  const asked = [];
  const loadDesign = async (args) => { asked.push(args); return { ok: true, version: 3 }; };
  const ctx = { user: { id: 9 }, deps: { threadDesign: DESIGN }, loadDesign };
  const drawn = await mayor.startDesign(pool, ctx, { what: 'make the recipe cards bigger' });
  assert.equal(drawn.ok, true, 'the design\'s own title is enough, so what alone is enough');
  assert.deepEqual(asked, [{ app: null, title: 'RecipeBot home screen', brief: 'make the recipe cards bigger' }], 'it loads the design for this turn');

  const other = await mayor.startDesign(pool, { user: { id: 9 }, deps: { threadDesign: DESIGN }, loadDesign }, { what: 'a map screen', project: 'geneva-hikes' });
  assert.equal(other.ok, false, 'a screen of another project is not drawn into this thread\'s design');
  assert.match(other.error, /design is of RecipeBot/);
  assert.match(other.error, /new thread/);

  // Without a design, a title is still required, as anywhere else.
  const plain = await mayor.startDesign(pool, { user: { id: 9 }, deps: {}, loadDesign }, { what: 'a map screen' });
  assert.equal(plain.ok, false);
  assert.match(plain.error, /name the screen/);
  // A new screen this turn draws already: nothing is opened twice.
  assert.match((await mayor.startDesign(pool, { ...ctx, caps: { design: { fresh: true, capability: 'design' } } }, { what: 'x' })).note, /yours already/);
  // K (20 Nov 2026): with an artifact the thread holds open, it is a new screen beside it.
  asked.length = 0;
  assert.equal((await mayor.startDesign(pool, { ...ctx, caps: { design: { fresh: false, capability: 'design', artifactId: 1 } } }, { what: 'x' })).ok, true);
  assert.equal(asked.length, 1, 'the turn opens a new one');
  // A first version's thread draws no screen.
  assert.match((await mayor.startDesign(pool, { user: { id: 9 }, deps: { threadKind: 'first_version' } }, { what: 'x', title: 'X' })).error,
    /No screen is drawn in a first version's thread/);
});

test('the design section says this one turn answers everything else in the thread', () => {
  const prompt = designBot.designPrompt({ username: 'ada', design: DESIGN, surface: 'app', version: 2, html: '<html></html>' });
  assert.match(prompt, /^THIS THREAD'S DESIGN\n/);
  assert.match(prompt, /Anything else they ask here \(a request to file, a change to ask about, where someone's work stands\) you answer\nas in any other thread, with your other tools/);
  assert.match(prompt, /never say something cannot be done in this thread/);
  assert.match(prompt, /never\s+tell them to ask somewhere else or to do it themselves/);
  assert.doesNotMatch(prompt, /You are Homeroom bot|answered by Homeroom bot in this same thread/, 'one identity, the chat\'s');
});

// ── The turn draws the next version itself (design-bot.js openSession) ────

const CONFIG = { port: 3000, selfAppSlug: 'homeroom' };
const APP = { id: 5, slug: 'recipebot', name: 'RecipeBot' };
const call = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function scripted(steps, seen = []) {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req.messages));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

function designTurn(steps, { design = null, current = null, message = null } = {}) {
  const seen = [];
  const versions = [];
  const sources = [];
  const sent = [];
  const realThreads = require('../src/services/design-threads');
  const pool = { async query() { return { rows: [] }; } };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', seesImages: false, sleep: async () => {}, openMcp: async () => null,
    streamDraft: false,
    dmSvc: { ...dm, async sendDm(_pool, args) { sent.push(args); return { messageId: 901 }; } },
    threadRootId: 500, threadDraft: null, threadKind: 'ask',
    ...(design ? { threadDesign: design } : {}),
    mayor: Object.assign(Object.create(mayor), {
      async findApp() { return APP; },
      async canView() { return true; },
      async sourceRepo(_pool, args) { sources.push(args.project); return { error: 'no_repo' }; },
    }),
    designThreads: {
      ...realThreads,
      surfaceFor: () => 'app',
      async draftingThread() { return { rootId: 500, threadId: 7, conversationId: 45, kind: 'ask', app: APP, about: null }; },
      async designFor() { return design; },
      async versionOf() { return current; },
      async ensureDesign() { return { threadId: 7, title: 'RecipeBot home', app: APP }; },
      async addVersion(_pool, args) { versions.push(args); return { version: (current?.version || 0) + versions.length }; },
      async noteVersionMessage() {},
    },
    botPictures: { async designPictures() { return []; } },
    designCapture: { async renderDesign() { return { ok: false }; }, findPage: () => null },
  };
  const run = mayor.runDmTurn(pool, CONFIG, {
    bot: BOT, user: ADA, settings: { mode: 'live', perPerson: 2 }, conversationId: 45,
    message: message || { id: 80, content: 'Make the recipe cards bigger', threadRootId: 500 },
    deps,
  });
  return { run, seen, versions, sources, sent };
}

test('a turn in a thread that already has a version edits it, reading no entry page', async () => {
  const turn = designTurn([
    { calls: [call('edit_design', { edits: [{ find: 'small', replace: 'big' }] })] },
    { calls: [call('reply', { text: 'Done.', summary: 'Bigger recipe cards' })] },
  ], { design: DESIGN, current: { version: 2, html: '<html><body><div class="cards">small</div></body></html>' } });
  await turn.run;

  assert.deepEqual(turn.sources, [], 'a later version reads no entry page');
  assert.equal(turn.versions.length, 1, 'the next version is saved, not a first drawing');
  assert.equal(turn.versions[0].html.includes('big'), true);
  assert.equal(turn.versions[0].html.includes('small'), false);
  assert.equal(turn.versions[0].note, 'Bigger recipe cards');
  assert.doesNotMatch(turn.seen[0].map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'), /THE APP'S SCREEN NOW/);
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, 'Done.\n\nVersion 3: Bigger recipe cards.');
});

test('a reply to one of its versions is told which version it answers', async () => {
  const turn = designTurn([
    { calls: [call('reply', { text: 'Version 1 had them as a list.' })] },
  ], {
    design: DESIGN, current: { version: 2, html: '<html><body><div class="cards">small</div></body></html>' },
    message: { id: 81, content: 'what did this one have before?', threadRootId: 500, reply: { id: 600 } },
  });
  await turn.run;
  assert.ok(turn.seen[0].some((m) => m.role === 'system' && /their message replies to version 1 of the design/.test(m.content)));
  assert.equal(turn.versions.length, 0, 'nothing is saved when nothing changed');
  assert.equal(turn.sent[0].metadata.kind, 'chat');
});

test('a first drawing with no version still reads the app\'s entry page', async () => {
  const turn = designTurn([
    { calls: [call('start_design', { what: 'The home screen', title: 'RecipeBot home' })] },
    { calls: [call('write_screen', { html: '<html><body><h1>RecipeBot</h1></body></html>', title: 'RecipeBot home', size: 'phone' })] },
    { calls: [call('reply', { text: 'Drawn.' })] },
  ]);
  await turn.run;
  assert.deepEqual(turn.sources, ['recipebot'], 'a first drawing still starts from the app\'s own screen');
  assert.equal(turn.versions.length, 1);
  assert.equal(turn.versions[0].note, 'RecipeBot home', 'with no summary, a first drawing is named by its screen');
  assert.equal(turn.sent[0].metadata.designVersion, 1);
});
