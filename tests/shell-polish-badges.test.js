'use strict';

// The 19 Oct 2026 polish board, batch C: the desktop shell, and one meaning
// per badge (#18). The other suites pin each piece where it lives; this one
// holds the parts that had no suite of their own:
//
//   - N21: the sidebar slides when the toggle shows or hides it.
//   - #18: the vocabulary itself. Grey is new to read, the accent is waiting
//     on you. (The list's fresh counts reach the sidebar through
//     community-scope.ts `takeCounts`, #5296, which has its own tests.)
//   - N14, N17, #20: the readable measure, the quiet dot, the centred bar.
//
// Run with: node --test tests/shell-polish-badges.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

/** One rule's body, by its exact selector line. */
function rule(selector, from = 0) {
  const at = CSS.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('}', at) + 1);
}

// ── N21: the sidebar slides ────────────────────────────────────────────

test('the sidebar slides in and out on the compositor, and not at all for reduced motion', () => {
  const src = read('frontend/src/features/nav/rail-slide.ts');
  const { RAIL_SLIDE } = loadTsx('frontend/src/features/nav/rail-slide.ts');
  assert.deepEqual({ ...RAIL_SLIDE }, { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  assert.match(src, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(src, /!window\.matchMedia\?\.\('\(min-width: 768px\)'\)\.matches/, 'a phone has no fold');
  // One layout change, then transforms: the store change is committed
  // synchronously between the two measurements.
  assert.match(src, /flushSync\(commit\);/);
  assert.match(src, /screen\.root\.animate\(\[\{ transform: `translateX\(\$\{dx\}px\)` \}, \{ transform: 'none' \}\], RAIL_SLIDE\);/);
  assert.match(src, /\[\{ transform: 'translateX\(-100%\)' \}, \{ transform: 'none' \}\]/);
  const body = src.slice(src.indexOf('export function slideRail'));
  assert.equal((body.match(/\.animate\(/g) || []).length, 2, 'the screen and the rail');
  assert.doesNotMatch(body, /\{ (?!transform)[a-zA-Z]+: [`'"]/, 'every keyframe is a transform: nothing lays out again on a frame');
  // Going away, the rail is drawn until its slide ends.
  assert.match(src, /bar\.classList\.add\('platform-tabs-leaving'\)/);
  assert.match(src, /if \(!open\) slide\.finished\.then\(leaving, leaving\);/);
  assert.match(CSS, /\.platform-tabs\.platform-tabs-folded:not\(\.platform-tabs-peek\):not\(\.platform-tabs-leaving\) \{\s*display: none;/);
});

// ── #18: grey is new to read; the accent is waiting on you ─────────────

test('an unread count is grey wherever it is, and said in words on a full row', () => {
  // The tab bar's grey, the one the rest match.
  assert.match(rule('\n.platform-tab-badge'), /background: var\(--text-faint, #8e8e93\);/);
  // Messages' rows: "2 new" in grey, no blue bubble, and the time in ink.
  const unread = rule('\n.messages-unread');
  assert.match(unread, /color: var\(--text-muted\);/);
  assert.doesNotMatch(unread, /--accent|background/);
  assert.match(rule('.messages-row-time-unread'), /color: var\(--text-primary\);/);
  const inbox = read('frontend/src/features/messages/index.tsx');
  assert.equal((inbox.match(/<span className="messages-unread">\{t\('messages:inbox\.newCount', \{ count: /g) || []).length, 3,
    'a conversation, #general and an app\'s channel say it the same way');
  assert.equal(message('messages:inbox.newCount', { count: 2 }), '2 new');
  // The sidebar's chats and a project's channels: grey; Needs you keeps the accent.
  assert.match(CSS, /\.platform-rail-nest :is\(\.platform-rail-sub-count, :is\(\[data-place="discussion"\], \[data-place\^="c:"\]\) > \.dev-ws-place-count\) \{\s*background: var\(--text-faint, #8e8e93\);/);
  assert.match(CSS, /\.dev-ws-place:is\(\[data-place="discussion"\], \[data-place\^="c:"\]\) \.dev-ws-place-count \{\s*background: var\(--text-faint, #8e8e93\);/);
  assert.match(rule('\n.dev-ws-place-count'), /background: var\(--accent\);/, 'the votes owed stay blue');
  // Red is the bell's alone: the place bar's "something waits" dot is not.
  assert.match(rule('\n.dev-ws-places-dot'), /background: #fff;/, 'white on the community\'s colour');
  assert.doesNotMatch(rule('\n.dev-ws-places-dot'), /#ff5a4f/);
});

test('a community\'s row: its votes in the blue pill, its unread said in grey words, never a second number', () => {
  const src = read('frontend/src/features/workshop/index.tsx');
  const row = src.slice(src.indexOf('export function AppRow'), src.indexOf('Four rows of the real geometry'));
  // #5296's one pill is the votes, and only the votes.
  assert.match(row, /trailing=\{row\.needs > 0 \? <VotePill count=\{row\.needs\} \/> : null\}/);
  assert.doesNotMatch(row, /messages-unread/, 'no unread bubble at the row\'s end');
  assert.match(row, /<StatusLine working=\{row\.working\} needs=\{row\.needs\} needsInPill \/>\s*\{unread > 0 \? \(\s*<span data-workshop-unread=\{String\(unread\)\} className="text-zinc-500 dark:text-zinc-400">/);
  assert.match(row, /t\('communities:row\.newMessages', \{ count: unread \}\)/);
  assert.equal(message('communities:row.newMessages', { count: 5 }), '5 new messages');
  assert.equal(message('communities:row.newMessages', { count: 1 }), '1 new message');
});

// ── N17, N14, #20 ──────────────────────────────────────────────────────

test('the "still open" dot is quiet grey, and stays where the close control finds it', () => {
  const dot = rule('\n.app-live-dot');
  assert.match(dot, /background: var\(--text-muted\);/);
  assert.doesNotMatch(dot, /#22c55e/, 'no green dot on every running app');
});

test('a message reads at most 72 characters a line on a desktop, a phone untouched', () => {
  const at = CSS.indexOf('/* A READABLE MEASURE (N14');
  assert.ok(at > 0);
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(block, /@media \(min-width: 768px\) \{\s*\.messages-markdown\.gc-msg-content \{\s*max-width: 72ch;/);
});

test('the desktop bar is one centred row in every state but over a running app', () => {
  const at = CSS.indexOf('/* ONE ROW, CENTRED, ON EVERY DESKTOP SCREEN (#20');
  assert.ok(at > 0);
  const block = CSS.slice(at, CSS.indexOf('/* A FLAT TOP EDGE', at) > 0 ? CSS.indexOf('/* A FLAT TOP EDGE', at) : at + 4000);
  const notApp = 'body:not(:has(#app-view:not(.hidden)[data-app-surface="app"])) :is(#platform-header, #landing-header)';
  assert.ok(block.includes(`${notApp} {\n    padding-bottom: 0.75rem;`), '12 under the row');
  assert.ok(block.includes(`${notApp}.un-safe-top-extend {\n      padding-top: calc(0.75rem + var(--un-safe-inset-top, env(safe-area-inset-top, 0px))) !important;`), '12 over it, plus the inset');
  assert.ok(block.includes(`html.web-browser-chrome ${notApp}.un-safe-top-extend {\n      padding-top: 0.75rem !important;`), 'a browser tab keeps its zero inset');
  assert.match(block, /#header-title \{\s*display: flex;\s*align-items: center;\s*height: 1\.75rem;/,
    'the title is the row\'s 28px and centres its words, wordmark or text alike');
  // 12 + 28 + 12: the bar is the same 52px it was.
  assert.match(CSS, /--platform-header-h: 3\.25rem/);
});

test('a group\'s header leads with a member\'s face and says who is still invited (N14)', () => {
  const { threadWords } = loadTsx('frontend/src/features/messages/index.tsx');
  const members = [{ id: 1, username: 'evan', status: 'member' }, { id: 2, username: 'lukas', status: 'member' },
    { id: 3, username: 'iqiyi', status: 'invited' }];
  const group = { id: 8, kind: 'group', myRole: 'member', memberCount: 2, membershipStatus: 'member', title: 'Evan + Lukas / iqiyi', members };
  // The count is the members who joined; the title can name one still asked.
  assert.equal(threadWords(group).sub, '2 members · 1 invited');
  assert.equal(threadWords({ ...group, members: members.slice(0, 2) }).sub, '2 members', 'nobody pending, nothing added');
  assert.equal(threadWords({ ...group, membershipStatus: 'invited' }).sub, 'Invitation pending', 'an invitee reads the invitation');
  const src = read('frontend/src/features/messages/index.tsx');
  const header = src.slice(src.indexOf('function ThreadHeader('), src.indexOf('/** The day a message was sent'));
  assert.match(header, /const face = active\.kind === 'group' && !invited\s*\? active\.members\.find\(\(member\) => member\.status === 'member' && Number\(member\.id\) !== viewerId\) \|\| null/);
  assert.match(header, /: face \? <UserAvatar user=\{face\} shape="square" \/>/, 'not the initials of its name ("E+")');
  // A bot's thread line says its name, not @homeroom_bot.
  assert.match(src, /name: reply\.sender\.bot \? senderName\(reply\.sender, \{ bare: true \}\) : reply\.sender\.username,\s*bot: !!reply\.sender\.bot,/);
  assert.match(read('frontend/src/features/message-actions/thread-activity.tsx'), /\{reply\.bot \? reply\.name : `@\$\{reply\.name\}`\}/);
});

test('one number on the All row: the votes hide the grey count of unread channels', () => {
  // The rule that brings the grey count back on the desktop row weighs
  // (2,3,0); the one that hides it under the All row's votes must weigh as
  // much and come after it. It weighed (2,1,0), and the row said "1 28".
  const show = CSS.indexOf('#platform-tab-workshop .platform-tab-mark:has(.platform-tab-votes) > #platform-tabs-badge-communities:not(.hidden) {');
  const hide = CSS.indexOf('#platform-tab-workshop:has(.platform-tab-all-votes) .platform-tab-mark > #platform-tabs-badge-communities:not(.hidden) {\n    display: none;');
  assert.ok(show > 0 && hide > show, 'the hide rule, as heavy, after the show rule');
});
