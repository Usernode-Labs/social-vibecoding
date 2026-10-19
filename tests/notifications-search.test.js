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

// A notif entry as the sheet builds it (an Entry): the
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

test('the query starts empty and is kept when the sheet closes (#5460)', () => {
  assert.ok(
    SHEET_SRC.includes("[query, setQuery] = useState('')"),
    'the query state starts empty so the prerender is an empty field'
  );
  assert.ok(
    SHEET_SRC.includes("if (!open) setOlderShown(false);\n    else if (tab !== 'unread') setOlderShown(false);"),
    'the close effect still collapses the older-rows reveal'
  );
  assert.ok(
    !SHEET_SRC.includes("setQuery('')"),
    'nothing wipes the query when the sheet closes — it is remembered now'
  );
});

test('the remembered search is restored after mount, not during render (#5460)', () => {
  const at = SHEET_SRC.indexOf("sessionStorage.getItem('usernode:notifications-search')");
  assert.ok(at > 0, 'the restore reads the remembered query from sessionStorage');
  const effect = SHEET_SRC.lastIndexOf('useEffect', at);
  assert.ok(
    effect > SHEET_SRC.indexOf("[query, setQuery] = useState('')"),
    'the read happens in an effect after the state is declared'
  );
  // The restore is capped like the field itself, so a stored value edited by
  // hand cannot exceed it.
  assert.ok(
    SHEET_SRC.includes('remembered.slice(0, 100)'),
    'a restored value is cut to the field 100-character cap'
  );
});

test('the query is written to the session key when set and removed when cleared (#5460)', () => {
  assert.ok(
    SHEET_SRC.includes("sessionStorage.setItem('usernode:notifications-search'"),
    'a non-empty query is remembered for the tab session'
  );
  assert.ok(
    SHEET_SRC.includes("sessionStorage.removeItem('usernode:notifications-search')"),
    'an empty query forgets the remembered search'
  );
  // Every write routes through rememberQuery, so the Escape clear and the
  // native search clear (an onChange with '') both reach the storage.
  const helper = SHEET_SRC.indexOf('const rememberQuery');
  assert.ok(helper > 0, 'the sheet routes writes through one persisting setter');
  assert.ok(
    SHEET_SRC.includes('onChange={(event) => rememberQuery(')
      && SHEET_SRC.includes("rememberQuery('')"),
    'typing and clearing both go through rememberQuery'
  );
});

test('while searching the headings, pinned sections and pager step aside', () => {
  assert.ok(
    SHEET_SRC.includes('{searching ? null : <NotificationsPinnedSections />}'),
    'the pinned sections are skipped while searching'
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
    SHEET_SRC.includes("{searching ? null : (tab === 'unread' && !olderShown ? ("),
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