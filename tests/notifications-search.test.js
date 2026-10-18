// Frontend tests for the notifications sheet's search field (#5405).
//
// The sheet already fetches and partitions every row it shows, so search
// runs over those loaded rows only: a query narrows the tab that is open,
// the headings and pager step aside while it is active, and emptying the
// field puts the list back exactly as it was. No server change.
//
// The matcher is extracted from the shipped source (so the tests can't
// drift from what the sheet calls); the wiring assertions read the sheet's
// own source, the way the other notifications tests do.
//
// Run with: node --test tests/notifications-search.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const SEARCH_PATH = path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-search.js'
);
const SHEET_PATH = path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-sheet.tsx'
);

const SEARCH_SRC = fs.readFileSync(SEARCH_PATH, 'utf8');
const SHEET_SRC = fs.readFileSync(SHEET_PATH, 'utf8');

// The module is import-free ESM; strip the `export` keywords and evaluate it
// as a plain script, then hand back its two functions.
const { normalizeNotificationQuery, matchesNotificationQuery } = new Function(
  `${SEARCH_SRC.replace(/^export /gm, '')}; return { normalizeNotificationQuery, matchesNotificationQuery };`
)();

// A notif entry as the sheet builds it (MessagesEntry's `notif` slot): the
// view's `appLine` is the project name, `label` the kind line, `segments`
// the subject parts. `by` and `time` are deliberately NOT matched.
function notifEntry(over = {}) {
  return {
    type: 'notif',
    key: 'n:1',
    at: 1,
    view: {
      appLine: 'Community Garden',
      label: 'Up for your vote',
      segments: [{ t: 'strong', v: 'Add a watering calendar' }],
      time: '2h ago',
      by: 'ana',
      ...over,
    },
  };
}

function sessionEntry(over = {}) {
  return {
    type: 'session',
    key: 's:1',
    at: 1,
    session: { title: 'Rebuild the leaderboard', appName: 'Chess Club', ...over },
  };
}

test('normalizeNotificationQuery trims and case-folds; whitespace-only is empty', () => {
  assert.equal(normalizeNotificationQuery('  Garden '), 'garden');
  assert.equal(normalizeNotificationQuery('GARDEN'), 'garden');
  assert.equal(normalizeNotificationQuery('   '), '');
  assert.equal(normalizeNotificationQuery(''), '');
  assert.equal(normalizeNotificationQuery(undefined), '');
});

test('a notification matches on its project name, kind line and subject', () => {
  const entry = notifEntry();
  // The sheet hands the matcher a normalized needle (normalizeNotificationQuery).
  const q = (raw) => matchesNotificationQuery(entry, normalizeNotificationQuery(raw));
  assert.equal(q('garden'), true);
  assert.equal(q('community garden'), true);
  assert.equal(q('vote'), true);
  assert.equal(q('WATERING'), true);
  assert.equal(q('chess'), false);
});

test('a notification does not match on the time or the by line alone', () => {
  const entry = notifEntry();
  assert.equal(matchesNotificationQuery(entry, normalizeNotificationQuery('2h ago')), false);
  assert.equal(matchesNotificationQuery(entry, normalizeNotificationQuery('ana')), false);
});

test('a session entry matches on its title and project name', () => {
  const entry = sessionEntry();
  const q = (raw) => matchesNotificationQuery(entry, normalizeNotificationQuery(raw));
  assert.equal(q('leaderboard'), true);
  assert.equal(q('chess club'), true);
  assert.equal(q('garden'), false);
});

test('an empty or whitespace-only query matches everything', () => {
  assert.equal(matchesNotificationQuery(notifEntry(), normalizeNotificationQuery('   ')), true);
  assert.equal(matchesNotificationQuery(notifEntry(), ''), true);
  assert.equal(matchesNotificationQuery(sessionEntry(), ''), true);
  assert.equal(matchesNotificationQuery(null, ''), true);
  assert.equal(matchesNotificationQuery(null, 'garden'), false);
});

test('the search field renders between the title row and the tab strip', () => {
  const field = SHEET_SRC.indexOf('"notifications-search-input"');
  const tabs = SHEET_SRC.indexOf('"notifications-screen-tabs"');
  assert.ok(field > 0, 'the sheet renders a search input');
  assert.ok(tabs > 0, 'the sheet still renders the tab strip');
  assert.ok(field < tabs, 'the search field sits above the tab strip');
  assert.ok(SHEET_SRC.includes('type="search"'), 'the field is a search input');
});

test('the query starts empty and is cleared when the sheet closes', () => {
  assert.ok(
    SHEET_SRC.includes("[query, setQuery] = useState('')"),
    'the query state starts empty so the prerender is an empty field'
  );
  assert.ok(
    SHEET_SRC.includes("if (!open) { setOlderShown(false); setQuery(''); }"),
    'the close effect clears the query when the sheet closes'
  );
});

test('while searching the headings, pinned sections and pager step aside', () => {
  assert.ok(
    SHEET_SRC.includes("{searching ? null : tab === 'messages' ? ("),
    'the All-messages link and pinned sections are skipped while searching'
  );
  // The merged Unread grouping (#5406) folds the flat list's Today/Earlier
  // headings and the per-app groups under one `!searching &&` gate, so the
  // pin is the gate plus the headings sitting inside it.
  const gate = SHEET_SRC.indexOf(
    '{!searching && (groupedUnread ? appGroups.map(renderAppGroup) : ('
  );
  assert.ok(gate > 0, 'the headings block is skipped while searching');
  const todayHead = SHEET_SRC.indexOf('{today.length ? (');
  const earlierHead = SHEET_SRC.indexOf('{earlier.length ? (');
  assert.ok(
    todayHead > gate && earlierHead > gate,
    'the Today/Earlier headings are skipped while searching'
  );
  assert.ok(
    SHEET_SRC.includes("{searching ? null : (tab === 'messages' && snap.messagesCanLoadMore ? ("),
    'none of the pager footers render while searching'
  );
  assert.ok(
    SHEET_SRC.includes('{!searching && !entries.length ? ('),
    'the ordinary empty state is replaced while searching'
  );
  assert.ok(
    SHEET_SRC.includes('matches.length ? matches.map(renderEntry) : ('),
    'the matches render through the same row renderer'
  );
});

test('the no-matches line is the catalog entry, with the query typed', () => {
  assert.equal(
    message('notifications:sheet.search.noMatches', { query: 'garden' }),
    'No notifications match “garden”.'
  );
  assert.ok(
    SHEET_SRC.includes("notifications:sheet.search.noMatches"),
    'the sheet renders the no-matches message'
  );
  assert.ok(
    SHEET_SRC.includes("id=\"notifications-search-empty\""),
    'the no-matches line has its own id'
  );
});