// #6236: what a chat line about a change offers in place of the old inline
// vote row ("0 of 1 approval · Preview · Yes (0✓) · No (0✓) · Admin merge",
// filled into a `[data-vote-controls]` host by group-chat.js from AppView's
// own markup).
//
//   * On a request's page, where the change's section is drawn below, the
//     bot's "It's up for a vote" post and a vote line carry ONE LINE that
//     names the change ("Change #6063 · Dark mode") and offers See the
//     vote, which brings that section's Votes card into view.
//   * Anywhere else a line about a change is drawn, a small CARD in today's
//     style: the change's name, where its vote and checks stand in words
//     ("Needs 1 more yes · All checks passed"), and Preview and Vote.
//   * No Yes, no No, and no Admin merge in any transcript render: Admin
//     merge is a row of the change's ⋯ menu alone.
//
// Run with: node --test tests/vote-row-card.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CARD = 'frontend/src/features/group-chat/vote-card.tsx';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

const base = {
  id: 5, kind: 'system', username: '', time: '', bodyHtml: '', systemText: 'admin promoted PR #12 for a vote',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: true, showReact: true, quote: null, reactions: [],
  attachments: [], voteRowClass: '', voteRef: null, specShare: null,
};
const facts = (over) => ({
  sessionId: 9000401, number: 12, title: 'Dark mode', status: 'promoted', yes: 0, needed: 1,
  needsOtherMember: false, myVote: null, checks: 'passing', preview: { kind: 'live', url: 'https://stg.example.test' },
  ...over,
});
const voteRow = (over) => ({ ...base, kind: 'vote', voteRef: { sessionId: '9000401', prNumber: '12' }, ...over });
const botPost = (over) => ({
  ...base, id: 9, kind: 'message', username: 'homeroom_bot', time: '10:00', timeTitle: 't',
  bodyHtml: '<p>I built this. It’s up for a vote: Dark mode</p>', systemText: '',
  voteRef: { sessionId: '9000401', prNumber: '12' }, ...over,
});

// ── The words ─────────────────────────────────────────────────────────

test('the facts, in words: the vote, your own vote, the checks, a preview still building', () => {
  const { voteFacts } = loadTsx(CARD);
  const t = (id, values) => message(id, values);
  assert.deepEqual(voteFacts(t, facts()), ['Needs 1 more yes', 'All checks passed']);
  assert.deepEqual(voteFacts(t, facts({ yes: 1, needed: 3, myVote: 'yes', checks: 'pending', preview: { kind: 'building' } })),
    ['Needs 2 more yes', 'You voted yes', 'Checks running', 'Preview building…']);
  assert.deepEqual(voteFacts(t, facts({ yes: 2, needed: 2, checks: 'failing', myVote: 'no' })), ['2 of 2 yes', 'You voted no', 'A check found a problem']);
  assert.deepEqual(voteFacts(t, facts({ yes: 2, needed: 2, needsOtherMember: true, checks: 'error' })), ['Needs another member’s yes', 'Checks couldn’t run']);
  assert.deepEqual(voteFacts(t, facts({ yes: 1, needed: 1, checks: 'skipped' })), ['1 of 1 yes'], 'skipped checks say nothing');
  assert.deepEqual(voteFacts(t, facts({ status: 'merging' })), ['Merging…']);
  assert.deepEqual(voteFacts(t, facts({ status: 'merged' })), ['Merged']);
  assert.deepEqual(voteFacts(t, null), [], 'unknown to the snapshot: nothing yet');
});

test('the change is named by number and title, as the project writes its numbers', () => {
  const { changeName } = loadTsx(CARD);
  const t = (id, values) => message(id, values);
  assert.equal(changeName(t, { number: 12, title: 'Dark mode' }, false), 'Change #12 · Dark mode');
  assert.equal(changeName(t, { number: 12, title: 'Dark mode' }, true), 'PR 12 · Dark mode', 'on GitHub a change is PR N, never #N');
  assert.equal(changeName(t, { number: 12, title: null }, false), 'Change #12');
  assert.equal(changeName(t, { number: null, title: 'Dark mode' }, false), 'Dark mode');
  assert.equal(changeName(t, { number: null, title: null }, false), 'A change');
});

// ── The card ──────────────────────────────────────────────────────────

