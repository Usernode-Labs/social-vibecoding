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
// The rule lives twice, because the two transcripts sit on opposite sides of
// the bundle boundary: `frontend/src/lib/timestamp.ts` serves the React
// surfaces, and `GroupChat._stamp` in `public/js/group-chat.js` serves the
// app chat's view model — a legacy IIFE that cannot import from the bundle.
// Copies drift, so this file does not pin them by grep. It EXECUTES both
// against one table and asserts they answer identically: the frontend copy
// through the esbuild loader the render tests already use, the legacy copy by
// lifting the method out of its object literal into a callable function.
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

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── the two implementations ────────────────────────────────────────

const { messageStamp } = loadTsx('frontend/src/lib/timestamp.ts');

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
