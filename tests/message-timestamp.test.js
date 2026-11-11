// Discussion timestamps carry their date (#1808).
//
// Every transcript stamped a bare time of day, so a row read "2:41 PM"
// whether it was posted ten minutes ago or in March. The rule now is:
//
//   today             2:41 PM
//   earlier this year Jun 16, 2:41 PM
//   an earlier year   Jun 16, 2025, 2:41 PM
//
// and the hour is never zero-padded, in any of the copies (polish N5).
//
// with the unelided form on `title` in every case.
//
// Cards, feeds, lists and notification rows spend one segment of a crowded
// line on the stamp, so they get the second form instead:
//
//   under a minute    just now
//   under a week      3d ago
//   a week or more    Jun 16 — the same date part, from the same helper
//
// with the same unelided `title`. Seven days is the floor everywhere; the
// product used to switch at seven days in one place, thirty in another and
// never in five more.
//
// The rule lives three times, because two legacy classic scripts sit outside
// the bundle and cannot import from it: `frontend/src/lib/timestamp.ts` serves
// the React surfaces with both forms, `GroupChat._stamp` in
// `public/js/group-chat.js` serves the app chat's view model, and `relStamp`
// in `public/js/app-view.js` serves the board's cards and the session
// transcript. Copies drift, so this file does not pin them by grep. It
// EXECUTES all three against one table and asserts they answer identically:
// the frontend copy through the esbuild loader the render tests already use,
// the legacy copies by lifting them out of the shipped source into callable
// functions.
//
// The clock is injected on both, because the whole behaviour is the boundary
// between those three branches and a test that cannot move "today" only ever
// exercises the middle one.
//
// Run with: node --test tests/message-timestamp.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── the two implementations ────────────────────────────────────────

const { messageStamp, agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');

// #6103: every copy stamps in the date locale — the interface language with
// the device's region. There is no browser in this process, so the device
// list comes from node's own `navigator` when it has one.
const { dateLocale } = loadTsx('frontend/src/lib/i18n/locale.ts');
const DEVICE_LANGUAGES = typeof navigator === 'undefined' ? []
  : (navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean));
const LOCALE = dateLocale('en', DEVICE_LANGUAGES);

// Lift `_stamp(ts, now) { … }` out of the GroupChat object literal. Brace
// matching rather than a lazy regex: the body contains braces of its own, and
// a `.*?}` would stop at the first option object.
function legacyStamp(i18n = englishPlatformI18n()) {
  const src = read('public/js/group-chat.js');
  const head = '_stamp(ts, now) {';
  const start = src.indexOf(head);
  assert.ok(start > 0, 'GroupChat._stamp must still exist');
  let depth = 0;
  let i = start + head.length - 1;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = src.slice(start + head.length, i);
  return vm.runInNewContext(`(function (ts, now) {${body}})`, { PlatformI18n: i18n });
}

const stampLegacy = legacyStamp();

// Lift `relStamp` out of app-view.js. A plain file-scope function, so the
// slice is simpler than `_stamp`'s method lift — but it closes over
// `REL_FLOOR_MS`, which is the whole point of the copy, so that declaration
// is evaluated with it rather than substituted for a literal here.
function legacyRelStamp(i18n = englishPlatformI18n()) {
  const src = read('public/js/app-view.js');
  const floor = src.match(/^const REL_FLOOR_MS = .*;$/m);
  assert.ok(floor, 'REL_FLOOR_MS must still exist in app-view.js');
  const head = 'function relStamp(iso, now) {';
  const start = src.indexOf(head);
  assert.ok(start > 0, 'relStamp must still exist in app-view.js');
  let depth = 0;
  let i = start + head.length - 1;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return vm.runInNewContext(`${floor[0]}\n${src.slice(start, i + 1)}\nrelStamp;`, { PlatformI18n: i18n });
}

const relStampLegacy = legacyRelStamp();