test('a vote line outside a request page draws the card: the name, the facts, Preview and Vote', () => {
  const html = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow({ vote: facts() }) });
  assert.match(html, /<div class="gc-vote-card" role="group" aria-label="Vote on this change" data-vote-card="9000401" data-vote-state="promoted">/);
  assert.match(html, /<div class="gc-vote-card-name">Change #12 · Dark mode<\/div>/);
  assert.match(html, /<div class="gc-vote-card-facts" data-vote-facts="">Needs 1 more yes · All checks passed<\/div>/);
  assert.match(html, /<button[^>]*data-vote-preview=""[^>]*>Preview<\/button>/);
  assert.match(html, /<button[^>]*data-vote-open=""[^>]*>Vote<\/button>/);
  // The two pills are the shell's: a neutral one and the accent.
  assert.match(html, /<button[^>]*data-vote-preview=""[^>]*class="[^"]*rounded-full bg-zinc-200[^"]*"/);
  assert.match(html, /<button[^>]*data-vote-open=""[^>]*class="[^"]*rounded-full bg-violet-600[^"]*"/);
  // Nothing of the old row.
  assert.doesNotMatch(html, /Admin merge|gc-vote-btn|data-vote-controls|gc-vote-inline|>Yes<|>No</);
});

test('before the snapshot lands, the card names the change from the row and offers Vote alone', () => {
  const html = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow() });
  assert.match(html, /data-vote-card="9000401" data-vote-state="unknown"/);
  assert.match(html, /<div class="gc-vote-card-name">Change #12<\/div>/, 'the number the row itself carries');
  assert.doesNotMatch(html, /gc-vote-card-facts/, 'no facts to say');
  assert.doesNotMatch(html, /data-vote-preview/, 'no preview to open');
  assert.match(html, /data-vote-open=""[^>]*>Vote<\/button>/);
  // An old row with only the parsed number, and nothing known of it.
  const bare = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow({ voteRef: { sessionId: '', prNumber: '' } }) });
  assert.match(bare, /<div class="gc-vote-card-name">A change<\/div>/);
});

test('#6322: a vote line that names no change draws no card', () => {
  const html = renderComponent(TRANSCRIPT, 'SystemRow', {
    msg: voteRow({ systemText: 'snait voted up on close proposal for issue #436', voteRef: null }),
  });
  assert.match(html, /snait voted up on close proposal for issue #436/, 'the line itself stays');
  assert.doesNotMatch(html, /gc-vote-card/);
  assert.doesNotMatch(html, /data-vote-open/);
  assert.doesNotMatch(html, /A change/);
});

test('a settled change says so, offers See the vote rather than Vote, and no preview', () => {
  const merged = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow({ vote: facts({ status: 'merged', preview: null }) }) });
  assert.match(merged, /data-vote-state="merged"/);
  assert.match(merged, /data-vote-facts="">Merged<\/div>/);
  assert.match(merged, /data-vote-open=""[^>]*>See the vote<\/button>/);
  assert.doesNotMatch(merged, /data-vote-preview/);
  const building = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow({ vote: facts({ preview: { kind: 'building' } }) }) });
  assert.match(building, /Preview building…/);
  assert.doesNotMatch(building, /data-vote-preview/, 'no Preview button until the preview is live');
});

