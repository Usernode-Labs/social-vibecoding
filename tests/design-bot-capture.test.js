'use strict';

// #6354: asked to show or change one of Homeroom's own pages, the design bot
// copies it first (capture_page) and then edits that copy, so version 1 is
// the real page and version 2 is the change, in one answer. A thread that
// already has a version is never recaptured, and a page with no demo route
// answers with the fallback the prompt tells the bot to say.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');

const HOMEROOM = { id: 3, slug: 'homeroom', name: 'Homeroom' };
const CONFIG = { port: 3000, selfAppSlug: 'homeroom' };

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

function captureTurn(steps, { design = null, current = null } = {}) {
  const sent = [];
  const seen = [];
  const versions = [];
  const designs = [];
  const captures = [];
  const realThreads = require('../src/services/design-threads');
  const pool = { async query() { return { rows: [] }; } };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', seesImages: false, sleep: async () => {},
    dm: { async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length }; } },
    mayor: Object.assign(Object.create(mayor), {
      async recordTurn() {}, async turnsLastHour() { return 0; },
      async findApp(_pool, name) {
        return String(name || '').toLowerCase() === HOMEROOM.slug ? HOMEROOM : null;
      },
      async canView() { return true; },
    }),
    designThreads: {
      ...realThreads,
      surfaceFor: (_config, app) => (app?.slug === 'homeroom' ? 'platform' : 'new'),
      async versionOf() { return current; },
      async ensureDesign(_pool, _config, args) { designs.push(args); return { threadId: 7, title: 'Homeroom bot page', app: HOMEROOM }; },
      async addVersion(_pool, args) { versions.push(args); return { version: versions.length }; },
      bareNote: realThreads.bareNote,
      versionLine: (version, note) => (note ? `Version ${version}: ${note}.` : `Version ${version}.`),
      async noteVersionMessage() {},
    },
    // The capture itself is design-capture.js's own suite; here it answers
    // the copy a page gives, so the turn's saving can be pinned.
    designCapture: {
      findPage(text) {
        const found = require('../src/services/design-capture').findPage(text);
        return found && found.key === 'homeroom-bot' ? found : null;
      },
      async capturePage(_config, _pool, { page, size }) {
        captures.push({ page: page.key, size });
        return {
          ok: true, html: '<html><body><div data-demo-rows>DEMO ROWS</div></body></html>',
          title: page.name, route: '/?demo=1#homeroom-bot', width: size === 'phone' ? 390 : 1280, height: 800,
        };
      },
    },
  };
  const run = designBot.answer(pool, CONFIG, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live' },
    conversationId: 41,
    message: { id: 71, content: 'Show me the Homeroom bot page with a search box' },
    design,
    thread: { rootId: 500, threadId: 7, conversationId: 41, app: HOMEROOM },
    handoff: false,
    deps,
  });
  return { run, sent, seen, versions, designs, captures };
}

function toolResult(seen, id) {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const tool = [...seen[i]].reverse().find((m) => m.role === 'tool' && m.tool_call_id === id);
    if (tool) return JSON.parse(tool.content);
  }
  return null;
}

test('a capture then an edit saves version 1 as the copy and version 2 as the change', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Homeroom bot page', size: 'phone' })] },
    { calls: [call('edit_design', {
      edits: [{ find: 'DEMO ROWS', replace: 'DEMO ROWS <input placeholder="Search">' }],
      note: 'a search box over the list',
    })] },
    { calls: [call('reply', { text: 'Version 1 is the real page, and version 2 adds the search box.' })] },
  ]);
  await turn.run;

  assert.deepEqual(turn.captures, [{ page: 'homeroom-bot', size: 'phone' }]);
  assert.equal(turn.versions.length, 2);
  assert.equal(turn.versions[0].author, 'capture');
  assert.equal(turn.versions[0].note, 'As it is now');
  assert.match(turn.versions[0].html, /DEMO ROWS/);
  assert.equal(turn.versions[1].author, 'bot');
  assert.match(turn.versions[1].note, /a search box over the list/);
  assert.match(turn.versions[1].html, /placeholder="Search"/);

  const design = turn.designs[0];
  assert.equal(design.surface, 'platform', 'a captured Homeroom page is Homeroom\'s own');
  assert.equal(design.route, '/?demo=1#homeroom-bot');

  assert.equal(turn.sent.length, 1);
  assert.match(turn.sent[0].content, /Version 1: As it is now\./);
  assert.match(turn.sent[0].content, /Version 2: a search box over the list\./);
  assert.equal(turn.sent[0].metadata.designVersion, 2);
  assert.equal(toolResult(turn.seen, 'ccapture_page').ok, true);
});

test('a thread that already has a version is not captured again', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Homeroom bot page' })] },
    { calls: [call('reply', { text: 'This design already has a version.' })] },
  ], {
    design: { latest: 1, state: 'open', threadId: 7, surface: 'platform', title: 'Homeroom bot page' },
    current: { version: 1, html: '<html><body>old</body></html>' },
  });
  await turn.run;
  assert.deepEqual(turn.captures, []);
  assert.match(toolResult(turn.seen, 'ccapture_page').error, /already has a version/);
  assert.equal(turn.versions.length, 0, 'nothing is saved');
});

test('a page with no demo route answers with the fallback, and the prompt says to say so', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Admin console' })] },
    { calls: [call('reply', { text: 'There is no live version of that page to copy, so I drew it from the code.' })] },
  ]);
  await turn.run;
  assert.deepEqual(turn.captures, []);
  assert.match(toolResult(turn.seen, 'ccapture_page').error, /No live version of that page/);
  assert.match(turn.seen[0][0].content, /no live version of that page/);
});

test('the prompt lists the pages it can copy, and the working card names the page', () => {
  const prompt = designBot.designPrompt({ username: 'evan', homeroom: true });
  for (const name of ['Homeroom bot page', 'Main Chat', 'Messages', 'Communities', 'Workshop', 'project page', 'request page']) {
    assert.ok(prompt.includes(name), `the prompt lists ${name}`);
  }
  assert.match(prompt, /capture_page first/);
  assert.deepEqual(mayor.doingFor('capture_page', { page: 'Homeroom bot page' }), { kind: 'capturing', page: 'Homeroom bot page' });
  assert.deepEqual(mayor.doingFor('capture_page', {}), { kind: 'capturing' });
});
