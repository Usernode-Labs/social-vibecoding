'use strict';

// Threads, stage 5 of #6019: the head of a private thread in the chat with
// Homeroom bot, without a database (the doors themselves run against
// PostgreSQL in private-threads-postgres.test.js).
//
// What this pins:
//   1. Its first render is nothing, and it reads where the thread stands.
//   2. The projects to pick from are the viewer's communities, in order.
//   3. It is drawn only on a thread the viewer started in the bot's chat.
//   4. The doors are same-origin writes, named in the copy.
//
// Run with: node --test tests/private-thread-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BAR = 'frontend/src/features/messages/private-thread-bar.tsx';

test('its first render is nothing; where the thread stands is read in an effect', () => {
  assert.equal(renderComponent(BAR, 'PrivateThreadBar', { rootId: 5, text: 'An idea' }), '');
  assert.match(read(BAR), /fetch\(`\/api\/conversations\/homeroom-bot\/threads\/\$\{rootId\}`/);
});

test('the projects to pick from are the viewer\'s communities, in the switcher\'s order', () => {
  const { projectChoices } = loadTsx(BAR);
  assert.deepEqual(JSON.parse(JSON.stringify(projectChoices({
    list: ['seed-swap', 'notes'], info: { 'seed-swap': { name: 'Seed swap' } },
  }))), [{ slug: 'seed-swap', name: 'Seed swap' }, { slug: 'notes', name: 'notes' }]);
  assert.deepEqual(projectChoices({ list: null, info: {} }), []);
});

test('it is drawn only on a thread the viewer started in the bot\'s chat', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  const at = screen.indexOf('<PrivateThreadBar rootId={rootId}');
  assert.ok(at > 0);
  const gate = screen.slice(screen.lastIndexOf('{botChat && active?.homeroomBot', at), at);
  assert.match(gate, /^\{botChat && active\?\.homeroomBot && root && !root\.sender\.bot && rootId/, 'the bot\'s chat, a person\'s root');
  assert.match(gate, /App\?\.user\?\.id : 0\) === root\.sender\.id/, 'and the viewer\'s own');
});

test('the doors are same-origin writes, and the copy names them', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/file', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/post', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.equal(message('messages:privateThread.label'), 'Only you can see this thread.');
  assert.equal(message('messages:privateThread.fileIt'), 'File it');
  assert.equal(message('messages:privateThread.postIt'), 'Post it');
  assert.equal(message('messages:privateThread.filed', { number: 41, project: 'Seed swap' }), 'Filed as request #41 on Seed swap.');
});
