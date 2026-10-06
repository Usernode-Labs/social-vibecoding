'use strict';

// A first-session sketch's dates are real dates (src/services/sketch-dates.js).
//
// Production, 5 October 2026: "Our little book club ... (we meet the last
// Thursday of each month at 7pm)" was sketched with its next meetup on
// "thursday, 31 october", "Due: 31 Oct" and "26 days to go". 31 October 2026
// is a Saturday; the last Thursday is the 29th. PAGE_TURNERS below is the
// markup that sketch committed (design/sketch.html), cut to its dated parts.
//
// What is pinned:
//   1. Today is the creator's date in their own time zone, said with its
//      zone, and the prompt's calendar lists each weekday's dates.
//   2. The reply is held to the calendar: a weekday and a date that disagree
//      agree afterwards, the same date moves everywhere with its countdown,
//      and which half is kept follows the creator's own words.
//   3. Only words that read as dates change, and markup never does.
//
// Run with: node --test tests/sketch-dates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const dates = require('../src/services/sketch-dates');

const BRIEF = 'Our little book club. Shows what we\'re reading this month, who\'s hosting the next meetup and a countdown to it (we meet the last Thursday of each month at 7pm). Everyone can suggest the next book.';
const MONDAY_5_OCT = dates.localToday(new Date('2026-10-05T09:00:00Z'), 'Europe/London');

const PAGE_TURNERS = `<section class="px-4 py-6">
  <p class="section-label text-muted font-medium mb-3">This month's read</p>
  <div class="card bg-raised rounded-lg p-4 border border-line">
    <h2 class="text-heading font-semibold text-fg">The Midnight Library</h2>
    <p class="text-small text-muted mt-3">Due: 31 Oct</p>
  </div>
</section>
<section class="px-4 py-6 border-t border-line">
  <p class="section-label text-muted font-medium mb-3">Next meetup</p>
  <div class="card bg-raised rounded-lg p-4 border border-line">
    <div class="flex items-start justify-between mb-4">
      <div>
        <p class="text-small text-muted">hosting</p>
        <p class="text-heading font-semibold text-fg mt-1">Member 2</p>
      </div>
      <div class="text-right">
        <p class="text-small text-muted">thursday, 31 october</p>
        <p class="text-heading font-semibold text-fg mt-1">7:00 pm</p>
      </div>
    </div>
    <p class="text-small text-accent font-semibold mt-2">26 days to go</p>
  </div>
</section>`;

const check = (html, opts = {}) => dates.checkSketchDates(html, { today: MONDAY_5_OCT, brief: BRIEF, ...opts });
const tagsOf = (html) => html.match(/<[^>]*>/g);

// ── 1. Today and the calendar ────────────────────────────────────────────

test('today is the creator\'s date where they are, with its weekday and zone; UTC when the zone is unknown', () => {
  // 23:30 UTC on Sunday 4 October is already Monday in London, still Sunday in Los Angeles.
  const late = new Date('2026-10-04T23:30:00Z');
  assert.deepEqual(dates.localToday(late, 'Europe/London'),
    { year: 2026, month: 10, day: 5, weekday: 1, zone: 'Europe/London' });
  assert.deepEqual(dates.localToday(late, 'America/Los_Angeles'),
    { year: 2026, month: 10, day: 4, weekday: 0, zone: 'America/Los_Angeles' });
  assert.equal(dates.todayLine(late, 'Europe/London'), 'Monday 5 October 2026 (2026-10-05), Europe/London');
  assert.equal(dates.todayLine(late), 'Sunday 4 October 2026 (2026-10-04), UTC');
  assert.equal(dates.todayLine(late, 'Not/AZone'), 'Sunday 4 October 2026 (2026-10-04), UTC', 'an unknown zone is UTC');
  assert.equal(dates.todayLine(late, '../../etc'), 'Sunday 4 October 2026 (2026-10-04), UTC');
  assert.match(dates.todayLine('not a date'), /^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} \(\d{4}-\d{2}-\d{2}\), UTC$/, 'a bad date is now');
  assert.match(dates.todayLine(null), /, UTC$/);
});

