'use strict';

// #3361 — `@` in a channel offered nobody. The Messages composer built its
// list from `active.members`, and the server leaves a channel's roster empty
// (serializeConversation counts it: a channel is everybody). The hub's
// channel card had no `@` list at all.
//
// The server side — who may ask, who is offered, what is returned — is pinned
// against the real schema in tests/conversation-mention-candidates-postgres.
// This file pins the two composers' wiring. The suite has no DOM and the
// Messages composer needs the live store, so the wiring is pinned as source,
// in the style of tests/feed-reply-mentions.test.js; the one pure helper the
// hub adds is driven directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const API = read('frontend/src/features/messages/api.ts');
const HUB = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
const TYPEAHEAD = read('frontend/src/features/dev-board/card/mention-typeahead.tsx');
const SERVICE = read('src/services/conversations.js');
const ROUTES = read('src/routes/conversations.js');

const between = (src, from, to) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `missing ${to}`);
  return src.slice(start, end);
};

test('a channel asks the server for the people matching the typed prefix', () => {
  const effect = between(COMPOSER, 'const isChannel = ', 'const mention = useMemo');
  assert.match(effect, /active\?\.kind === 'channel'/);
  assert.match(effect, /api\.getMentionCandidates\(conversationId, mentionPrefix\)/);
  // After a pause in typing, not on every keystroke, and remembered per
  // prefix for this conversation.
  assert.match(effect, /window\.setTimeout\(/);
  assert.match(effect, /window\.clearTimeout\(timer\)/);
  assert.match(effect, /channelLookups\.current\.get\(key\)/);
  assert.match(effect, /useEffect\(\(\) => \{ channelLookups\.current = new Map\(\); \}, \[conversationId\]\)/,
    'a different conversation starts with nothing remembered');
  // A failure shows no list and no error; the send's error state is the send's.
  assert.doesNotMatch(effect, /setError\(/);
});

test('the list offers channel people only for the conversation they came from', () => {
  const memo = between(COMPOSER, 'const mention = useMemo', 'const channelMatches');
  assert.match(memo, /if \(isChannel\) \{\s*const people = channelPeople\.conversationId === conversationId \? channelPeople\.users : \[\];/);
  // The same prefix filter, friends first and six rows as the roster path.
  assert.match(memo, /orderFriendsFirst\(people\.filter\(\(member\) => member\.username\.toLowerCase\(\)\.startsWith\(prefix\)\), friendIds\)\.slice\(0, 6\)/);
  // Groups and DMs keep their loaded roster, accepted members only.
  assert.match(memo, /orderFriendsFirst\(\(active\?\.members \|\| \[\]\)\.filter\(\(member\) => member\.status === 'member'/);
});

test('the client calls the read-gated endpoint with a bounded prefix and limit', () => {
  const fn = between(API, 'export async function getMentionCandidates', '\n}\n');
  assert.match(fn, /\/api\/conversations\/\$\{id\}\/mention-candidates\?q=\$\{q\}&limit=\$\{limit\}/);
  assert.match(fn, /prefix\.slice\(0, 32\)/);
  assert.match(fn, /encodeURIComponent/);
  assert.match(fn, /\.map\(normalizeUser\)\.filter\(\(user\) => user\.id\)/);
});

test('the server reuses the message-read gate and the directory rate limit', () => {
  const fn = between(SERVICE, 'async function mentionCandidates', '\nasync function conversationRow');
  // Exactly listMessages' gate, not a new one.
  const list = between(SERVICE, 'async function listMessages', 'const safeLimit');
  const gate = "const membership = await loadMembership(pool, conversationId, user.id, { allowDeletedPeer: true });\n"
    + '  if (!membership || !(await canReadConversation(pool, membership, user.id))) return null;';
  assert.ok(list.includes(gate), 'listMessages reads through this gate');
  assert.ok(fn.includes(gate), 'and so do the mention candidates');
  // Parameterised, escaped, capped, and one statement.
  assert.match(fn, /ESCAPE '\\\\'/);
  assert.match(fn, /LIMIT \$4/);
  assert.equal((fn.match(/pool\.query\(/g) || []).length, 1, 'one query, no per-person lookups');
  assert.doesNotMatch(fn, /email|display_name|password|is_admin/, 'public identity only');
  const route = between(ROUTES, "'/api/conversations/:id/mention-candidates'", '\n  });');
  assert.match(ROUTES, /router\.get\('\/api\/conversations\/:id\/mention-candidates', userDirectoryLimiter,/);
  assert.match(route, /users \? res\.json\(\{ users \}\) : sendNotFound\(res\)/);
});

test('the hub composer suggests people: the app list, or #general by prefix', () => {
  const { conversationIdFromPostUrl } = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.equal(conversationIdFromPostUrl('/api/conversations/42/messages'), 42);
  assert.equal(conversationIdFromPostUrl('/api/apps/my-app/messages'), null);
  assert.equal(conversationIdFromPostUrl('/api/conversations/0/messages'), null);
  assert.equal(conversationIdFromPostUrl('/api/conversations/42/messages?x=1'), null);

  const hub = between(HUB, 'function HubComposer', '\n}\n');
  assert.match(hub, /useMentionTypeahead\(\{\s*slug, inputRef, value: text, onChange: setText, lookup: conversationId \? lookup : undefined,/);
  assert.match(hub, /\/api\/conversations\/\$\{conversationId\}\/mention-candidates\?q=\$\{encodeURIComponent\(query\)\}&limit=8/);
  assert.match(hub, /ref=\{inputRef\}/);
  assert.match(hub, /mention\.onKeyDown\(e\)/, 'an open list owns Enter, so it picks rather than sends');
  assert.match(hub, /<FeedMentionMenu/);

  // The hook takes the prefix lookup in place of the app's one list.
  const sync = between(TYPEAHEAD, 'const sync = useCallback', 'const accept = useCallback');
  assert.match(sync, /if \(lookup\) \{/);
  assert.match(sync, /looked\.current\.get\(key\)/);
  assert.match(sync, /void lookup\(token\.query\)/);
});
