'use strict';

// Evan, 21 Oct 2026: "See older notifications" on Unread showed the older
// rows as the archive's flat Today / Earlier list, so revealing them undid
// the project stacks the tab opened on (#5580). Revealed, Unread keeps its
// stacks and the rows it does not list follow under Earlier as stacks of
// their own, one per project, folded the same way.
//
// These tests pin, on the shipped sources:
//
//   1. The grouping the older rows go through is the Unread tab's: one
//      group per project in feed order, a story folded into one card, the
//      rows of no project under Other.
//   2. The render: revealed, Unread draws its own stacks, then an Earlier
//      label and the older stacks, keyed apart from the unread ones, with no
//      Mark read; the flat Today / Earlier list stays All's (and search's).
//   3. A read card still saves on a phone: its swipe is Save alone.
//
// Run with: node --test tests/notifications-older-stacks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = fs.readFileSync(path.join(ROOT, SHEET_PATH), 'utf8');
const sheet = loadTsx(SHEET_PATH);

const MIN = 60 * 1000;
const t = (id, values) => message(id, values);

const view = (id, overrides = {}) => ({
  id,
  kind: 'voted_change_merged',
  unread: false,
  label: message('notifications:row.votedMerged.label'),
  segments: [{ t: 'strong', v: `Change ${id}` }],
  createdAtMs: Date.now() - id * MIN,
  who: '',
  appLine: 'Notes',
  appName: 'Notes',
  appId: 5,
  storyKey: null,
  storyRef: null,
  ...overrides,
});

// ── 1. the grouping ─────────────────────────────────────────────────────

test('older rows group by project in feed order, a story folded into one card', () => {
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const groups = sheet.groupUnreadByApp([
    view(1, { ...story, kind: 'build_live', label: 'Live' }),
    view(2, { appId: 6, appName: 'Polls', appLine: 'Polls', kind: 'pr_proposed', label: 'New change' }),
    view(3, { ...story, kind: 'issue_mention', label: 'Mentioned you' }),
    view(4, { kind: 'conversation_message', conversation: true, appId: null, appName: null, appLine: '' }),
  ], t);
  assert.deepEqual(groups.map((g) => g.key), ['a:5', 'a:6', 'other'], 'newest project first; no project is Other');
  const notes = groups[0].entries;
  assert.equal(notes.length, 1, 'the request\'s two notifications are one card');
  assert.deepEqual(notes[0].view.groupIds, [1, 3]);
  assert.deepEqual(notes[0].view.story.members.map((m) => m.id), [1, 3]);
});

// ── 2. the render ───────────────────────────────────────────────────────

test('revealed, Unread keeps its stacks and draws the older rows as stacks under Earlier', () => {
  assert.match(SHEET_SRC, /const olderGrouped = tab === 'unread' && olderShown;/);
  assert.match(SHEET_SRC, /const appGroups = groupedUnread \|\| olderGrouped \? groupUnreadByApp\(unread, t\) : \[\];/);
  // The older rows are every row Unread does not list.
  assert.match(SHEET_SRC, /const listedIds = new Set\(unread\.map\(\(view\) => view\.id\)\);/);
  assert.match(SHEET_SRC, /const olderGroups = olderGrouped \? groupUnreadByApp\(all\.filter\(\(view\) => !listedIds\.has\(view\.id\)\), t\) : \[\];/);
  const at = SHEET_SRC.indexOf('{!searching && (groupedUnread ? appGroups.map(renderAppGroup) : olderGrouped ? (');
  assert.ok(at > 0, 'the revealed branch sits under the same search gate');
  const branch = SHEET_SRC.slice(at, SHEET_SRC.indexOf('{today.length ? (', at));
  assert.match(branch, /\{appGroups\.map\(renderAppGroup\)\}\s*\{olderGroups\.length \? \(\s*<>\s*<SectionHeader data-notif-older-head="" className="pb-0">\s*\{t\('notifications:sheet\.earlier'\)\}\s*<\/SectionHeader>\s*\{olderGroups\.map\(renderOlderGroup\)\}/);
  assert.equal(message('notifications:sheet.earlier'), 'Earlier');
  // All, and the search, keep the flat Today / Earlier list.
  assert.ok(SHEET_SRC.indexOf('{today.length ? (', at) > at);
  assert.match(SHEET_SRC, /matches\.length \? matches\.map\(renderEntry\) : \(/);
});

test('an older stack is keyed apart from its project\'s unread stack and offers no Mark read', () => {
  const at = SHEET_SRC.indexOf('const renderOlderGroup = (group: AppGroup): ReactNode => {');
  assert.ok(at > 0);
  const fn = SHEET_SRC.slice(at, SHEET_SRC.indexOf('const renderEntry = ', at));
  assert.match(fn, /const key = `older:\$\{group\.key\}`;/);
  assert.match(fn, /groupKey=\{key\}/);
  assert.match(fn, /<AppGroupHead groupKey=\{key\} label=\{label\} appId=\{null\} onShowLess=\{showLess\} \/>/);
  // A card cleared here (an unread plain message) stays where it is.
  assert.match(fn, /removes=\{false\}/);
  assert.doesNotMatch(fn, /held=/, 'read is not held: it is drawn at full strength');
});

// ── 3. a read card saves ────────────────────────────────────────────────

test('a read card\'s swipe is Save alone', () => {
  assert.match(SHEET_SRC, /if \(!\(clearable \|\| cardSave\) \|\| !touch \|\| !el \|\| !ui\?\.swipeActions\) return undefined;/);
  assert.match(SHEET_SRC, /actions: !clearable \? \[save\] : cardSave \? \[save, clear\] : \[clear\]/);
});
