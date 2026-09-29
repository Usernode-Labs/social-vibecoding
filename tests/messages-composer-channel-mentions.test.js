'use strict';

// #3361 -- typing `@` in a channel composer offered nobody, because the
// messages composer builds its candidates from active.members and the server
// deliberately leaves a channel's roster empty (it counts every-user
// membership instead of loading it). The fix: when the active conversation is
// a channel, the composer fetches its mention candidates from
// GET /api/conversations/:id/mention-candidates and feeds that list through
// the same prefix filter, friend-first ordering and six-row cap. Group chats
// and DMs keep reading active.members exactly as before.
//
// Source-level, like tests/messages-composer-add-menu.test.js beside it: the
// composer's rendering needs a live conversation and the messages store, and
// what this pins is the shape of the data flow, which the source states more
// plainly than a mounted component could.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const API = read('frontend/src/features/messages/api.ts');

test('the composer fetches channel candidates once per conversation', () => {
  assert.match(COMPOSER, /const \[channelCandidates, setChannelCandidates\] = useState<ConversationUser\[\]>\(\[\]\)/);
  assert.match(COMPOSER, /import type \{ ConversationUser, MessageAttachment, SharedObjectReference \} from '\.\/types';/);
  assert.match(COMPOSER, /api\.getMentionCandidates\(conversationId\)/);
  // Keyed on the conversation: a switch to another conversation clears the
  // stale list and refetches; a channel that is not a channel never fetches.
  assert.match(COMPOSER, /if \(active\?\.kind !== 'channel' \|\| !conversationId\) return undefined;/);
  assert.match(COMPOSER, /setChannelCandidates\(\[\]\);/);
  assert.match(COMPOSER, /\[active\?\.kind, conversationId\]\);/, 'the effect is keyed once per conversation');
});

test('a failed fetch degrades silently to today\'s behaviour', () => {
  // No menu, no error row: the catch empties the list and nothing renders.
  assert.match(COMPOSER, /\.catch\(\(\) => \{ if \(live\) setChannelCandidates\(\[\]\); \}\)/);
  const block = COMPOSER.slice(COMPOSER.indexOf('const [channelCandidates'), COMPOSER.indexOf('#2783: `#` offers'));
  assert.doesNotMatch(block, /setError\(/, 'the composer\'s send-error state stays the send\'s');
});

test('channel candidates feed the SAME prefix, friends and cap path', () => {
  const memo = COMPOSER.slice(COMPOSER.indexOf('const mention = useMemo'), COMPOSER.indexOf('const channelMatches'));
  // The channel branch leaves the memo first, with its own source; the
  // group/direct branch below keeps the roster source untouched.
  const channelBranch = memo.slice(memo.indexOf('#3361: a channel has no loaded roster'),
    memo.indexOf("return orderFriendsFirst((active?.members"));
  assert.match(channelBranch, /if \(active\?\.kind === 'channel'\)/);
  assert.match(channelBranch, /orderFriendsFirst\(channelCandidates\s*\.filter\(/);
  assert.match(channelBranch, /toLowerCase\(\)\.startsWith\(prefix\.toLowerCase\(\)\)/);
  assert.match(channelBranch, /\.slice\(0, 6\)/);
  // Membership is implied for channel candidates (they spoke there), so the
  // member-status filter is NOT on this branch.
  assert.doesNotMatch(channelBranch, /member\.status === 'member'/);
});

test('group and direct conversations keep the member-roster source', () => {
  // The active-members branch is unchanged: same filter, same fallback,
  // friends ordered before the six-row cap.
  const memo = COMPOSER.slice(COMPOSER.indexOf('const mention = useMemo'), COMPOSER.indexOf('const channelMatches'));
  const groupBranch = memo.slice(memo.indexOf("return orderFriendsFirst((active?.members"));
  assert.match(groupBranch, /\(active\?\.members \|\| \[\]\)\.filter\(\(member\) => member\.status === 'member'/);
  assert.match(groupBranch, /orderFriendsFirst\(.*?, friendIds\)\.slice\(0, 6\)/s);
});

test('the api fetcher hits the new endpoint and normalizes strictly', () => {
  assert.match(API, /export async function getMentionCandidates\(id: number\): Promise<ConversationUser\[\]>/);
  assert.match(API, /\/api\/conversations\/\$\{id\}\/mention-candidates/);
  assert.match(API, /array\(pick\(data, 'users', 'items'\)\)\.map\(normalizeUser\)/);
  assert.match(API, /\.filter\(\(user\) => user\.id\)/);
});
