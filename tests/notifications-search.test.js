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

test('the query starts empty, and each opening after a close starts over (#21)', () => {
  assert.ok(
    SHEET_SRC.includes("[query, setQuery] = useState('')"),
    'the query state starts empty so the prerender is an empty field'
  );
  assert.ok(
    SHEET_SRC.includes("if (!open) setOlderShown(false);\n    else if (tab !== 'unread') setOlderShown(false);"),
    'the close effect still collapses the older-rows reveal'
  );
  // Phone review, 23 Nov 2026 (#21): the sheet reopened hours later on All
  // with an old word in the box. The reset runs as the sheet next OPENS
  // (so a sheet sliding away keeps its list), in a layout effect (so the
  // opening's first paint is the reset one), and not on the page's first
  // opening, where ?shot=notifications-all has just chosen its tab.
  const reset = SHEET_SRC.indexOf("if (reopenRef.current === 'closed') {");
  assert.ok(reset > 0, 'a reopened sheet is reset');
  const body = SHEET_SRC.slice(reset, SHEET_SRC.indexOf('}', reset));
  assert.match(body, /setQuery\(''\);/, 'the search box is emptied');
  assert.match(body, /setTab\(wantedTab \|\| 'unread'\);/, 'back on Unread, unless a door asked for a tab');
  const effect = SHEET_SRC.lastIndexOf('useIsomorphicLayoutEffect', reset);
  assert.ok(effect > SHEET_SRC.indexOf("[query, setQuery] = useState('')"), 'in a layout effect after the state');
  assert.match(SHEET_SRC.slice(reset, reset + 400), /\}, \[open\]\);/, 'keyed on the sheet opening and closing');
});

test('nothing remembers the query across visits any more (#21)', () => {
  assert.ok(!SHEET_SRC.includes("sessionStorage.setItem('usernode:notifications-search'"), 'no query is written to storage');
  assert.ok(!SHEET_SRC.includes("sessionStorage.getItem('usernode:notifications-search'"), 'no query is read back');
  const at = SHEET_SRC.indexOf("sessionStorage.removeItem('usernode:notifications-search')");
  assert.ok(at > 0, 'a value an older build kept is forgotten');
  assert.ok(SHEET_SRC.lastIndexOf('useEffect', at) > SHEET_SRC.indexOf("[query, setQuery] = useState('')"), 'after mount, never during render');
});

test('the field has a clear button while it holds text (#21)', () => {
  const clear = SHEET_SRC.indexOf('id="notifications-search-clear"');
  assert.ok(clear > SHEET_SRC.indexOf('id="notifications-search-input"'), 'the clear sits after the field');
  assert.ok(clear < SHEET_SRC.indexOf('"notifications-screen-tabs"'), 'inside the search block');
  const gate = SHEET_SRC.lastIndexOf('{query ? (', clear);
  assert.ok(gate > SHEET_SRC.indexOf('id="notifications-search-input"'), 'drawn only while the field holds text');
  assert.match(SHEET_SRC.slice(clear, clear + 800), /onClick=\{\(\) => \{ setQuery\(''\); searchRef\.current\?\.focus\(\); \}\}/, 'it empties the field and keeps the cursor there');
  assert.match(SHEET_SRC.slice(clear, clear + 800), /aria-label=\{t\('notifications:sheet\.search\.clear'\)\}/, 'it has a name');
  assert.equal(message('notifications:sheet.search.clear'), 'Clear search');
  assert.ok(SHEET_SRC.includes("onChange={(event) => setQuery(event.currentTarget.value.slice(0, 100))}"), 'typing is capped at 100');
});

test('while searching the headings, pinned sections and pager step aside', () => {
  assert.ok(
    SHEET_SRC.includes('{searching || kindOn || isThreads ? null : <NotificationsPinnedSections />}'),
    'the pinned sections are skipped while searching'
  );
  // The merged Unread grouping (#5406) folds the flat list's Today/Earlier
  // headings and the per-app groups under one `!searching &&` gate, so the
  // pin is the gate plus the headings sitting inside it.
  const gate = SHEET_SRC.indexOf(
    '{!searching && (groupedUnread ? renderAppGroups() : olderGrouped ? ('
  );
  assert.ok(gate > 0, 'the headings block is skipped while searching');
  // Phone review #118: All's sections (allSections) are the older rows'
  // cards, drawn inside the same gate, and are not built while searching.
  const allHeads = SHEET_SRC.indexOf('allSections.map(renderOlderSection)');
  assert.ok(allHeads > gate, 'the section headings are skipped while searching');
  assert.match(SHEET_SRC, /const allSections = tab === 'all' && !searching \?/);
  assert.ok(
    SHEET_SRC.includes("{searching ? null : (tab === 'unread' && !olderShown ? ("),
    'none of the pager footers render while searching'
  );
  assert.ok(
    SHEET_SRC.includes('{!searching && !isThreads && !entries.length ? ('),
    'the ordinary empty state is replaced while searching'
  );
  assert.ok(
    SHEET_SRC.includes('matches.length ? <div className="notifications-stack">{matches.map(renderEntry)}</div> : ('),
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