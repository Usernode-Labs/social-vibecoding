// Allowance resets are worded in the viewer's own clock (#3230).
//
// The server keeps its allowances on UTC boundaries (weekly credits and
// kudos on Monday 00:00 UTC, the shared daily budget at midnight UTC), and
// the copy used to say exactly that. frontend/src/lib/reset-time.ts names
// the local moment instead and keeps the UTC instant for `title`. This file
// executes it under fixed time zones, and checks that the credit sentence
// every surface shares goes through it.
//
// Run with: node --test tests/reset-time.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RT = loadTsx('frontend/src/lib/reset-time.ts');
const CO = require('../public/js/credit-options.js');

// ICU may put a narrow no-break space before AM/PM; compare words, not bytes.
const norm = (s) => String(s).replace(/\s/g, ' ');

// Wednesday 30 Sep 2026, 15:00 UTC.
const WED = Date.parse('2026-09-30T15:00:00Z');
const OPTS = { now: WED, locale: 'en-US' };

function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
}

test('nextReset: the next Monday 00:00 UTC, strictly after now', () => {
  const iso = (ms, c = 'weekly') => RT.nextReset(c, Date.parse(ms)).toISOString();
  assert.equal(iso('2026-09-30T15:00:00Z'), '2026-10-05T00:00:00.000Z', 'midweek');
  assert.equal(iso('2026-10-04T23:59:59Z'), '2026-10-05T00:00:00.000Z', 'last second of Sunday');
  assert.equal(iso('2026-10-05T00:00:00Z'), '2026-10-12T00:00:00.000Z',
    'on the boundary itself, the reset has just happened: the next is a week out');
  assert.equal(iso('2026-12-30T12:00:00Z'), '2027-01-04T00:00:00.000Z', 'across a year');
});

test('nextReset: the next 00:00 UTC for the daily window', () => {
  assert.equal(RT.nextReset('daily', WED).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(RT.nextReset('daily', Date.parse('2026-12-31T23:30:00Z')).toISOString(),
    '2027-01-01T00:00:00.000Z');
});

test('resetWhen names the local moment: New York', () => {
  inZone('America/New_York', () => {
    // Monday 00:00 UTC is Sunday 8 PM in New York (EDT).
    assert.equal(norm(RT.resetWhen('weekly', OPTS)), 'Sunday at 8:00 PM');
    assert.equal(norm(RT.resetWhen('daily', OPTS)), 'at 8:00 PM');
  });
});

test('resetWhen names the local moment: Tokyo', () => {
  inZone('Asia/Tokyo', () => {
    assert.equal(norm(RT.resetWhen('weekly', OPTS)), 'Monday at 9:00 AM');
    assert.equal(norm(RT.resetWhen('daily', OPTS)), 'at 9:00 AM');
  });
});

test('the server instant wins over the computed one', () => {
  inZone('Asia/Tokyo', () => {
    const at = '2026-10-12T00:00:00.000Z';
    assert.equal(norm(RT.resetWhen('weekly', { ...OPTS, at })), 'Monday at 9:00 AM');
    assert.equal(norm(RT.resetUtc('weekly', { ...OPTS, at })), 'Mon, Oct 12, 00:00 UTC');
    assert.equal(norm(RT.resetUtc('weekly', { ...OPTS, at: 'not a date' })), 'Mon, Oct 5, 00:00 UTC',
      'an unreadable instant falls back to the computed boundary');
  });
});

test('resetUtc is the exact UTC instant, whatever the zone', () => {
  for (const tz of ['America/New_York', 'Asia/Tokyo']) {
    inZone(tz, () => {
      assert.equal(norm(RT.resetUtc('weekly', OPTS)), 'Mon, Oct 5, 00:00 UTC', tz);
      assert.equal(norm(RT.resetUtc('daily', OPTS)), 'Thu, Oct 1, 00:00 UTC', tz);
    });
  }
});

test('localizeResetText rewrites the server spellings and nothing else', () => {
  inZone('America/New_York', () => {
    const l = (t) => norm(RT.localizeResetText(t, OPTS));
    assert.equal(l('Weekly limit reached ($50.00). Resets Monday 00:00 UTC.'),
      'Weekly limit reached ($50.00). Resets Sunday at 8:00 PM.');
    assert.equal(l('Daily limit reached ($20.00). Resets at midnight UTC.'),
      'Daily limit reached ($20.00). Resets at 8:00 PM.');
    assert.equal(l('It resumes after the midnight UTC reset.'),
      'It resumes after the daily reset at 8:00 PM.');
    assert.equal(l('Nothing to do here.'), 'Nothing to do here.');
  });
});

test('the shared credit sentence goes through it, with the UTC instant for title', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { ResetTime: RT };
  try {
    inZone('America/New_York', () => {
      const at = '2026-10-05T00:00:00.000Z';
      const now = Date.parse(at) - 3 * 3600 * 1000;
      const weekly = { capWindow: 'weekly', resetsAt: at };
      assert.equal(norm(CO.resetSentence(weekly, now)),
        'Free credits reset Sunday at 8:00 PM, about 3h from now.');
      assert.equal(norm(CO.resetTitle(weekly, now)), 'Mon, Oct 5, 00:00 UTC');
      assert.equal(CO.resetTitle({ level: 'locked' }), null, 'no reset to name when locked');
      const card = norm(CO.cardHtml({ error: 'Weekly limit reached ($50.00). Resets Monday 00:00 UTC.' }));
      assert.doesNotMatch(card, /00:00 UTC/, 'the card rewords the server sentence too');
    });
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
});

test('no user-visible copy still spells the reset in UTC alone', () => {
  // Each of these used to print "Monday 00:00 UTC" or "midnight UTC"
  // straight to the reader. They may keep it as the fallback for a sandbox
  // without ResetTime, but each must now reach for ResetTime first.
  for (const rel of [
    'frontend/src/features/leaderboard/kudos.js',
    'frontend/src/features/leaderboard/leaderboard.js',
    'frontend/src/features/dialogs/feedback-controller.js',
    'frontend/src/features/header/ai-credit.js',
    'frontend/src/features/dev-chat/dev-chat.js',
    'frontend/src/features/settings/settings.js',
    'public/js/credit-options.js',
    'public/js/build-venues.js',
    'public/js/merge-status.js',
    'public/js/app-view.js',
  ]) {
    assert.match(read(rel), /ResetTime/, `${rel} words the reset in local time`);
  }
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/reset-time';/,
    'the bundle publishes window.ResetTime for the classic scripts');
  assert.match(read('frontend/src/features/settings/sections/usage.tsx'), /id="settings-spend-reset"/,
    'the spend card names its reset line so Settings can localize it');
});