test('the calendar lists each weekday\'s dates for this month and the next two, across a new year', () => {
  const [october, november, december] = dates.calendarLines(MONDAY_5_OCT);
  assert.match(october, /^October 2026: Mondays 5, 12, 19, 26; /);
  // The meetup rule, read off: the last Thursday is the 29th, and the 31st is a Saturday.
  assert.match(october, /; Thursdays 1, 8, 15, 22, 29; /);
  assert.match(october, /; Saturdays 3, 10, 17, 24, 31; /);
  assert.match(october, /; Sundays 4, 11, 18, 25$/);
  assert.match(november, /^November 2026: .*Thursdays 5, 12, 19, 26;/);
  assert.match(december, /^December 2026: .*Thursdays 3, 10, 17, 24, 31;/);
  const wrap = dates.calendarLines({ year: 2026, month: 12, day: 20 });
  assert.deepEqual(wrap.map((l) => l.split(':')[0]), ['December 2026', 'January 2027', 'February 2027']);
  assert.match(wrap[2], /Mondays 1, 8, 15, 22; /, 'February 2027 has 28 days');
});

// ── 2. The reply is held to the calendar ─────────────────────────────────

test('the book club: the last Thursday is the 29th, everywhere it is shown, and so is its countdown', () => {
  const out = check(PAGE_TURNERS);
  assert.match(out, /<p class="text-small text-muted">Thursday, 29 October<\/p>/);
  assert.match(out, /<p class="text-small text-muted mt-3">Due: 29 Oct<\/p>/, 'the same date without its weekday');
  assert.match(out, /<p class="text-small text-accent font-semibold mt-2">24 days to go<\/p>/, 'the count of days to it');
  assert.doesNotMatch(out, /31|26 days/);
  assert.match(out, /7:00 pm/, 'a time is not a date');
  assert.deepEqual(tagsOf(out), tagsOf(PAGE_TURNERS), 'no tag changes');
  // The same sketch drawn on another day is held to that day's calendar.
  const lateOctober = dates.localToday(new Date('2026-10-30T09:00:00Z'), 'Europe/London');
  assert.match(check('<p>Next: Thursday 26 November</p>', { today: lateOctober }), /Thursday 26 November/);
});

test('without the weekday in the creator\'s words, the date is kept and its weekday corrected', () => {
  const brief = 'A countdown to our trip to the coast. Shows the packing list and who drives.';
  const out = check('<p>Leaving thursday, 31 october</p><p>26 days to go</p>', { brief });
  assert.equal(out, '<p>Leaving Saturday, 31 October</p><p>26 days to go</p>');
  // Short weekdays stay short; all caps stays all caps.
  assert.equal(check('<p>Fri 10 Oct</p>', { brief }), '<p>Sat 10 Oct</p>');
  assert.equal(check('<p>FRI 10 OCT</p>', { brief }), '<p>SAT 10 OCT</p>');
});

test('a date the creator named is kept even when they also named a weekday', () => {
  const brief = 'We meet on Thursdays, and the trip is on 31 October.';
  assert.equal(check('<p>Trip: Thursday 31 October</p>', { brief }), '<p>Trip: Saturday 31 October</p>');
  assert.equal(check('<p>Trip: Thursday 31 October</p>', { brief: 'We meet on Thursdays. The trip is Oct 31st.' }),
    '<p>Trip: Saturday 31 October</p>');
});

test('month-first dates, ordinals and a weekday split from its date by markup are read too', () => {
  assert.equal(check('<p>Thu, Oct 31st</p>'), '<p>Thu, Oct 29th</p>');
  assert.equal(check('<p>Thursday, October 31, 2026</p>'), '<p>Thursday, October 29, 2026</p>');
  assert.equal(check('<p>Thursday the 31st of October</p>'), '<p>Thursday the 29th of October</p>');
  assert.equal(check('<p class="text-muted">Thursday</p><p class="text-title">31 October</p>'),
    '<p class="text-muted">Thursday</p><p class="text-title">29 October</p>');
  assert.equal(check('<div><p class="text-title tabular-nums">26</p><p>days to go</p></div><p>Thursday 31 Oct</p>'),
    '<div><p class="text-title tabular-nums">24</p><p>days to go</p></div><p>Thursday 29 Oct</p>', 'a count split from its unit');
});

