'use strict';

// Typing in a Messages conversation re-rendered the whole transcript on every
// keystroke (#3104). Measured in an emulated iPhone viewport on a
// 100-message group chat: a keystroke's event took 88ms, and 344ms with the
// CPU slowed to a low-end phone's, because
//
//   1. the composer's `setDraft` published the Messages store, which
//      re-rendered every subscriber: the thread and all of its rows;
//   2. no row was memoized, so each one rendered again;
//   3. each row's markdown body was passed as a fresh `{ __html }` object,
//      and React 19 reassigns innerHTML whenever that object is new, so
//      every body was torn down and rebuilt;
//   4. each row formatted its timestamps through `toLocale*String`, which
//      builds a new Intl.DateTimeFormat on every call.
//
// Each of the four is pinned here.
//
// Run with: node --test tests/messages-typing-cost.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('saving a draft does not publish the Messages store', () => {
  const store = read('frontend/src/features/messages/store.ts');
  const body = store.match(/export function setDraft\(scope: ComposerScope, value: string\): void \{([\s\S]*?)\n\}/);
  assert.ok(body, 'setDraft found');
  assert.doesNotMatch(body[1], /\bpublish\(/,
    'a keystroke must not re-render every subscriber; nothing reads drafts from the snapshot');
  assert.match(body[1], /drafts\.set\(scope, value\)/, 'the draft is still kept for draftFor()');
  // Drafts are read back only where the composer changes scope.
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /useEffect\(\(\) => \{\s*setValue\(draftFor\(scope\)\);/);
});

test('a message row is memoized, so an unchanged row skips the render', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /export const MessageRow = memo\(function MessageRow\(/);
  assert.match(row, /^import \{ memo, /m);
});

test('a message body keeps the same innerHTML object while its html is unchanged', () => {
  const format = read('frontend/src/features/messages/format.tsx');
  const fn = format.match(/export function MessageMarkdown\([\s\S]*?\n\}/);
  assert.ok(fn, 'MessageMarkdown found');
  assert.match(fn[0], /const inner = useMemo\(\(\) => \(\{ __html: html \}\), \[html\]\);/);
  assert.match(fn[0], /dangerouslySetInnerHTML=\{inner\}/);
  assert.doesNotMatch(fn[0], /dangerouslySetInnerHTML=\{\{/, 'no inline wrapper object');
});

test('timestamps reuse one Intl.DateTimeFormat per format, and print what toLocale*String printed', () => {
  const RealFormat = Intl.DateTimeFormat;
  let built = 0;
  // Counted from before the module loads, so a formatter built at import is seen too.
  Intl.DateTimeFormat = function DateTimeFormat(...args) { built += 1; return new RealFormat(...args); };
  Intl.DateTimeFormat.prototype = RealFormat.prototype;
  try {
    const { messageStamp, agoStamp, timeOfDay } = loadTsx('frontend/src/lib/timestamp.ts');
    const now = new Date(2026, 8, 25, 15, 0);
    const instants = [
      new Date(2026, 8, 25, 9, 5), new Date(2026, 8, 20, 14, 41), new Date(2026, 5, 16, 14, 41),
      new Date(2025, 5, 16, 14, 41), new Date(2026, 8, 25, 14, 59, 30),
    ];
    for (let round = 0; round < 50; round += 1) {
      for (const at of instants) {
        messageStamp(at, { now });
        messageStamp(at, { now, hour: 'numeric' });
        agoStamp(at, { now });
        timeOfDay(at);
      }
    }
    // toLocale*String builds its formatter natively, out of this count's
    // sight, so the floor is what shows the cached path is the one in use.
    assert.ok(built >= 1 && built <= 6,
      `built ${built} formatters for 1000 stamps; one per distinct format is the ceiling`);
    assert.doesNotMatch(read('frontend/src/lib/timestamp.ts').replace(/^\s*(\*|\/\/).*$/gm, ''), /\.toLocale\w*String\(/,
      'no uncached toLocale*String call is left in the code');

    for (const at of instants) {
      const sameDay = at.toDateString() === now.toDateString();
      const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const day = at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' });
      const full = at.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      assert.deepEqual(messageStamp(at, { now }), { text: sameDay ? time : `${day}, ${time}`, title: full });
      assert.equal(timeOfDay(at), at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    }
  } finally {
    Intl.DateTimeFormat = RealFormat;
  }
});
