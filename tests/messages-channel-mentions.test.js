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
const CHAT_ROUTES = read('src/routes/chat.js');

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
  // One lookup per conversation, which orders, shares and remembers requests.
  assert.match(effect, /prefixLookup\(\(query\) => api\.getMentionCandidates\(conversationId, query, CHANNEL_MENTION_LIMIT\)\)/);
  assert.match(effect, /\[isChannel, conversationId\]\)/, 'a different conversation starts a fresh lookup');
  // After a pause in typing unless already answered; a superseded answer
  // (null) or one for an effect since torn down never lands.
  assert.match(effect, /window\.setTimeout\(ask, 120\)/);
  assert.match(effect, /window\.clearTimeout\(timer\)/);
  assert.match(effect, /if \(live && users\) setChannelPeople\(\{ lookup: channelLookup, key, users \}\)/);
  assert.doesNotMatch(effect, /setError\(/, 'the send\'s error state is the send\'s');
});

test('the list shows only the answer for what is typed now', () => {
  const memo = between(COMPOSER, 'const mention = useMemo', 'const channelMatches');
  assert.match(memo, /channelPeople\.lookup === channelLookup/, 'never another conversation\'s people');
  assert.match(memo, /channelPeople\.key === prefix/);
  assert.match(memo, /prefix\.startsWith\(channelPeople\.key\) && channelPeople\.users\.length < CHANNEL_MENTION_LIMIT/,
    'a shorter prefix\'s answer only while it was complete');
  assert.match(memo, /orderFriendsFirst\(people\.filter\(\(member\) => member\.username\.toLowerCase\(\)\.startsWith\(prefix\)\), friendIds\)\.slice\(0, 6\)/);
  // Groups and DMs keep their loaded roster, accepted members only.
  assert.match(memo, /orderFriendsFirst\(\(active\?\.members \|\| \[\]\)\.filter\(\(member\) => member\.status === 'member'/);
});

test('the client calls the read-gated endpoint with a bounded prefix and limit', () => {
  const fn = between(API, 'export async function getMentionCandidates', '\n}\n');
  assert.match(fn, /\/api\/conversations\/\$\{id\}\/mention-candidates\?q=\$\{q\}&limit=\$\{limit\}/);
  assert.match(fn, /prefix\.slice\(0, 64\)/);
  assert.match(fn, /encodeURIComponent/);
  assert.match(fn, /\.map\(normalizeUser\)\.filter\(\(user\) => user\.id\)/);
});

// ── lib/prefix-lookup.ts, driven with deferred answers ───────────────

function deferredFetcher() {
  const calls = [];
  const fetcher = (query) => new Promise((resolve, reject) => { calls.push({ query, resolve, reject }); });
  return { calls, fetcher };
}

test('an answer that lands after a later prefix was asked is dropped', async () => {
  const { prefixLookup } = loadTsx('frontend/src/lib/prefix-lookup.ts');
  const { calls, fetcher } = deferredFetcher();
  const lookup = prefixLookup(fetcher);
  const short = lookup.ask('a');
  const long = lookup.ask('alex');
  // Reverse order: the long prefix answers first, then the slow short one.
  calls[1].resolve(['alex']);
  calls[0].resolve(['amy', 'alex', 'ann']);
  assert.deepEqual(await long, ['alex']);
  assert.equal(await short, null, '`@a` no longer decides the list');
  // Both answers are remembered for their own prefix.
  assert.deepEqual(lookup.cached('A'), ['amy', 'alex', 'ann']);
  // Going back to `@a` answers from memory, with no new request.
  assert.deepEqual(await lookup.ask('a'), ['amy', 'alex', 'ann']);
  assert.equal(calls.length, 2);
});

test('the same prefix asked twice shares one request, and a failure is not remembered', async () => {
  const { prefixLookup } = loadTsx('frontend/src/lib/prefix-lookup.ts');
  const { calls, fetcher } = deferredFetcher();
  const lookup = prefixLookup(fetcher);
  const first = lookup.ask('bo');
  const again = lookup.ask('BO');
  assert.equal(calls.length, 1, 'in flight is shared, case-insensitively');
  calls[0].resolve(['bob']);
  assert.deepEqual(await first, ['bob'], 'the same prefix is still the one being typed');
  assert.deepEqual(await again, ['bob']);

  const failed = lookup.ask('zz');
  calls[1].reject(new Error('offline'));
  assert.deepEqual(await failed, [], 'the latest prefix failing closes the list');
  assert.equal(lookup.cached('zz'), null);
  const retry = lookup.ask('zz');
  assert.equal(calls.length, 3, 'and the next ask tries again');
  calls[2].resolve(['zz_1']);
  assert.deepEqual(await retry, ['zz_1']);
});

test('conversation tokens take legacy punctuation; app chat tokens do not', () => {
  const { detectMentionToken } = loadTsx('frontend/src/features/dev-board/card/mention-typeahead.tsx');
  assert.deepEqual(detectMentionToken('hi @ann-', 8, true), { start: 3, query: 'ann-' });
  assert.deepEqual(detectMentionToken('hi @ann-m.x', 11, true), { start: 3, query: 'ann-m.x' });
  assert.equal(detectMentionToken('mail@host', 9, true), null, 'an address is not a mention');
  assert.equal(detectMentionToken('hi @ann-', 8, false), null, 'the app chat grammar stops at the hyphen');
  assert.deepEqual(detectMentionToken('hi @ann', 7, false), { start: 3, query: 'ann' });
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

test('the app list behind @ is rate-limited like the other people searches', () => {
  // Since #3361 it takes ?q= per keystroke, so it spends the same per-user
  // bucket as /mention-candidates and /api/users/search.
  assert.match(CHAT_ROUTES, /\{[^}]*\buserDirectoryLimiter,[^}]*\} = require\('\.\.\/middleware\/rate-limits'\)/);
  assert.match(CHAT_ROUTES, /router\.get\('\/api\/apps\/:slug\/mention-suggestions', userDirectoryLimiter, async/);
  // A 429 is a failure, not an answer: the whole-list cache does not keep
  // it. (The hub's own composer, which asked per prefix, went with its
  // channel card: the hub's Discussion row opens the room itself.)
  assert.doesNotMatch(HUB, /function HubComposer/);
  assert.match(TYPEAHEAD, /if \(res\.status === 429\) return \[\];\s*let users/);
});

test('the mention typeahead asks by prefix through its ordered lookup', () => {
  // The hub's composer, which asked #general's conversation or the app's
  // list by prefix, went with its channel card; the hook it used is the
  // group chat's and the feed threads', and keeps its rules.
  assert.equal(loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx').conversationIdFromPostUrl, undefined);

  // The hook asks through the ordered lookup and applies only a live answer.
  const sync = between(TYPEAHEAD, 'const sync = useCallback', 'const accept = useCallback');
  assert.match(sync, /if \(asker\) \{/);
  assert.match(sync, /asker\.ask\(token\.query\)\.then\(\(found\) => \{ if \(found\) apply\(found\); \}\)/);
  assert.match(TYPEAHEAD, /const asker = useMemo\(\(\) => \(lookup \? prefixLookup\(lookup\) : null\), \[lookup\]\)/);
});
