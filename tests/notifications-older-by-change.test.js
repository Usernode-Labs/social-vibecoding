'use strict';

// "See older notifications" on Unread, once revealed.
//
// Evan, 21 Oct 2026 (#5747): the older rows were the archive's flat Today /
// Earlier list, so revealing them undid the project stacks the tab opened on
// (#5580). They became one closed stack per project under Earlier, which hid
// every change but the newest behind "N more notifications" and read as one
// pile per project. Now Unread keeps its stacks, and the rows it does not list
// follow as one card per change in Today / Yesterday / Last 7 days / Older
// sections, each card naming its project on its meta line.
//
// These tests pin, on the shipped sources:
//
//   1. The grouping (groupOlderByTime): a request or proposal is one card
//      wherever its notifications fell, in the section of its newest one; the
//      rows about no change fold by kind within one project and one section;
//      the rows of no project fold not at all; empty sections are left out.
//   2. The render: revealed, Unread draws its own stacks, then each section's
//      heading and its cards, which sit in no stack and lead their meta line
//      with the project; the flat Today / Earlier list stays All's (and
//      search's).
//   3. A read card still saves on a phone: its swipe is Save alone.
//
// Run with: node --test tests/notifications-older-by-change.test.js

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

const HOUR = 60 * 60 * 1000;
const t = (id, values) => message(id, values);

// Wednesday 21 October 2026, 15:00 local time.
const NOW = new Date(2026, 9, 21, 15, 0, 0);
const at = (hoursAgo) => NOW.getTime() - hoursAgo * HOUR;

const view = (id, hoursAgo, overrides = {}) => ({
  id,
  kind: 'pr_proposed',
  unread: false,
  label: message('notifications:row.proposed.label'),
  segments: [{ t: 'strong', v: `Change ${id}` }],
  createdAtMs: at(hoursAgo),
  who: '',
  appLine: 'Notes',
  appName: 'Notes',
  appId: 5,
  storyKey: null,
  storyRef: null,
  ...overrides,
});

const keysOf = (sections) => sections.map((section) => section.key);
const idsOf = (section) => section.entries.map((entry) => entry.view.id);

// ── 1. the grouping ─────────────────────────────────────────────────────

test('older rows go in Today / Yesterday / Last 7 days / Older by local day', () => {
  const sections = sheet.groupOlderByTime([
    view(1, 2),
    view(2, 14), // 01:00 today
    view(3, 16), // 23:00 yesterday
    view(4, 39), // 00:00 yesterday
    view(5, 40), // 23:00 two days ago
    view(6, 159), // 00:00 six days ago: still the week
    view(7, 160), // 23:00 seven days ago: Older
  ].map((row, i) => ({ ...row, kind: `kind_${i}` })), t, NOW);
  assert.deepEqual(keysOf(sections), ['today', 'yesterday', 'week', 'longAgo']);
  assert.deepEqual(sections.map(idsOf), [[1, 2], [3, 4], [5, 6], [7]]);
});

test('a change is one card wherever its notifications fell, in the section of its newest', () => {
  const story = (number) => ({ storyKey: `r:5:${number}`, storyRef: { number, title: `Request ${number}` } });
  const sections = sheet.groupOlderByTime([
    view(1, 3, { ...story(10), kind: 'issue_mention', label: 'Mentioned you' }),
    view(2, 20, { ...story(11) }),
    view(3, 30, { ...story(10), kind: 'issue_opened', label: 'New request' }),
    view(4, 100, { ...story(10), kind: 'build_ready', label: 'Ready to try' }),
    // The same request number in another project is another change.
    view(5, 101, { ...story(10), storyKey: 'r:6:10', appId: 6, appName: 'Polls', appLine: 'Polls' }),
  ], t, NOW);
  assert.deepEqual(keysOf(sections), ['today', 'yesterday', 'week']);
  const card = sections[0].entries[0].view;
  assert.equal(card.id, 1, 'the card is drawn as its newest notification');
  assert.deepEqual(card.groupIds, [1, 3, 4], 'and stands for all three, across three sections');
  assert.deepEqual(card.story.members.map((member) => member.id), [1, 3, 4]);
  assert.deepEqual(sections.map(idsOf), [[1], [2], [5]], 'nothing of #10 is left in the older sections');
});

test('repeats about no change fold within one project and one section; rows of no project never fold', () => {
  const repeat = { kind: 'voted_change_merged', label: message('notifications:row.votedMerged.label') };
  const sections = sheet.groupOlderByTime([
    view(1, 1, repeat),
    view(2, 2, { ...repeat, appId: 6, appName: 'Polls', appLine: 'Polls' }),
    view(3, 3, repeat),
    view(4, 4, { kind: 'conversation_message', label: '@ana', conversation: true, appId: null, appName: null, appLine: '' }),
    view(5, 5, { kind: 'conversation_message', label: '@ana', conversation: true, appId: null, appName: null, appLine: '' }),
    view(6, 30, repeat),
  ], t, NOW);
  assert.deepEqual(sections.map(idsOf), [[1, 2, 4, 5], [6]],
    'Notes\'s two today fold where the newest stood; Polls\'s stays its own; a week apart never folds');
  const folded = sections[0].entries[0].view;
  assert.deepEqual(folded.groupIds, [1, 3]);
  assert.equal(folded.label, message('notifications:row.group.votedMerged', { count: 2 }));
});