test('a moved date stays ahead when it was ahead, stays in its month, and a day the month lacks moves', () => {
  const sundays = 'Our Sunday run club. We run on Sundays at 8.';
  // 7 October 2026 is a Wednesday. Sunday the 4th is nearer but gone; the 11th is next.
  assert.equal(check('<p>Next run: Sunday 7 Oct</p>', { brief: sundays }), '<p>Next run: Sunday 11 Oct</p>');
  // A past date may move into the past.
  assert.equal(check('<p>Last run: Sunday 2 Oct</p>', { brief: sundays }), '<p>Last run: Sunday 4 Oct</p>');
  // "1 November" is a Sunday in 2026; the first Friday is the 6th, not 30 October.
  assert.equal(check('<p>Friday 1 November</p>', { brief: 'Film night on the first Friday of the month.' }),
    '<p>Friday 6 November</p>');
  // There is no 31 November: the nearest Thursday in it is the 26th, whatever the words.
  assert.equal(check('<p>Thursday 31 November</p>', { brief: 'Our book club.' }), '<p>Thursday 26 November</p>');
});

test('right dates are left right, capitalised; an explicit year is read; a date across the new year is next year\'s', () => {
  assert.equal(check('<p>thursday 29 october</p>'), '<p>Thursday 29 October</p>');
  assert.equal(check('<p>Thursday 29 Oct</p><p>Due: 29 Oct</p><p>24 days to go</p>'),
    '<p>Thursday 29 Oct</p><p>Due: 29 Oct</p><p>24 days to go</p>');
  // 31 October 2024 was a Thursday: with its year, it is right.
  assert.equal(check('<p>Thursday 31 October 2024</p>'), '<p>Thursday 31 October 2024</p>');
  const december = dates.localToday(new Date('2026-12-20T12:00:00Z'));
  assert.equal(check('<p>Monday 4 January</p>', { today: december }), '<p>Monday 4 January</p>', '4 January 2027 is a Monday');
  assert.equal(check('<p>Sunday 4 January</p>', { today: december, brief: 'Bin rota' }), '<p>Monday 4 January</p>');
});

test('two weekdays for one date leave its other mentions alone; a countdown of something else is not touched', () => {
  const both = check('<p>Thursday 31 Oct</p><p>Saturday 31 Oct</p><p>Due: 31 Oct</p>');
  assert.equal(both, '<p>Thursday 29 Oct</p><p>Saturday 31 Oct</p><p>Due: 31 Oct</p>');
  // Nothing moved, so no count changes.
  assert.equal(check('<p>Saturday 31 Oct</p><p>26 days to go</p><p>A 26 day streak</p>'),
    '<p>Saturday 31 Oct</p><p>26 days to go</p><p>A 26 day streak</p>');
  // Only the moved date's own count changes.
  assert.equal(check('<p>Thursday 31 Oct</p><p>26 days to go</p><p>12 days left to vote</p>'),
    '<p>Thursday 29 Oct</p><p>24 days to go</p><p>12 days left to vote</p>');
});

// ── 3. Only dates, only text ─────────────────────────────────────────────

test('words that are not dates stay as they are, and markup is never changed', () => {
  for (const html of [
    '<p>We may 2x the miles</p>',
    '<p>we march 3 miles on Sunday afternoons</p>',
    '<p>5.2 miles, 7:00 pm, Room 31</p>',
    '<p>Sat with friends for 3 hours</p>',
    '<p>Version 10 Oct-ober</p>',
    '<p title="thursday, 31 october">Hi</p>',
    '<input class="field" placeholder="thursday 31 october">',
  ]) {
    assert.equal(check(html), html, html);
  }
  // A weekday or month standing alone, in full, is capitalised; "may" and "march" never are.
  assert.equal(check('<p>every thursday, and the first sunday in october</p>'),
    '<p>every Thursday, and the first Sunday in October</p>');
  assert.equal(check('<p>meet on thursdays in may and march</p>'), '<p>meet on Thursdays in may and march</p>');
  assert.equal(check(''), '');
  assert.equal(check(null), '');
});

test('the check never throws on what a sanitized sketch can hold', () => {
  for (const html of ['<', '<p>', 'Thursday', 'Thursday 0 October', 'Thursday 99 October', '31 Oct 31 Oct 31 Oct',
    '<p>Thursday&amp;31 October</p>', 'Thursday, 31 octobers', '<p>Thursday 31 October 99999</p>']) {
    assert.equal(typeof check(html), 'string', html);
  }
  assert.equal(check('<p>Thursday 0 October</p>'), '<p>Thursday 0 October</p>', 'no day 0');
});
