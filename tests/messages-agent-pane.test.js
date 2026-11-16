'use strict';

// The old thread addresses Messages used to open, and where they land now.
//
// #2813 gave agent threads addresses in the inbox, `#messages/agent/<id>`
// and `#messages/session/<slug>/<id>`, beside their own screens'
// (`#agent/<id>`, `#app/<slug>/dev/sessions/<id>`). Agent chats and dev
// chats are retired, but those addresses live on in bookmarks, emails and
// bell rows. What is pinned here, each a way an old link quietly breaks:
//
//   1. EVERY OLD CHAT ADDRESS HAS A NEW HOME. `App._oldChatAddress` maps an
//      agent chat to Homeroom bot (its moved history, or a new thread) and a
//      dev chat to its change's page, and the router swaps the address in
//      place (replaceState) and routes the new one in the same pass, so Back
//      never lands on the old one.
//   2. GLOBAL CHAT'S OLD ADDRESSES OPEN THE INBOX: it was removed, and
//      `#chat`, `#chat/<id>` and `#messages/agent/<uuid>` land on
//      `#messages` rather than on a thread nothing can draw.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

/** One `App` method's source, `name(args) { … },`, cut at its closing line. */
function method(name) {
  const start = APP.indexOf(`\n  ${name}(`);
  assert.ok(start > 0, `App.${name} exists`);
  const end = APP.indexOf('\n  },', start);
  return APP.slice(start + 1, end + 5);
}

// The real mapping and the real id check, evaluated as an object of their own.
// eslint-disable-next-line no-new-func
const App = new Function(`const App = { ${method('_numericSegment')}\n${method('_oldChatAddress')} }; return App;`)();

test('an old agent-chat address goes to Homeroom bot, a dev chat to its change', () => {
  // Agent chats: a new one is a new Homeroom bot thread, an old one is
  // looked up where its history was moved.
  assert.equal(App._oldChatAddress('agent/new'.split('/')), '#homeroom-bot/new');
  assert.equal(App._oldChatAddress('messages/agent/new'.split('/')), '#homeroom-bot/new');
  assert.equal(App._oldChatAddress('agent/12'.split('/')), '#homeroom-bot/old/agent/12');
  assert.equal(App._oldChatAddress('agent/12/changes'.split('/')), '#homeroom-bot/old/agent/12');
  assert.equal(App._oldChatAddress('messages/agent/12'.split('/')), '#homeroom-bot/old/agent/12');
  // Dev chats: the change's own page, whichever address named it.
  assert.equal(App._oldChatAddress('messages/session/notes-ab12/42'.split('/')), '#app/notes-ab12/dev/proposals/42');
  assert.equal(App._oldChatAddress('app/notes-ab12/dev/sessions/42'.split('/')), '#app/notes-ab12/dev/proposals/42');
  assert.equal(App._oldChatAddress('app/notes-ab12/individual-chat/42'.split('/')), '#app/notes-ab12/dev/proposals/42');
  assert.equal(App._oldChatAddress('app/notes-ab12/dev/sessions/new'.split('/')), '#homeroom-bot/new?project=notes-ab12');
  assert.equal(App._oldChatAddress('app/notes-ab12/dev/sessions'.split('/')), '#app/notes-ab12/dev');
});

test('an address that is none of those is left to the router', () => {
  for (const hash of [
    'messages',
    'messages/12',
    'messages/app/notes-ab12',
    'app/notes-ab12/dev',
    'app/notes-ab12/dev/proposals/42',
    'homeroom-bot/old/agent/12',
    // A Global Chat thread's UUID is not a serial: the inbox route takes it.
    'messages/agent/5f0c2a1e-8d7b-4c2a-9e11-0b6f3f3c9a10',
    'messages/session/notes-ab12/0',
    'messages/session/notes-ab12/2147483648',
  ]) {
    assert.equal(App._oldChatAddress(hash.split('/')), null, hash);
  }
});

test('the router swaps the old address in place and routes the new one in the same pass', () => {
  assert.match(APP,
    /const movedTo = hash \? App\._oldChatAddress\(hash\.split\('\/'\)\) : null;\s*if \(movedTo\) \{\s*try \{ history\.replaceState\(null, '', App\._rootUrl\(movedTo\)\); \} catch \(_\) \{ return; \}\s*App\.restoreFromHash\(\);\s*return;\s*\}/);
});

test('Global Chat\'s old addresses open the inbox, at #messages', () => {
  // `#chat` and `#chat/<id>`: the inbox, whatever the viewport.
  assert.match(APP, /if \(parts\[0\] === 'chat'\) \{\s*(?:\/\/[^\n]*\n\s*)*App\._retiredChatToInbox\(\);\s*return;\s*\}/);
  // `#messages/agent/<uuid>`: an agent chat's id, all digits, was swapped
  // before this route; nothing else names a thread there any more.
  assert.match(APP, /if \(parts\[1\] === 'agent' && parts\[2\]\) \{\s*App\._retiredChatToInbox\(\);\s*return;\s*\}/);
  // The old address is replaced, so a reload or Back does not route it again.
  assert.match(method('_retiredChatToInbox'),
    /history\.replaceState\(history\.state, '', App\._rootUrl\('#messages'\)\);[\s\S]*App\.navigateToMessages\(null\);/);
  assert.doesNotMatch(APP, /navigateToGlobalChat|_inGlobalChat|global-chat-screen/);
});
