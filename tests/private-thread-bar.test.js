'use strict';

// Threads, stage 5 of #6019: a private thread in the chat with Homeroom
// bot, without a database (the doors themselves run against PostgreSQL in
// private-threads-postgres.test.js).
//
// What this pins:
//   1. Its first render is nothing, and it reads where the thread stands.
//   2. The projects to pick from are the viewer's communities, in order.
//   3. It is drawn only on a thread the viewer started in the bot's chat:
//      the note at its head, the doors at its foot.
//   4. 31 Oct 2026: the doors come once the bot has answered, and only the
//      ones that apply to what the thread is.
//   5. The doors are same-origin writes, named in the copy.
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
  assert.equal(renderComponent(BAR, 'PrivateThreadNote', { where: null }), '');
  const doors = { rootId: 5, text: 'An idea', where: null, onWhere() {}, botReplied: true };
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', doors), '');
  assert.match(read(BAR), /fetch\(`\/api\/conversations\/homeroom-bot\/threads\/\$\{rootId\}`/);
});

test('the projects to pick from are the viewer\'s communities, in the switcher\'s order', () => {
  const { projectChoices } = loadTsx(BAR);
  assert.deepEqual(JSON.parse(JSON.stringify(projectChoices({
    list: ['seed-swap', 'notes'], info: { 'seed-swap': { name: 'Seed swap' } },
  }))), [{ slug: 'seed-swap', name: 'Seed swap' }, { slug: 'notes', name: 'notes' }]);
  assert.deepEqual(projectChoices({ list: null, info: {} }), []);
});

test('the doors wait for the bot\'s answer, and are only the ones that apply', () => {
  const { doorsFor } = loadTsx(BAR);
  const open = (kind, app = null) => ({ state: 'open', kind, app });
  const doors = (where, replied = true) => JSON.parse(JSON.stringify(doorsFor(where, replied)));
  assert.deepEqual(doors(open('idea'), false), [], 'nothing to take public before the bot answers');
  assert.deepEqual(doors(open('draft_request')), ['file']);
  assert.deepEqual(doors(open('draft_reply')), ['post']);
  assert.deepEqual(doors(open('ask')), [], 'a question has nothing to take public');
  assert.deepEqual(doors(open('idea')), ['file', 'new'], 'an idea in no project can start one');
  assert.deepEqual(doors(open('idea', { slug: 'notes', name: 'Notes' })), ['file']);
  assert.deepEqual(doors({ state: 'open' }), ['file', 'new'], 'an older server sends no kind: an idea');
  assert.deepEqual(doors({ state: 'filed', number: 4 }), [], 'none once it went somewhere');
  assert.deepEqual(doors(null), []);
});

test('it is drawn only on a thread the viewer started in the bot\'s chat: the note on top, the doors under it', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  const gate = screen.slice(screen.indexOf('const privateRoot = '), screen.indexOf('const [privateWhere, setPrivateWhere] = usePrivateThread(privateRoot);'));
  assert.match(gate, /snap\.active\?\.kind === 'direct' && threadsAllowed\(snap\.active\) && snap\.active\.homeroomBot/, 'the bot\'s chat');
  assert.match(gate, /privateRootMessage && !privateRootMessage\.sender\.bot/, 'a person\'s root');
  assert.match(gate, /App\?\.user\?\.id : 0\) === privateRootMessage\.sender\.id/, 'and the viewer\'s own');
  const note = screen.indexOf('{privateRoot ? <PrivateThreadNote where={privateWhere} /> : null}');
  const doors = screen.indexOf('<PrivateThreadDoors');
  assert.ok(note > 0 && doors > note, 'the note heads the thread, the doors close it');
  assert.match(screen.slice(doors, doors + 400), /botReplied=\{replies\.some\(\(message\) => message\.sender\.bot\)\}/);
  assert.doesNotMatch(screen, /<PrivateThreadBar\b/, 'no bar of doors over the thread any more');
});

test('a door opens pointed at the thread\'s project, and a reply at the thread it answers', () => {
  const source = read(BAR);
  assert.match(source, /setProject\(where\.app\?\.slug \|\| ''\)/);
  assert.match(source, /setNumber\(where\.target \? String\(where\.target\) : ''\)/);
  assert.match(source, /data-private-doors=/);
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