// ─── the branch table ───────────────────────────────────────────────

// A fixed "now" so the branches are reachable. Local time throughout: these
// are the reader's own clock, and a UTC construction here would put the test
// on the wrong side of midnight for half the world.
const NOW = new Date(2026, 5, 16, 14, 41); // Jun 16 2026, 2:41 PM

const CASES = [
  ['same day, earlier', new Date(2026, 5, 16, 9, 5), false],
  ['same day, one minute ago', new Date(2026, 5, 16, 14, 40), false],
  ['yesterday', new Date(2026, 5, 15, 23, 59), true],
  ['earlier this year', new Date(2026, 2, 3, 8, 15), true],
  ['first instant of this year', new Date(2026, 0, 1, 0, 0), true],
  ['last instant of last year', new Date(2025, 11, 31, 23, 59), true],
  ['years ago', new Date(2023, 8, 2, 19, 30), true],
];

test('#1808: the date appears exactly when it is not today', () => {
  for (const [label, when, expectDate] of CASES) {
    const { text } = messageStamp(when, { now: NOW });
    const time = when.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
    if (expectDate) {
      assert.notEqual(text, time, `${label}: a stamp that is not today's must say so`);
      assert.ok(text.endsWith(time), `${label}: the time is still the tail of the stamp`);
      const day = when.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
      assert.ok(text.startsWith(day), `${label}: the day leads, got ${text}`);
    } else {
      assert.equal(text, time, `${label}: today keeps the dense form it always had`);
    }
  }
});

test('#1808: the year appears only outside the current one', () => {
  const thisYear = messageStamp(new Date(2026, 2, 3, 8, 15), { now: NOW }).text;
  const lastYear = messageStamp(new Date(2025, 2, 3, 8, 15), { now: NOW }).text;
  assert.doesNotMatch(thisYear, /2026/, 'a repeated year is noise, not information');
  assert.match(lastYear, /2025/, 'an older year is the whole point of showing one');
});

test('#1808: the title never elides, whatever the text did', () => {
  for (const [label, when] of CASES) {
    const { title } = messageStamp(when, { now: NOW });
    assert.match(title, new RegExp(String(when.getFullYear())), `${label}: year in the title`);
    const time = when.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
    assert.ok(title.includes(time), `${label}: time in the title`);
  }
});

test('#1808: an unstamped or malformed message renders nothing, not "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'not a date', NaN]) {
    for (const [copy, stamp] of [['frontend', messageStamp(bad, { now: NOW })],
      ['legacy', stampLegacy(bad, NOW)]]) {
      assert.equal(stamp.text, '', `${copy} copy on ${JSON.stringify(bad)}`);
      assert.equal(stamp.title, '', `${copy} copy on ${JSON.stringify(bad)}`);
    }
  }
});

// ─── the two copies agree ───────────────────────────────────────────

test('#1808: GroupChat._stamp and lib/timestamp answer identically', () => {
  for (const [label, when] of CASES) {
    // Both render the unpadded hour now (polish N5: "04:14 AM" in one
    // place, "1:28 AM" in the next). Compared on the shared default, so a
    // difference here is a difference in the RULE.
    // Field by field, not deepEqual: the legacy copy is evaluated in a vm
    // realm, so its object literal has a different Object.prototype and a
    // strict deep comparison fails on two identical results.
    const legacy = stampLegacy(when, NOW);
    const shared = messageStamp(when, { now: NOW });
    assert.equal(legacy.text, shared.text,
      `${label}: the two transcripts must stamp the same instant the same way`);
    assert.equal(legacy.title, shared.title, `${label}: and title the same way`);
  }
});