test('Homeroom bot\'s "up for a vote" post hangs the same card under its words, in a thread', () => {
  const html = renderComponent(TRANSCRIPT, 'MessageRow', { msg: botPost({ vote: facts() }), surface: 'thread' });
  assert.match(html, /data-msg-id="9"[^>]*data-vote-session="9000401" data-vote-pr="12"/, 'the pair refreshVoteControls reads');
  assert.match(html, /It’s up for a vote: Dark mode[\s\S]*<div class="gc-vote-card" role="group"/);
  assert.match(html, /gc-vote-card-name">Change #12 · Dark mode</);
  assert.doesNotMatch(html, /Admin merge|data-vote-controls|gc-vote-inline/);
});

// ── The line, on a request's page ─────────────────────────────────────

test('the line names the change and offers See the vote, and nothing else', () => {
  const html = renderComponent(CARD, 'VoteLine', { sessionId: 9000401, number: 6063, title: 'Dark mode' });
  assert.equal(html, '<div class="gc-vote-line" data-vote-line="9000401"><span class="gc-vote-line-name">Change #6063 · Dark mode</span> · <button type="button" class="dev-request-event-link" data-vote-see="">See the vote</button></div>');
  assert.match(renderComponent(CARD, 'VoteLine', { sessionId: 9000401, number: null, title: null }), /gc-vote-line-name">A change</);
  // See the vote is the door every "go and vote" button uses: the change's
  // section brings its Votes card into view and holds it (thread-changes.tsx).
  const src = read(CARD);
  assert.match(src, /onClick=\{\(\) => askVotesInView\(sessionId\)\}/);
  assert.match(src, /import \{ askVotesInView \} from '\.\.\/dev-board\/topic\/votes-in-view';/);
});

test('on a request\'s page a post about one of its changes draws the line, one about another change the card', () => {
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  // The page publishes its changes (request-head.tsx → requestChangesStore);
  // RequestRows reads them from the store, so the rows are pinned at the
  // source and the line is rendered directly above.
  const src = read(TRANSCRIPT);
  const rows = src.slice(src.indexOf('export function RequestRows('), src.indexOf('#4455: something that happened to a change'));
  assert.match(rows, /const seeVotes = useMemo\(\(\) => \{[\s\S]*?changes\.numbers[\s\S]*?changes\.titles\?\.\[id\][\s\S]*?\}, \[changes\]\);/);
  assert.match(rows, /<MessageRow key=\{key\} msg=\{msg\} grouped=\{grouped\} surface="thread" tag=\{tagOf\(msg\)\} seeVote=\{seeVoteOf\(msg\)\} \/>/);
  assert.match(rows, /<SystemRow key=\{key\} msg=\{msg\} seeVote=\{seeVoteOf\(msg\)\} \/>/);
  // With nothing published, the same rows draw the card (a change of another
  // request), never the inline row.
  const post = botPost({ changeOf: { sessionId: 9000401 }, vote: facts() });
  const html = renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead, messages: [post, voteRow({ id: 6 })] } });
  assert.equal((html.match(/class="gc-vote-card"/g) || []).length, 2);
  assert.doesNotMatch(html, /gc-vote-line|Admin merge|data-vote-controls/);
  // Handed the request's own change, a row draws the line instead.
  const line = renderComponent(TRANSCRIPT, 'MessageRow', { msg: post, surface: 'thread', seeVote: { sessionId: 9000401, number: 6063, title: 'Dark mode' } });
  assert.match(line, /<div class="gc-vote-line" data-vote-line="9000401"><span class="gc-vote-line-name">Change #6063 · Dark mode<\/span> · <button[^>]*data-vote-see="">See the vote<\/button><\/div>/);
  assert.doesNotMatch(line, /gc-vote-card/);
  const sys = renderComponent(TRANSCRIPT, 'SystemRow', { msg: voteRow(), seeVote: { sessionId: 9000401, number: 6063, title: 'Dark mode' } });
  assert.match(sys, /data-vote-line="9000401"/);
  assert.doesNotMatch(sys, /gc-vote-card/);
});

// ── No inline Admin merge, anywhere ───────────────────────────────────

test('Admin merge is a row of the change\'s ⋯ menu alone; no transcript render and no module draws it inline', () => {
  for (const file of [TRANSCRIPT, CARD, 'frontend/src/features/group-chat/proposal-event.tsx', 'public/js/group-chat.js']) {
    assert.doesNotMatch(read(file), /vote\.row\.adminMerge|castAdminMerge|gc-vote-btn-admin/, file);
  }
  const appView = read('public/js/app-view.js');
  assert.doesNotMatch(appView, /voteButtonsHtml\(pr, opts\) \{|_previewAffordanceHtml\(pr\) \{|_uncountedVoteNoteHtml\(pr\) \{|mergingBadgeHtml\(\) \{|mergedBadgeHtml\(\) \{/,
    'the inline row\'s renderers are gone');
  const menu = appView.slice(appView.indexOf('_proposalMenuItems(pr, state) {'), appView.indexOf('_proposalMenuItems(pr, state) {') + 1600);
  assert.match(menu, /label: PlatformI18n\.t\('changes:proposal\.menu\.adminMerge'\),[\s\S]*?act: \(\) => AppView\.castAdminMerge\(pr\.id\),/);
  assert.match(menu, /if \(canForceMerge && pr\.status === 'promoted'\)/, 'admins only, on an open vote');
  // The one producer of the words left is that menu row.
  assert.equal(message('changes:proposal.menu.adminMerge'), 'Admin merge');
  // The ownership audit no longer sanctions a legacy write under the transcript.
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#gc-messages' \},\n\s*\{ sel: '#gc-thread-messages' \},/);
  assert.doesNotMatch(audit, /except: \['\[data-vote-controls\]'\]/);
  // The live burst still reads the chat's snapshot when a row about a change is on screen.
  assert.match(read('public/js/app.js'), /document\.querySelector\('#gc-messages \[data-vote-session\], #gc-thread-messages \[data-vote-session\]'\)/);
  // And the stylesheet draws the card, not the row.
  const css = read('public/css/app.css');
  assert.match(css, /\.gc-vote-card \{[^}]*border-radius: 20px;[^}]*background: var\(--dc-sheet-solid\);[^}]*box-shadow: inset 0 0 0 1px var\(--app-sheet-line\);/);
  assert.match(css, /\.gc-vote-card-name \{[^}]*font-size: 15px;/);
  assert.match(css, /\.gc-vote-card-facts \{[^}]*font-size: 13px;/);
  assert.doesNotMatch(css, /\.gc-vote-inline \{|\.gc-vote-btn-admin \{|\.gc-vote-voted-box \{/);
});
