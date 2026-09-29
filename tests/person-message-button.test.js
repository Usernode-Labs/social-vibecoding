// "Message" on a person's page (the navigation prototype's person page,
// `pageParts` → 'person'): #profile/<name> and #leaderboard/users/<name>.
//
// It reuses the Messages "+ → Direct message" path end to end
// (frontend/src/features/profile/message-person.ts): the messages-scoped
// user search, an exact handle match, then the store's createDirect, which
// finds or starts the conversation and opens #messages/<id>. So it inherits
// that path's rules — blocking either way (#2867), message requests, never
// yourself — and this pins that it does, plus where the button is drawn.
//
// Run with: node --test tests/person-message-button.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadMessagePerson({ users = [], search, direct } = {}) {
  const calls = { search: [], direct: [] };
  const mod = loadTsx('frontend/src/features/profile/message-person.ts', {
    stubs: {
      '../messages/api': {
        searchUsers: async (q) => { calls.search.push(q); if (search) return search(q); return users; },
      },
      '../messages/store': {
        createDirect: async (id) => { calls.direct.push(id); if (direct) return direct(id); return { id: 4242 }; },
      },
    },
  });
  return { ...mod, calls };
}

test('the exact handle is picked out of the prefix search, ignoring case', () => {
  const { exactMatch } = loadMessagePerson();
  const users = [{ id: 2, username: 'dana' }, { id: 3, username: 'dana2' }];
  assert.deepEqual(exactMatch(users, 'Dana'), { id: 2, username: 'dana' });
  assert.equal(exactMatch(users, 'dan'), null, 'a prefix is not a person');
  assert.equal(exactMatch(users, ''), null);
});

test('it finds or starts the DM through the SAME createDirect the "+" dialog calls', async () => {
  const m = loadMessagePerson({ users: [{ id: 2, username: 'dana' }] });
  assert.deepEqual(await m.messagePerson('@dana'), { ok: true });
  assert.deepEqual(m.calls.search, ['dana'], 'searched once, by the bare handle');
  assert.deepEqual(m.calls.direct, [2], 'and opened with that person\'s id');
  const source = read('frontend/src/features/profile/message-person.ts');
  assert.match(source, /import \* as api from '\.\.\/messages\/api';/);
  assert.match(source, /import \{ createDirect \} from '\.\.\/messages\/store';/,
    'the store\'s createDirect is what opens #messages/<id>');
  assert.match(read('frontend/src/features/messages/api.ts'), /\/api\/users\/search\?q=\$\{encodeURIComponent\(query\.trim\(\)\.slice\(0, 255\)\)\}&scope=messages/,
    'and the search is the messages-scoped one, which leaves out blocked people and yourself');
});

test('blocked either way: the search leaves them out, and the button says so without saying who', async () => {
  const m = loadMessagePerson({ users: [] });
  const result = await m.messagePerson('dana');
  assert.deepEqual(result, { ok: false, message: 'You can’t message @dana.' });
  assert.deepEqual(m.calls.direct, [], 'nothing is created');
});

test('a request the server refuses (a decline, a late block) is a 404 and reads the same way', async () => {
  const refused = loadMessagePerson({
    users: [{ id: 2, username: 'dana' }],
    direct: () => { const err = new Error('Conversation not found'); err.status = 404; throw err; },
  });
  assert.deepEqual(await refused.messagePerson('dana'), { ok: false, message: 'You can’t message @dana right now.' });
  const offline = loadMessagePerson({ search: () => { throw new Error('offline'); } });
  assert.match((await offline.messagePerson('dana')).message, /^Couldn’t reach Messages/);
});

test('#profile/<name>: drawn for someone else\'s page, never your own or a visitor\'s', () => {
  const { buildProfileView } = loadTsx('frontend/src/features/profile/profile-store.js');
  const page = (user) => buildProfileView({
    open: true, user, data: { publicProfile: { username: 'Dana' } },
  });
  assert.equal(page({ username: 'evan', hasPlatformAccess: true }).allowMessage, true);
  assert.equal(page({ username: 'dana', hasPlatformAccess: true }).allowMessage, false, 'your own page, any case');
  assert.equal(page({}).allowMessage, false, 'signed out');
  assert.equal(page({ username: 'evan', hasPlatformAccess: false }).allowMessage, false, 'still on the waitlist');
});

test('#leaderboard/users/<name>: the same gate, decided in the Kudos pane\'s module', () => {
  const src = read('frontend/src/features/leaderboard/leaderboard.js');
  const run = (user, who) => {
    const ctx = { window: null, App: { user }, location: { hash: '' } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${src.replace(/^export .*$/gm, '')}\n;globalThis.__lb = Leaderboard;`, ctx);
    ctx.__lb.profileUser = who;
    return ctx.__lb.chromeView().canMessage;
  };
  assert.equal(run({ username: 'evan' }, 'dana'), true);
  assert.equal(run({ username: 'evan' }, 'EVAN'), false);
  assert.equal(run(null, 'dana'), false);
  assert.equal(run({ username: 'evan', hasPlatformAccess: false }, 'dana'), false);
});

test('the control itself: named for the person, and a refusal is never silent', () => {
  const BUTTON = 'frontend/src/features/profile/message-button.tsx';
  const { MessageButton } = loadTsx(BUTTON, {
    stubs: { './message-person': { messagePerson: async () => ({ ok: true }) } },
  });
  const html = renderToHtml(createElement(MessageButton, { username: 'dana' }));
  assert.match(html, /^<div class="relative shrink-0"><button[^>]*type="button"/, 'out-of-flow error anchor, then the button');
  assert.match(html, /data-message-person="dana"/);
  assert.match(html, /aria-label="Message @dana"/);
  assert.ok(!html.includes('role="alert"'), 'no error line until a refusal');
  const source = read(BUTTON);
  // The kit's toast when it is there; otherwise the inline alert under the button.
  assert.match(source, /ui\?\.hasKit\?\.\(\) && typeof ui\.toast === 'function'\) ui\.toast\(result\.message\);\s*else setError\(result\.message\);/);
  assert.match(source, /role="alert"/);
});

test('the button renders where the prototype puts it, and only when allowed', () => {
  const card = loadTsx('frontend/src/features/profile/public-profile-card.tsx');
  const profile = { username: 'dana', displayName: 'Dana Reyes', links: {} };
  const on = renderToHtml(createElement(card.PublicProfileCard, { profile, allowReport: true, allowMessage: true }));
  assert.match(on, /<button[^>]*data-message-person="dana"[^>]*aria-label="Message @dana"[^>]*>Message<\/button>/);
  assert.ok(on.indexOf('Dana Reyes') < on.indexOf('data-message-person'), 'in the name row, after the name');
  const off = renderToHtml(createElement(card.PublicProfileCard, { profile, allowReport: false }));
  assert.ok(!off.includes('data-message-person'), 'the owner\'s own Preview draws none');

  const state = { mounted: true, chrome: { kind: 'profile', who: 'dana', initial: 'D', canMessage: true }, body: null };
  const pane = loadTsx('frontend/src/features/leaderboard/kudos-pane.tsx', {
    stubs: { './kudos-pane-store.js': { kudosPaneStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const header = renderToHtml(createElement(pane.KudosPane, {}));
  assert.match(header, /data-lb-back=""[\s\S]*data-message-person="dana"/, 'beside the person, under the way back');
  state.chrome = { ...state.chrome, canMessage: false };
  assert.ok(!renderToHtml(createElement(pane.KudosPane, {})).includes('data-message-person'));
});