test('#6103: an English interface on a UK device writes "2 Nov" in every copy', () => {
  // The device's region decides the order and the interface language keeps
  // the words (#6103). `navigator.languages` is the device, and all three
  // copies read it through the one rule, so stubbing it here reaches them all.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages: ['en-GB'], language: 'en-GB' }, configurable: true, writable: true,
  });
  try {
    const at = new Date(2026, 10, 2, 9, 5); // 2 Nov 2026
    const now = new Date(2026, 11, 20, 14, 41); // Dec 20: past the floor, same year
    assert.equal(agoStamp(at, { now }).text, '2 Nov', 'a card reads the day first');
    assert.equal(relStampLegacy(at, now).text, '2 Nov', 'and so does the session transcript');
    assert.ok(messageStamp(at, { now }).text.startsWith('2 Nov, '),
      `the date part is day first, got ${messageStamp(at, { now }).text}`);
    assert.ok(stampLegacy(at, now).text.startsWith('2 Nov, '),
      `the chat copy agrees, got ${stampLegacy(at, now).text}`);
    assert.equal(stampLegacy(at, now).text, messageStamp(at, { now }).text,
      'the two transcript copies print the same instant alike');
    assert.equal(relStampLegacy(at, now).text, agoStamp(at, { now }).text,
      'the two card copies print the same instant alike');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

test('polish N5: no copy pads the hour, so "04:14 AM" and "1:28 AM" never sit side by side', () => {
  for (const file of ['frontend/src/lib/timestamp.ts', 'public/js/group-chat.js', 'frontend/src/features/leaderboard/activity-row.tsx']) {
    assert.doesNotMatch(read(file), /hour: '2-digit'/, file);
  }
  const relStampSrc = read('public/js/app-view.js').match(/function relStamp\(iso, now\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(relStampSrc, /hour: '2-digit'/, 'relStamp');
});

test('#1808: both copies default their clock to now', () => {
  // Neither takes `now` in production; the parameter exists for this file.
  const today = new Date();
  const time = today.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  assert.equal(messageStamp(today).text, time);
  assert.equal(stampLegacy(today).text, time);
});

// ─── form B: the age on a card, feed or list row ────────────────────

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms);

// Every branch, and both sides of the one boundary that is the fix. `null`
// in the third column means "past the floor, so this is a date, not a
// duration" — the expected text is derived from the instant rather than
// written out, because the spelling is the reader's own locale's.
const AGO_CASES = [
  ['under a minute', ago(20 * 1000), 'just now'],
  ['a minute exactly', ago(60 * 1000), '1m ago'],
  ['minutes', ago(12 * 60 * 1000), '12m ago'],
  ['an hour exactly', ago(60 * 60 * 1000), '1h ago'],
  ['hours', ago(5 * 60 * 60 * 1000), '5h ago'],
  ['a day exactly', ago(DAY), '1d ago'],
  ['six days', ago(6 * DAY), '6d ago'],
  ['one second under a week', ago(7 * DAY - 1000), '6d ago'],
  ['seven days exactly', ago(7 * DAY), null],
  ['forty days', ago(40 * DAY), null],
  ['a previous year', new Date(2025, 5, 16, 14, 41), null],
];

test('#1808: the age is relative under a week and a date from a week on', () => {
  for (const [label, when, expected] of AGO_CASES) {
    const { text } = agoStamp(when, { now: NOW });
    if (expected) {
      assert.equal(text, expected, `${label}: got ${text}`);
    } else {
      // Past the floor: exactly the date part messageStamp would print, with
      // the year elided inside the current one and spelled out outside it.
      const day = when.toLocaleDateString(LOCALE, when.getFullYear() === NOW.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' });
      assert.equal(text, day, `${label}: got ${text}`);
    }
  }
});

test('#1808: nothing is still relative at or past seven days', () => {
  // The regression this closes: the notification rows read "412d ago", which
  // is a duration and not information. Asserted as a property over a sweep
  // rather than at the one instant the table happens to name, so a floor
  // moved back to thirty days cannot pass.
  for (let days = 7; days <= 400; days += 1) {
    const { text } = agoStamp(ago(days * DAY), { now: NOW });
    assert.doesNotMatch(text, /ago|just now/,
      `${days} days ago must read as a date, got ${text}`);
  }
  // And the last relative reading is the day before the floor, not a
  // rounded-up "7d ago" at 6d23h59m.
  assert.equal(agoStamp(ago(7 * DAY - 1), { now: NOW }).text, '6d ago');
});

test('#1808: a future instant clamps to "just now" rather than a negative age', () => {
  // Server and browser clocks disagree, and "-3m ago" is worse than round.
  for (const skew of [1000, 60 * 1000, 3 * DAY]) {
    assert.equal(agoStamp(new Date(NOW.getTime() + skew), { now: NOW }).text, 'just now');
  }
});

test('#1808: the two forms cannot drift in what they call a day', () => {
  // Both spell the absolute part from one helper, so a stamp read on a card
  // and the same stamp read in a transcript name the same day the same way.
  for (const [label, when] of AGO_CASES) {
    const message = messageStamp(when, { now: NOW });
    const age = agoStamp(when, { now: NOW });
    assert.equal(age.title, message.title, `${label}: one title, both forms`);
    if (!sameLocalDay(when, NOW)) {
      const date = message.text.slice(0, message.text.lastIndexOf(', '));
      assert.ok(date, `${label}: the transcript form leads with a date`);
      const elapsed = NOW.getTime() - when.getTime();
      if (elapsed >= 7 * DAY) {
        assert.equal(age.text, date,
          `${label}: past the floor the card prints exactly that date`);
      }
    }
  }
});

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

test('#1808: the age carries an unelided title in every branch', () => {
  for (const [label, when] of AGO_CASES) {
    const { title } = agoStamp(when, { now: NOW });
    assert.match(title, new RegExp(String(when.getFullYear())), `${label}: year`);
    const time = when.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
    assert.ok(title.includes(time), `${label}: time`);
    const day = when.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
    assert.ok(title.includes(day.replace(/^0/, '')) || title.includes(day),
      `${label}: day, got ${title}`);
  }
});

test('#1808: an unstamped card renders nothing in either form', () => {
  for (const bad of [null, undefined, '', 'not a date', NaN]) {
    for (const [copy, stamp] of [['agoStamp', agoStamp(bad, { now: NOW })],
      ['relStamp', relStampLegacy(bad, NOW)]]) {
      assert.equal(stamp.text, '', `${copy} on ${JSON.stringify(bad)}`);
      assert.equal(stamp.title, '', `${copy} on ${JSON.stringify(bad)}`);
    }
  }
});

test('#1808: relStamp and agoStamp answer identically', () => {
  // The board's cards and the session transcript read the app-view.js copy;
  // everything in the bundle reads the other. Executed, not grepped.
  for (const [label, when] of AGO_CASES) {
    const legacy = relStampLegacy(when, NOW);
    const shared = agoStamp(when, { now: NOW });
    assert.equal(legacy.text, shared.text, `${label}: same age`);
    assert.equal(legacy.title, shared.title, `${label}: same title`);
  }
  // Including the floor itself, which is the number most likely to be edited
  // in one copy and not the other.
  for (let days = 5; days <= 10; days += 1) {
    const when = ago(days * DAY);
    assert.equal(relStampLegacy(when, NOW).text, agoStamp(when, { now: NOW }).text,
      `${days} days: both copies must place the floor in the same place`);
  }
});

test('#1808: relStamp defaults its clock to now, like the other two', () => {
  const when = new Date(Date.now() - 3 * 60 * 60 * 1000);
  assert.equal(relStampLegacy(when).text, '3h ago');
  assert.equal(agoStamp(when).text, '3h ago');
});

// ─── the surfaces that render it ────────────────────────────────────

test('#1808: the app chat view model carries both forms to the row', () => {
  const js = read('public/js/group-chat.js');
  assert.match(js, /const stamp = GroupChat\._stamp\(msg\.createdAt \|\| msg\.created_at\);/,
    '_messageView resolves the stamp, as it resolves every other branch');
  assert.match(js, /\n\s*time: stamp\.text,\n\s*timeTitle: stamp\.title,/,
    'the view model carries the text and the full form');
  // The old inline call is the regression: it stamped the time alone.
  assert.doesNotMatch(js, /new Date\(msg\.createdAt \|\| msg\.created_at\)\s*\n?\s*\.toLocaleTimeString/,
    'no second, narrower formatter for the same field');
  const tsx = read('frontend/src/features/group-chat/transcript.tsx');
  const shown = tsx.match(/<span className="gc-msg-time"[^>]*>/g) || [];
  assert.equal(shown.length, 3, 'the message row, a request\'s GitHub reply (#4453) and the spec card all stamp a time');
  for (const tag of shown) {
    assert.match(tag, /title=\{msg\.timeTitle\}/,
      'every rendered time hangs the full stamp off title');
  }
});

test('#1808: the DM rows use the shared rule rather than a fourth copy', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  // #2783: `timeOfDay` beside it, from the same module, for the gutter of a
  // grouped continuation line — still the shared rule, not a local copy.
  assert.match(row, /import \{ messageStamp, timeOfDay \} from '\.\.\/\.\.\/lib\/timestamp';/);
  assert.match(row, /messageStamp\(message\.createdAt, \{ hour: 'numeric' \}\)\.text/);
  assert.doesNotMatch(row, /toLocaleTimeString/, 'the local formatter is gone');
  // fullTime is the same instant with nothing elided, and it is what the
  // title on those rows already rendered.
  assert.match(read('frontend/src/features/messages/format.tsx'),
    /export function fullTime\(value: string\): string \{\s*\n\s*return messageStamp\(value\)\.title;/);
});

test('#1808: the edited tooltip is the same full stamp, not a third spelling', () => {
  const js = read('public/js/group-chat.js');
  assert.match(js, /_editedTitle\(ts\) \{\s*\n\s*const \{ title \} = GroupChat\._stamp\(ts\);/);
  assert.equal(stampLegacy(new Date(2025, 5, 16, 14, 41), NOW).title,
    messageStamp(new Date(2025, 5, 16, 14, 41), { now: NOW }).title);
});

test('#1808: a request\'s GitHub replies are stamped a day and a time, in the reader\'s zone', () => {
  // The bug this closes was one line narrower than the rest of #1808: the
  // GitHub thread under an issue printed `createdAt.slice(0, 10)`, a UTC
  // DATE with no time at all. So a comment posted at 20:30 in Sao Paulo was
  // stamped with the next day, directly above a Discussion thread that got
  // both right. Since #4453 those comments are rows of the request page's
  // thread, stamped by the thread's own `GroupChat._stamp`. The fixture is
  // the instant that shows it: 23:30 UTC on the 16th is already the 17th
  // anywhere east of UTC, and `slice(0, 10)` can only ever say the 16th.
  const rows = read('public/js/app-view.js').match(/\n {2}_requestThreadRows\(number\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(rows, '_requestThreadRows() found');
  assert.match(rows[1], /GroupChat\._stamp\(iso\)/, 'the thread\'s own stamp');
  assert.match(rows[1], /time: stamp\.text,\n\s*timeTitle: stamp\.title,/);
  assert.doesNotMatch(rows[1], /slice\(0, 10\)/);

  const before = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    const at = '2026-06-16T23:30:00Z';
    const stamp = stampLegacy(at, NOW);
    const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', { view: {
      lead: { earlier: false, placeholder: null, language: 'request', request: { loaded: true } },
      messages: [{ id: null, key: '1', kind: 'github', username: 'evan', time: stamp.text, timeTitle: stamp.title, at,
        bodyHtml: '<p>hi</p>', systemText: '', mine: false, editedTitle: null, unread: false, bookmarked: false,
        canEdit: false, flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
        reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null }],
    } });
    const shown = html.match(/<span class="gc-msg-time" title="([^"]+)">([^<]*)<\/span>/);
    assert.ok(shown, 'the row renders a .gc-msg-time');
    assert.match(shown[2], /Jun 17/, `east of UTC that instant is the 17th, got ${shown[2]}`);
    assert.match(shown[2], /\d\d?:\d\d/, 'and it carries a time of day');
    assert.ok(shown[1].trim(), 'and the unelided stamp on title');
    assert.doesNotMatch(html, /2026-06-16</);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('#1808: the topic page keeps no formatter of its own, and draws no Activity list at all now', () => {
  // A change's Activity used to be rendered twice, on mutually exclusive
  // paths — the tab inside the conversation card (topic/conversation.tsx)
  // and the <details> in TopicBodySections — and both once printed
  // `new Date(at).toLocaleString()`, a fourth spelling of an instant. The
  // lists are gone with the tabs: the card's meta line carries the created
  // stamp and the Checks row's "Last run" the other, both through the one
  // helper. What stays pinned is that neither file grew a formatter back.
  // #4455: the conversation is the change page's own thread now
  // (topic/change-head.tsx draws its root post).
  const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';
  const HEAD = 'frontend/src/features/dev-board/topic/topic-head.tsx';
  for (const rel of [CHANGE, HEAD]) {
    const src = read(rel);
    assert.doesNotMatch(src, /toLocaleString/, `${rel} keeps no formatter of its own`);
    assert.doesNotMatch(src, /\.activity\b/, `${rel} draws no Activity list`);
  }
  assert.doesNotMatch(read('frontend/src/features/dev-board/topic/model.ts'), /\bactivity\b/,
    'and the view model no longer carries one');
});

// ─── #6479: the zone picked in Settings › Language ──────────────────

test('#6479: with a zone picked, every copy writes the time and decides "today" in that zone', () => {
  // One instance of the zone module, handed to all three copies: the bundle's
  // through its import, the classic copies through PlatformI18n.
  const zone = loadTsx('frontend/src/lib/time-zone.ts', { cache: false });
  const zoned = loadTsx('frontend/src/lib/timestamp.ts', { cache: false, stubs: { './time-zone': zone } });
  const i18n = { ...englishPlatformI18n(), timeZone: zone.getTimeZone, zonedDay: zone.zonedDay };
  const chat = legacyStamp(i18n);
  const card = legacyRelStamp(i18n);
  // 03:30 UTC on 16 Jun: still the evening of the 15th in New York, midday
  // of the 16th in Tokyo.
  const now = new Date(Date.UTC(2026, 5, 16, 3, 30));
  const evening = new Date(Date.UTC(2026, 5, 15, 14, 0)); // 10 AM the 15th in NY, 11 PM the 15th in Tokyo
  const timeIn = (when, timeZone) => when.toLocaleTimeString(LOCALE, { timeZone, hour: 'numeric', minute: '2-digit' });
  const dayIn = (when, timeZone) => when.toLocaleDateString(LOCALE, { timeZone, month: 'short', day: 'numeric' });
  try {
    zone.setTimeZone('America/New_York');
    assert.equal(zone.getTimeZone(), 'America/New_York');
    const ny = zoned.messageStamp(evening, { now });
    assert.equal(ny.text, timeIn(evening, 'America/New_York'), 'the 15th is still today in New York');
    assert.equal(chat(evening, now).text, ny.text, 'GroupChat._stamp agrees');
    assert.equal(chat(evening, now).title, ny.title);

    zone.setTimeZone('Asia/Tokyo');
    const tokyo = zoned.messageStamp(evening, { now });
    assert.equal(tokyo.text, `${dayIn(evening, 'Asia/Tokyo')}, ${timeIn(evening, 'Asia/Tokyo')}`,
      'in Tokyo the same instant was yesterday, and the time is Tokyo\'s');
    assert.equal(chat(evening, now).text, tokyo.text, 'GroupChat._stamp agrees');
    assert.notEqual(tokyo.title, ny.title, 'the unelided title moves with the zone too');

    // The age form past its floor is a date: the 31 Dec 23:30 UTC instant is
    // already the new year in Tokyo, so it is "this year" there.
    const nye = new Date(Date.UTC(2025, 11, 31, 23, 30));
    const later = new Date(Date.UTC(2026, 1, 1, 12, 0));
    assert.equal(zoned.agoStamp(nye, { now: later }).text, dayIn(nye, 'Asia/Tokyo'));
    assert.equal(card(nye, later).text, zoned.agoStamp(nye, { now: later }).text, 'relStamp agrees');
    assert.equal(card(nye, later).title, zoned.agoStamp(nye, { now: later }).title);

    // Auto again: back to the device's zone, exactly the stamps without one.
    zone.setTimeZone(null);
    assert.equal(zone.getTimeZone(), undefined);
    assert.deepEqual(zoned.messageStamp(evening, { now }), messageStamp(evening, { now }));
    assert.deepEqual({ ...chat(evening, now) }, { ...stampLegacy(evening, now) });
  } finally {
    zone.setTimeZone(null);
  }
});

test('#6479: a zone this engine does not know falls back to the device, never throws', () => {
  const zone = loadTsx('frontend/src/lib/time-zone.ts', { cache: false });
  zone.setTimeZone('Mars/Olympus_Mons');
  assert.equal(zone.getTimeZone(), undefined);
  assert.equal(zone.validTimeZone('asia/tokyo'), 'Asia/Tokyo');
  assert.equal(zone.timeZoneLabel('America/Los_Angeles'), 'America / Los Angeles');
});

test('#6479: the transcript\'s day separators group by the picked zone, as its stamps do', () => {
  const zone = loadTsx('frontend/src/lib/time-zone.ts', { cache: false });
  const { dayKey, dayLabel } = loadTsx('frontend/src/features/messages/index.tsx', { cache: false, stubs: { '../../lib/time-zone': zone } });
  // 14:30 UTC and 15:30 UTC on 10 Nov: the 10th and the 11th in Tokyo.
  const a = { createdAt: '2026-11-10T14:30:00Z' };
  const b = { createdAt: '2026-11-10T15:30:00Z' };
  const now = new Date('2026-11-11T03:00:00Z'); // the 11th in Tokyo, noon
  try {
    zone.setTimeZone('Asia/Tokyo');
    assert.notEqual(dayKey(a), dayKey(b), 'two days in Tokyo, so two separators');
    assert.equal(dayLabel(b, now), message('messages:thread.day.today'));
    assert.equal(dayLabel(a, now), message('messages:thread.day.yesterday'));
    zone.setTimeZone('Europe/London');
    assert.equal(dayKey(a), dayKey(b), 'one day in London');
    assert.equal(dayLabel(a, now), message('messages:thread.day.yesterday'));
  } finally {
    zone.setTimeZone(null);
  }
});

test('#6479: day words and day groups elsewhere read the picked zone too', () => {
  const zone = loadTsx('frontend/src/lib/time-zone.ts', { cache: false });
  const stub = (entry, spec) => loadTsx(entry, { cache: false, stubs: { [spec]: zone } });
  const { liveDay } = stub('frontend/src/features/messages/bot-ready.tsx', '../../lib/time-zone');
  const { dayKey } = stub('frontend/src/features/ai/model.ts', '../../lib/time-zone');
  const { monthKey } = stub('frontend/src/features/ai/history.ts', '../../lib/time-zone');
  const { visitDay } = stub('frontend/src/features/messages/welcome-back.tsx', '../../lib/time-zone');
  const { liveSinceLine } = stub('frontend/src/features/dev-board/workshop/hub-cards.tsx', '../../../lib/time-zone');
  try {
    zone.setTimeZone('Asia/Tokyo');
    // 23:00Z on the 10th is 08:00 on the 11th in Tokyo; 00:30Z on the 11th is
    // 09:30 the same Tokyo day: today, not tomorrow.
    assert.deepEqual({ ...liveDay('2026-11-11T00:30:00Z', new Date('2026-11-10T23:00:00Z'), 'en-US') }, { kind: 'today' });
    assert.deepEqual({ ...liveDay('2026-11-12T00:30:00Z', new Date('2026-11-10T23:00:00Z'), 'en-US') }, { kind: 'tomorrow' });
    // 16:00Z on 31 Oct is 1 Nov in Tokyo: the AI tab's day and History's month.
    assert.equal(dayKey('2026-10-31T16:00:00Z'), '2026-11-01');
    assert.equal(monthKey('2026-10-31T16:00:00Z'), '2026-11');
    // A visit at 23:30Z on the 10th was this morning (08:30) in Tokyo on the 11th.
    assert.equal(visitDay('2026-11-10T23:30:00Z', new Date('2026-11-11T03:00:00Z'), 'en-US').kind, 'thisMorning');
    assert.equal(liveSinceLine('2026-11-10T23:30:00Z', Date.parse('2026-11-11T03:00:00Z')),
      message('project:hub.recent.own.today'));
    zone.setTimeZone('Europe/London');
    assert.deepEqual({ ...liveDay('2026-11-11T00:30:00Z', new Date('2026-11-10T23:00:00Z'), 'en-US') }, { kind: 'tomorrow' });
    assert.equal(dayKey('2026-10-31T16:00:00Z'), '2026-10-31');
    assert.equal(monthKey('2026-10-31T16:00:00Z'), '2026-10');
    assert.equal(visitDay('2026-11-10T23:30:00Z', new Date('2026-11-11T03:00:00Z'), 'en-US').kind, 'yesterday');
  } finally {
    zone.setTimeZone(null);
  }
});

test('#6479: the notification sheet\'s Today / Yesterday sections are the picked zone\'s days', () => {
  const zone = loadTsx('frontend/src/lib/time-zone.ts', { cache: false });
  const { groupOlderByTime, splitToday } = loadTsx('frontend/src/features/notifications/notifications-sheet.tsx', { cache: false, stubs: { '../../lib/time-zone': zone } });
  const row = (id, iso) => ({ id, createdAtMs: Date.parse(iso), kind: 'mention', appSlug: null, actor: { username: `p${id}` } });
  const now = new Date('2026-11-11T03:00:00Z');
  try {
    zone.setTimeZone('Asia/Tokyo');
    // 23:30Z on the 10th is the 11th in Tokyo: today there.
    const tokyo = groupOlderByTime([row(1, '2026-11-10T23:30:00Z')], (id) => id, now);
    assert.equal(tokyo[0].key, 'today');
    zone.setTimeZone('America/Los_Angeles');
    // ...and the 10th, which is today in Los Angeles too (19:00 on the 10th).
    assert.equal(groupOlderByTime([row(1, '2026-11-10T23:30:00Z')], (id) => id, now)[0].key, 'today');
    zone.setTimeZone('Europe/London');
    assert.equal(groupOlderByTime([row(1, '2026-11-10T23:30:00Z')], (id) => id, now)[0].key, 'yesterday');
    // The All tab's Today / Earlier split reads the same days.
    zone.setTimeZone('Asia/Tokyo');
    const item = { at: Date.parse('2026-11-10T23:30:00Z') };
    assert.equal(splitToday([item], now).today.length, 1, 'Today in Tokyo');
    zone.setTimeZone('Europe/London');
    assert.equal(splitToday([item], now).earlier.length, 1, 'Earlier in London');
  } finally {
    zone.setTimeZone(null);
  }
});
