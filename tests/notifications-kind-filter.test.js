// The notifications sheet's kind chips on the All tab (#3206).
//
// The grouping is evaluated from the shipped, import-free module (so the test
// cannot drift from what the sheet calls); the wiring is read off the sheet's
// own source, the way the other notifications tests do.
//
// Run with: node --test tests/notifications-kind-filter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const DIR = path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications');
const KINDS_SRC = fs.readFileSync(path.join(DIR, 'notifications-kinds.js'), 'utf8');
const SHEET_SRC = fs.readFileSync(path.join(DIR, 'notifications-sheet.tsx'), 'utf8');
const CONTROLLER_SRC = fs.readFileSync(path.join(DIR, 'notifications.js'), 'utf8');
const SERVICE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'notifications.js'), 'utf8');

const { NOTIFICATION_KIND_FILTERS, NOTIFICATION_KIND_FILTER_KEYS, matchesKindFilter } = new Function(
  `${KINDS_SRC.replace(/^export /gm, '')}; return { NOTIFICATION_KIND_FILTERS, NOTIFICATION_KIND_FILTER_KEYS, matchesKindFilter };`
)();

test('three chips: votes, mentions & replies, invites, and no Messages filter (#5289)', () => {
  assert.deepEqual([...NOTIFICATION_KIND_FILTER_KEYS], ['votes', 'mentions', 'invites']);
  assert.deepEqual(Object.keys(NOTIFICATION_KIND_FILTERS), ['votes', 'mentions', 'invites']);
  assert.ok(!('messages' in NOTIFICATION_KIND_FILTERS));
});

test('every kind a chip names is a kind the platform writes', () => {
  for (const kinds of Object.values(NOTIFICATION_KIND_FILTERS)) {
    for (const kind of kinds) {
      assert.ok(
        CONTROLLER_SRC.includes(`'${kind}'`) || SERVICE_SRC.includes(`'${kind}'`),
        `${kind} is not a notification kind`,
      );
    }
  }
});

test('the reporter\'s noise stays out of every chip; what they came for is in one', () => {
  for (const noise of ['kudos', 'app_quota_changed', 'app_quota_request_declined', 'conversation_message', 'session_done']) {
    for (const key of NOTIFICATION_KIND_FILTER_KEYS) assert.equal(matchesKindFilter(noise, key), false, `${noise} in ${key}`);
  }
  assert.equal(matchesKindFilter('pr_proposed', 'votes'), true);
  assert.equal(matchesKindFilter('stale_pr', 'votes'), true);
  assert.equal(matchesKindFilter('mention', 'mentions'), true);
  assert.equal(matchesKindFilter('conversation_mention', 'mentions'), true);
  assert.equal(matchesKindFilter('conversation_invite', 'invites'), true);
  assert.equal(matchesKindFilter('friend_request', 'invites'), true);
  assert.equal(matchesKindFilter('friend_accept', 'invites'), false);
});

test('no filter, or an unknown one, keeps every row', () => {
  assert.equal(matchesKindFilter('kudos', null), true);
  assert.equal(matchesKindFilter('kudos', ''), true);
  assert.equal(matchesKindFilter('kudos', '__proto__'), true);
  assert.equal(matchesKindFilter('kudos', 'toString'), true);
});

test('the chips render on All only, with the shell\'s Chip primitive', () => {
  assert.match(SHEET_SRC, /import \{ Chip, ChipRail \} from '@\/components\/ui\/chip';/);
  assert.match(SHEET_SRC, /\{tab === 'all' \? \(\s*<ChipRail\s+id="notifications-kind-filters"/);
  assert.match(SHEET_SRC, /id=\{`notifications-kind-\$\{key\}`\}/);
  // Tapping the lit chip clears it; one at a time.
  assert.match(SHEET_SRC, /setKindFilter\(kindFilter === key \? null : key\)/);
});

test('a chip narrows All, never Unread, and is forgotten when the sheet closes', () => {
  assert.match(SHEET_SRC, /const kindOn = tab === 'all' \? kindFilter : null;/);
  assert.match(SHEET_SRC, /kindOn \? all\.filter\(\(view\) => matchesKindFilter\(view\.kind, kindOn\)\) : all/);
  assert.match(SHEET_SRC, /if \(!open\) setKindFilter\(null\);/);
  // The pinned sections step aside while a chip is lit.
  assert.match(SHEET_SRC, /\{searching \|\| kindOn \? null : <NotificationsPinnedSections \/>\}/);
  // The initial state is null, so the prerendered sheet is unchanged.
  assert.match(SHEET_SRC, /useState<KindFilter \| null>\(null\)/);
});

test('the chips\' words and the empty line come from the catalog', () => {
  assert.equal(message('notifications:sheet.kind.votes'), 'Votes');
  assert.equal(message('notifications:sheet.kind.mentions'), 'Mentions & replies');
  assert.equal(message('notifications:sheet.kind.invites'), 'Invites');
  assert.equal(message('notifications:sheet.empty.kind'), 'Nothing of this kind yet.');
  assert.ok(message('notifications:sheet.kinds'));
  assert.match(SHEET_SRC, /kindOn \? t\('notifications:sheet\.empty\.kind'\)/);
});
