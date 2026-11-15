'use strict';

// #6683: a thread that holds a design answers like any other chat thread.
//
// Only the design's own message goes to the designer: a comment pinned on
// the preview, or a reply to one of the design's versions
// (homeroom-bot-dm.js designDirect). Everything else runs the chat's turn
// (homeroom-bot-mayor.js runDmTurn), told the design, its project and its
// version (designThreadLines), with every tool a private thread has; its
// draw_screen still hands drawing work to the designer, which now makes the
// next version of that same design instead of treating it as a first drawing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const profiles = require('../src/services/bot-profiles');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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
  const trailing = {};
  const ws = {
    pushConversationEvent(memberIds, payload) {
      const key = `${payload.threadRootId || 0}`;
      if (payload.type === 'conversation_typing') trailing[key] = payload.typing;
      return 1;
    },
  };
  return { ws };
}

function harness(t, { design = DESIGN } = {}) {
  const { ws } = typingHarness(t);
  const turns = [];
  const designAnswers = [];
  const deps = {
    bot: BOT,
    ws,
    designThreads: { async threadOf() { return design; } },
    mayor: {
      async decideOffer() { return null; },
      async decideTyped() { return null; },
      async reviseAttached() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args); return { turn: args.message.id }; },
    },
    designBot: {
      async answer(_pool, _config, args) { designAnswers.push(args); return { design: args.design.rootId }; },
    },
  };
  const send = async (message) => {
    const said = await dm.noteUserMessage(fakePool(), {}, { user: ADA, conversationId: 45, message, deps });
    return said;
  };
  return { turns, designAnswers, send };
}

test('a plain message in a design thread runs the chat turn, told which design the thread holds', async (t) => {
  const h = harness(t);
  const said = await h.send({ id: 70, content: 'The Homeroom sidebar cut off my community menu. Can you file that?', threadRootId: 500 });
  assert.deepEqual(said, { turn: 70 });
  assert.equal(h.designAnswers.length, 0, 'the designer is not asked about a message that is not about the design');
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, DESIGN, 'the chat turn is told the design, its project and its versions');
  assert.equal('design' in h.turns[0].deps, false,
    'the answer runs the private profile (kindInChat reads deps.design), so all its tools are offered');
  assert.equal(profiles.kindInChat({ design: null, threadDesign: h.turns[0].deps.threadDesign }), 'private');
  const offered = profiles.profileOf(profiles.kindInChat({})).tools;
  for (const tool of ['offer_request', 'start_request', 'comment_on_request', 'my_work', 'draw_screen']) {
    assert.ok(offered.includes(tool), `${tool} is offered in a design thread as in any other`);
  }
});

test('a comment pinned on the preview goes straight to the designer', async (t) => {
  const h = harness(t);
  const said = await h.send({
    id: 71, content: 'Make this bigger', threadRootId: 500,
    metadata: { designPin: { version: 2, x: 0.4, y: 0.6 } },
  });
  assert.deepEqual(said, { design: 500 });
  assert.equal(h.turns.length, 0, 'the chat turn does not answer a pinned comment');
  assert.equal(h.designAnswers.length, 1);
  assert.equal(h.designAnswers[0].design, DESIGN);
});

test('a reply to one of its versions goes to the designer; a reply to anything else in the thread does not', async (t) => {
  const h = harness(t);
  await h.send({ id: 72, content: 'Version 2 is worse: put the cards back', threadRootId: 500, reply: { id: 610 } });
  assert.equal(h.designAnswers.length, 1, 'a version\'s message is the design\'s');
  assert.equal(h.turns.length, 0);
  await h.send({ id: 73, content: 'And what happened to my timer change?', threadRootId: 500, reply: { id: 555 } });
  assert.equal(h.designAnswers.length, 1, 'a reply to another message in the thread is the chat\'s');
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, DESIGN);
});

test('a thread that holds no design is unchanged: the chat turn, and no design', async (t) => {
  const h = harness(t, { design: null });
  await h.send({ id: 74, content: 'file a request for a shopping list', threadRootId: 501 });
  assert.equal(h.designAnswers.length, 0);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, undefined);
});

// The spec's edge case: a closed design (`state` not open, posted or filed)
// no longer takes the thread's ordinary talk, but its own messages still reach
// it (design-bot.js answers those with CLOSED_TEXT), so closing a design never
// turns the thread into one that refuses what any other thread does.
test('a closed design still answers the thread: only its own message reaches the designer', async (t) => {
  const closed = { ...DESIGN, state: 'closed' };
  const h = harness(t, { design: closed });
  await h.send({ id: 76, content: 'Where does my timer change stand?', threadRootId: 500 });
  assert.equal(h.designAnswers.length, 0, 'a closed design does not take an ordinary message');
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].deps.threadDesign, closed, 'the chat turn is told the design is closed');

  await h.send({
    id: 77, content: 'Darken the header', threadRootId: 500,
    metadata: { designPin: { version: 2, x: 0.5, y: 0.5 } },
  });
  assert.equal(h.designAnswers.length, 1, 'a pinned comment still goes to the designer');
  assert.equal(h.designAnswers[0].design.state, 'closed');
  assert.equal(h.turns.length, 1, 'and the chat turn does not answer it as well');
});