test('the section headings are the catalog\'s', () => {
  assert.equal(message('notifications:sheet.today'), 'Today');
  assert.equal(message('notifications:sheet.yesterday'), 'Yesterday');
  assert.equal(message('notifications:sheet.lastWeek'), 'Last 7 days');
  assert.equal(message('notifications:sheet.longAgo'), 'Older');
  assert.match(SHEET_SRC, /today: 'notifications:sheet\.today',\s*yesterday: 'notifications:sheet\.yesterday',\s*week: 'notifications:sheet\.lastWeek',\s*longAgo: 'notifications:sheet\.longAgo',/);
});

// ── 2. the render ───────────────────────────────────────────────────────

test('revealed, Unread keeps its stacks and draws the older rows as sections of cards', () => {
  assert.match(SHEET_SRC, /const olderGrouped = tab === 'unread' && olderShown;/);
  assert.match(SHEET_SRC, /const appGroups = groupedUnread \|\| olderGrouped \? groupUnreadByApp\(unread, t\) : \[\];/);
  // The older rows are every row Unread does not list.
  assert.match(SHEET_SRC, /const listedIds = new Set\(unread\.map\(\(view\) => view\.id\)\);/);
  assert.match(SHEET_SRC, /const olderSections = olderGrouped \? groupOlderByTime\(all\.filter\(\(view\) => !listedIds\.has\(view\.id\)\), t\) : \[\];/);
  const at = SHEET_SRC.indexOf('{!searching && (groupedUnread ? appGroups.map(renderAppGroup) : olderGrouped ? (');
  assert.ok(at > 0, 'the revealed branch sits under the same search gate');
  const branch = SHEET_SRC.slice(at, SHEET_SRC.indexOf('{today.length ? (', at));
  assert.match(branch, /\{appGroups\.map\(renderAppGroup\)\}\s*\{olderSections\.map\(renderOlderSection\)\}/);
  assert.doesNotMatch(SHEET_SRC, /renderOlderGroup|olderGroups/, 'no older stack per project is left');
  // All, and the search, keep the flat Today / Earlier list.
  assert.ok(SHEET_SRC.indexOf('{today.length ? (', at) > at);
  assert.match(SHEET_SRC, /matches\.length \? matches\.map\(renderEntry\) : \(/);
});

test('an older section is its heading and its cards, in no stack, read and never removed', () => {
  const at = SHEET_SRC.indexOf('const renderOlderSection = (section: OlderSection): ReactNode => (');
  assert.ok(at > 0);
  const fn = SHEET_SRC.slice(at, SHEET_SRC.indexOf('const renderEntry = ', at));
  assert.match(fn, /<SectionHeader data-notif-older-head=\{section\.key\}>\s*\{t\(OLDER_SECTION_LABELS\[section\.key\]\)\}\s*<\/SectionHeader>/);
  assert.match(fn, /<div className="notifications-stack" data-notif-older=\{section\.key\}>/);
  assert.doesNotMatch(fn, /ProjectStack|data-notif-stack/, 'never a stack, so never closed');
  // A card cleared here (an unread plain message) stays where it is.
  assert.match(fn, /removes=\{false\}/);
  assert.doesNotMatch(fn, /held=/, 'read is not held: it is drawn at full strength');
  assert.match(fn, /groupName: entry\.view\.appId != null \? entry\.view\.appName \|\| entry\.view\.appLine : '',\s*leadsWithProject: true,/);
});

test('a card in no stack leads its meta line with its project', () => {
  assert.match(SHEET_SRC, /const project = card\.leadsWithProject && card\.groupName \? card\.groupName : null;/);
  assert.match(SHEET_SRC, /\{project && meta \? \(\s*<RichMessage id="notifications:story\.projectMeta" values=\{\{ project, meta \}\} components=\{\[<span className=\{PROJECT_INK\} \/>\]\} \/>\s*\) : project \? <span className=\{PROJECT_INK\}>\{project\}<\/span> : meta\}/);
  assert.equal(message('notifications:story.projectMeta'), '<0>{{project}}</0> · {{meta}}');
  // The stack's cards are unchanged: their heading names the project.
  assert.match(SHEET_SRC, /const source = view\.botMoment && view\.appId != null \? t\('notifications:row\.bot\.name'\)\s*: view\.appLine && view\.appLine !== card\.groupName \? view\.appLine : null;/);
});

// ── 3. a read card saves ────────────────────────────────────────────────

test('a read card\'s swipe is Save alone', () => {
  assert.match(SHEET_SRC, /if \(!\(clearable \|\| cardSave\) \|\| !touch \|\| !el \|\| !ui\?\.swipeActions\) return undefined;/);
  assert.match(SHEET_SRC, /actions: !clearable \? \[save\] : cardSave \? \[save, clear\] : \[clear\]/);
});
