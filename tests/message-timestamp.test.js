// Discussion timestamps carry their date (#1808).
//
// Every transcript stamped a bare time of day, so a row read "02:41 PM"
// whether it was posted ten minutes ago or in March. The rule now is:
//
//   today             02:41 PM
//   earlier this year Jun 16, 02:41 PM
//   an earlier year   Jun 16, 2025, 02:41 PM
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

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── the two implementations ────────────────────────────────────────

const { messageStamp, agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');

// Lift `_stamp(ts, now) { … }` out of the GroupChat object literal. Brace
// matching rather than a lazy regex: the body contains braces of its own, and
// a `.*?}` would stop at the first option object.
function legacyStamp() {
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
  return vm.runInNewContext(`(function (ts, now) {${body}})`);
}

const stampLegacy = legacyStamp();

// Lift `relStamp` out of app-view.js. A plain file-scope function, so the
// slice is simpler than `_stamp`'s method lift — but it closes over
// `REL_FLOOR_MS`, which is the whole point of the copy, so that declaration
// is evaluated with it rather than substituted for a literal here.
function legacyRelStamp() {
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
  return vm.runInNewContext(`${floor[0]}\n${src.slice(start, i + 1)}\nrelStamp;`);
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
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (expectDate) {
      assert.notEqual(text, time, `${label}: a stamp that is not today's must say so`);
      assert.ok(text.endsWith(time), `${label}: the time is still the tail of the stamp`);
      const day = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
    // The app chat renders a zero-padded hour, which is `messageStamp`'s
    // default; the DM rows ask for the unpadded one. Compared on the shared
    // default, so a difference here is a difference in the RULE.
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

test('#1808: both copies default their clock to now', () => {
  // Neither takes `now` in production; the parameter exists for this file.
  const today = new Date();
  const time = today.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
      const day = when.toLocaleDateString(undefined, when.getFullYear() === NOW.getFullYear()
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
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    assert.ok(title.includes(time), `${label}: time`);
    const day = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  assert.equal(shown.length, 2, 'the message row and the spec card both stamp a time');
  for (const tag of shown) {
    assert.match(tag, /title=\{msg\.timeTitle\}/,
      'every rendered time hangs the full stamp off title');
  }
});

test('#1808: the DM rows use the shared rule rather than a fourth copy', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /import \{ messageStamp \} from '\.\.\/\.\.\/lib\/timestamp';/);
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

test('#1808: the issue comment thread stamps a day and a time, in the reader\'s zone', () => {
  // The bug this closes was one line narrower than the rest of #1808: the
  // GitHub thread under an issue printed `createdAt.slice(0, 10)`, a UTC
  // DATE with no time at all. So a comment posted at 20:30 in Sao Paulo was
  // stamped with the next day, directly above a Discussion thread that got
  // both right. The fixture is the instant that shows it: 23:30 UTC on the
  // 16th is already the 17th anywhere east of UTC, and `slice(0, 10)` can
  // only ever say the 16th.
  const comment = {
    key: '1', author: 'evan', bot: false,
    createdAt: '2026-06-16T23:30:00Z', bodyHtml: '<p>hi</p>',
  };
  const render = () => renderComponent(
    'frontend/src/features/dev-board/issue-comments.tsx', 'IssueCommentsView',
    { comments: [comment], truncated: false, htmlUrl: null },
  );

  const before = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    const html = render();
    const stamp = html.match(/<time class="dev-feed-msg-time"[^>]*>([^<]*)<\/time>/i);
    assert.ok(stamp, 'the row renders a .dev-feed-msg-time');
    assert.ok(stamp[1].trim(), 'with text in it, not an empty element');
    assert.match(stamp[0], /title="[^"]+"/, 'and the unelided stamp on title');
    assert.match(stamp[0], /datetime="2026-06-16T23:30:00Z"/i,
      'the machine-readable instant is the raw one, unconverted');
    assert.match(stamp[1], /Jun 17/,
      `east of UTC that instant is the 17th, got ${stamp[1]}`);
    assert.match(stamp[1], /\d\d?:\d\d/, 'and it carries a time of day');
    // The regression itself: never the bare ISO date the string version cut.
    assert.doesNotMatch(html, /2026-06-16<\/time>/);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