test('designDirect is pure: the pin and a version\'s message, and nothing else', () => {
  assert.equal(dm.designDirect({ content: 'x' }, DESIGN), false);
  assert.equal(dm.designDirect({ metadata: { designPin: { version: 1 } } }, DESIGN), true);
  assert.equal(dm.designDirect({ reply: { id: 600 } }, DESIGN), true);
  assert.equal(dm.designDirect({ replyToId: 610 }, DESIGN), true);
  assert.equal(dm.designDirect({ reply: { id: 611 } }, DESIGN), false);
  assert.equal(dm.designDirect(null, DESIGN), false);
  assert.equal(dm.designDirect({ metadata: { designPin: { version: 1 } } }, null), false);
});

test('the chat turn in a design thread is told the design, its project and its version, and that nothing is refused here', () => {
  const prompt = mayor.systemPrompt({ username: 'ada', thread: { design: DESIGN } });
  assert.match(prompt, /This thread holds a design, "RecipeBot home screen", of the screen of project "recipebot"\./);
  assert.match(prompt, /Its newest version is version 2\./);
  assert.match(prompt, /call draw_screen alone/);
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

test('draw_screen in a design thread uses its title and refuses another project\'s screen', async () => {
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
  const ctx = { user: { id: 9 }, deps: { threadDesign: DESIGN } };
  const drawn = await mayor.drawScreen(pool, ctx, { what: 'make the recipe cards bigger' });
  assert.equal(drawn.ok, true, 'the design\'s own title is enough, so what alone is enough');
  assert.equal(ctx.drawScreen.title, 'RecipeBot home screen');
  assert.equal(ctx.drawScreen.brief, 'make the recipe cards bigger');

  const other = await mayor.drawScreen(pool, { user: { id: 9 }, deps: { threadDesign: DESIGN } }, { what: 'a map screen', project: 'geneva-hikes' });
  assert.equal(other.ok, false, 'a screen of another project is not drawn into this thread\'s design');
  assert.match(other.error, /design is of RecipeBot/);
  assert.match(other.error, /new thread/);

  // Without a design, a title is still required, as anywhere else.
  const plain = await mayor.drawScreen(pool, { user: { id: 9 }, deps: {} }, { what: 'a map screen' });
  assert.equal(plain.ok, false);
  assert.match(plain.error, /name the screen/);
});

test('the designer is told the chat answers everything else in this thread', () => {
  const prompt = designBot.designPrompt({ username: 'ada', design: DESIGN, surface: 'app', version: 2, html: '<html></html>' });
  assert.match(prompt, /answered by Homeroom bot in this same thread/);
  assert.match(prompt, /never say something cannot be done in this thread/);
  assert.match(prompt, /never\s+tell them to ask somewhere else or to do it themselves/);
});

// ── A hand-over draws the next version (design-bot.js answer) ─────────────

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

function designTurn(steps, { design = null, current = null, handoff = false } = {}) {
  const seen = [];
  const versions = [];
  const sources = [];
  const realThreads = require('../src/services/design-threads');
  const pool = { async query() { return { rows: [] }; } };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', seesImages: false, sleep: async () => {},
    dm: { async sendDm() { return { messageId: 901 }; } },
    mayor: Object.assign(Object.create(mayor), {
      async recordTurn() {}, async turnsLastHour() { return 0; },
      async findApp() { return APP; },
      async canView() { return true; },
      async sourceRepo(_pool, args) { sources.push(args.project); return { error: 'no_repo' }; },
    }),
    designThreads: {
      ...realThreads,
      surfaceFor: () => 'app',
      async versionOf() { return current; },
      async ensureDesign() { return { threadId: 7, title: 'RecipeBot home', app: APP }; },
      async addVersion(_pool, args) { versions.push(args); return { version: (current?.version || 0) + versions.length }; },
      bareNote: realThreads.bareNote,
      versionLine: (version, note) => (note ? `Version ${version}: ${note}.` : `Version ${version}.`),
      async noteVersionMessage() {},
    },
    botPictures: { async designPictures() { return []; } },
  };
  const run = designBot.answer(pool, CONFIG, {
    bot: BOT, user: ADA, settings: { mode: 'live' }, conversationId: 45,
    message: { id: 80, content: 'Make the recipe cards bigger' },
    design, thread: { rootId: 500, threadId: 7, conversationId: 45, app: APP },
    handoff, deps,
  });
  return { run, seen, versions, sources };
}

test('a hand-over into a thread that already has a version edits it, reading no entry page', async () => {
  const turn = designTurn([
    { calls: [call('edit_design', { edits: [{ find: 'small', replace: 'big' }], note: 'bigger cards' })] },
    { calls: [call('reply', { text: 'The recipe cards are bigger now.' })] },
  ], { design: DESIGN, current: { version: 2, html: '<html><body><div class="cards">small</div></body></html>' }, handoff: true });
  await turn.run;

  assert.deepEqual(turn.sources, [], 'a later version reads no entry page');
  assert.equal(turn.versions.length, 1, 'the next version is saved, not a first drawing');
  assert.equal(turn.versions[0].html.includes('big'), true);
  assert.equal(turn.versions[0].html.includes('small'), false);
  assert.doesNotMatch(turn.seen[0].map((m) => m.content).join('\n'), /THE APP'S SCREEN NOW/);
});

test('a first drawing with no version still reads the app\'s entry page', async () => {
  const turn = designTurn([
    { calls: [call('write_screen', { html: '<html><body><h1>RecipeBot</h1></body></html>', title: 'RecipeBot home' })] },
    { calls: [call('reply', { text: 'Drawn.' })] },
  ], { handoff: true });
  await turn.run;
  assert.deepEqual(turn.sources, ['recipebot'], 'a first drawing still starts from the app\'s own screen');
  assert.equal(turn.versions.length, 1);
});
