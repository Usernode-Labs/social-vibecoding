'use strict';

/**
 * A sketch's dates are real dates (services/app-sketch.js). The sketch is a
 * featured card of the idea now, and its lines are checked the same way: a
 * line of text is markup with no tags.
 *
 * Production, 5 October 2026. "Our little book club ... (we meet the last
 * Thursday of each month at 7pm)" was sketched with its next meetup on
 * "thursday, 31 october", "Due: 31 Oct" and "26 days to go". 31 October 2026
 * is a Saturday; the last Thursday is the 29th, 24 days away. The model had
 * been told today's date and still did the calendar sum wrong (31 October was
 * a Thursday in 2024). The app the bot built later had it right, because it
 * reads the date when it runs.
 *
 * Two halves, and the second does not rely on the first:
 *
 *   THE PROMPT CARRIES A CALENDAR. Today is the date where the creator is
 *   (their device's time zone, sent with Make it; UTC when it is not known),
 *   and under it, for this month and the next two, each weekday's dates
 *   ("Thursdays 1, 8, 15, 22, 29"). "The last Thursday" is read off, not
 *   worked out.
 *
 *   THE REPLY IS CHECKED (checkSketchDates). Whatever comes back, every date
 *   shown with a weekday is held to the real calendar:
 *     - A weekday and a date that disagree are made to agree. When the
 *       creator's description names that weekday ("we meet on Thursdays")
 *       and not that date, the weekday is what they said, so the date moves:
 *       to the nearest such weekday in the same month, and not into the past
 *       if it was ahead. Otherwise the date is what is kept, and its weekday
 *       is corrected.
 *     - A date that moved moves everywhere it is shown: the same date without
 *       a weekday ("Due: 31 Oct"), and a count of the days to it ("26 days to
 *       go") when the count was the old date's.
 *     - Weekday and month names are capitalised ("thursday, 31 october").
 *   Only the words between tags change, and only words it reads as a date.
 *   Pure and synchronous, so the sketch is no slower for it.
 */

const { canonicalZone, wallClock } = require('./preview-clock');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const DAY_MS = 24 * 60 * 60 * 1000;

// The words a date is written with, in lower case, to their numbers.
const WEEKDAY_WORDS = Object.freeze({
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
});
const MONTH_WORDS = Object.freeze({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});
// Month words that are also everyday words ("you may", "we march"): read as
// a month only beside a weekday, or when that date already moved.
const EVERYDAY_MONTHS = new Set(['may', 'march', 'mar']);

// A tag, in the text the patterns read: one character no word contains, so a
// date split across elements ("<p>Thursday</p><p>31 October</p>") still
// reads as one, and no token ever spans two pieces of text.
const TAG = '\u0001';
const GAP = `[\\s${TAG}]+`;
const LIST_GAP = `[\\s,${TAG}]+`;

// Longest first, so "thursday" is never read as "thu" and some letters.
const alternation = (words) => Object.keys(words).sort((a, b) => b.length - a.length).join('|');
const WD = `(${alternation(WEEKDAY_WORDS)})\\.?`;
const MO = `(${alternation(MONTH_WORDS)})(?![a-z])\\.?`;
const DAY = '(\\d{1,2})(st|nd|rd|th)?';
const YEAR = `(?:,?${GAP}(\\d{4})\\b)?`;
const DAY_END = '(?![\\d:a-z])';

// "Thursday, 31 October", "Thu 31st of Oct 2026"
//   groups: 1 weekday, 2 day, 3 suffix, 4 month, 5 year
const PAIR_DAY_FIRST = new RegExp(`\\b${WD}${LIST_GAP}(?:the${GAP})?${DAY}(?:${GAP}of)?${GAP}${MO}${YEAR}`, 'gid');
// "Thursday, October 31", "Thu Oct 31st, 2026"
//   groups: 1 weekday, 2 month, 3 day, 4 suffix, 5 year
const PAIR_MONTH_FIRST = new RegExp(`\\b${WD}${LIST_GAP}${MO}${GAP}(?:the${GAP})?${DAY}${DAY_END}${YEAR}`, 'gid');
// "31 Oct", "31st of October 2026"
//   groups: 1 day, 2 suffix, 3 month, 4 year
const BARE_DAY_FIRST = new RegExp(`(?<![\\d:/.])\\b${DAY}(?:${GAP}of)?${GAP}${MO}${YEAR}`, 'gid');
// "Oct 31", "October 31st, 2026"
//   groups: 1 month, 2 day, 3 suffix, 4 year
const BARE_MONTH_FIRST = new RegExp(`\\b${MO}${GAP}(?:the${GAP})?${DAY}${DAY_END}${YEAR}`, 'gid');
// "26 days to go", "in 26 days", "<p>26</p><p>days</p>"
//   groups: 1 count, 2 unit
const COUNTDOWN = new RegExp(`(?<![\\d.,:/])\\b(\\d{1,3})[\\s${TAG}]*(days?)(?![a-z])`, 'gid');
// A weekday or a month standing alone, in full: always capitalised in English.
const FULL_WEEKDAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?=s?\b)/gid;
const FULL_MONTH = /\b(january|february|april|june|july|september|october|november|december)\b/gid;

// ── The calendar ─────────────────────────────────────────────────────────

function dayNumber(year, month, day) {
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Today's date where the creator is: { year, month (1-12), day, weekday
 * (0 is Sunday), zone }. `zone` is an IANA name from their device; without a
 * usable one it is the date in UTC, and `zone` says 'UTC'. A bad `now` is now.
 */
function localToday(now = new Date(), zone = null) {
  const t = now == null ? NaN : new Date(now).getTime();
  const ms = Number.isFinite(t) ? t : Date.now();
  const named = canonicalZone(zone);
  let year;
  let month;
  let day;
  if (named) {
    ({ year, month, day } = wallClock(ms, named));
  } else {
    const d = new Date(ms);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  return { year, month, day, weekday: weekdayOf(year, month, day), zone: named || 'UTC' };
}

function isoDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "Monday 5 October 2026 (2026-10-05), Europe/London": today, as the sketch is told it. */
function todayLine(now = new Date(), zone = null) {
  const today = localToday(now, zone);
  return `${WEEKDAYS[today.weekday]} ${today.day} ${MONTHS[today.month - 1]} ${today.year} (${isoDate(today)}), ${today.zone}`;
}

/**
 * Each weekday's dates in this month and the next ones, a line a month:
 * "October 2026: Mondays 5, 12, 19, 26; ...; Sundays 4, 11, 18, 25".
 */
function calendarLines(today, months = 3) {
  const lines = [];
  for (let i = 0; i < months; i += 1) {
    const year = today.year + Math.floor((today.month - 1 + i) / 12);
    const month = ((today.month - 1 + i) % 12) + 1;
    const last = daysInMonth(year, month);
    const weeks = [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
      const days = [];
      for (let d = 1; d <= last; d += 1) if (weekdayOf(year, month, d) === weekday) days.push(d);
      return `${WEEKDAYS[weekday]}s ${days.join(', ')}`;
    });
    lines.push(`${MONTHS[month - 1]} ${year}: ${weeks.join('; ')}`);
  }
  return lines;
}

// ── Reading the reply ────────────────────────────────────────────────────

function todayOf(today) {
  if (today && Number.isInteger(today.year) && Number.isInteger(today.month) && Number.isInteger(today.day)) {
    return today;
  }
  return localToday(today instanceof Date || typeof today === 'string' ? today : new Date());
}

/** The year a date without one most likely means: the one nearest today. */
function nearestYear(month, day, today) {
  const t = dayNumber(today.year, today.month, today.day);
  let best = today.year;
  let bestDistance = Infinity;
  for (const year of [today.year - 1, today.year, today.year + 1]) {
    const distance = Math.abs(dayNumber(year, month, Math.min(day, daysInMonth(year, month))) - t);
    if (distance < bestDistance) {
      best = year;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The day of `month` that falls on `weekday` nearest to `day`; not before
 * today when `day` itself was not (a next meetup stays ahead).
 */
function nearestWeekdayInMonth({ year, month, day, weekday, todayNumber }) {
  const last = daysInMonth(year, month);
  const all = [];
  for (let d = 1; d <= last; d += 1) if (weekdayOf(year, month, d) === weekday) all.push(d);
  const wasAhead = dayNumber(year, month, Math.min(day, last)) >= todayNumber;
  const ahead = wasAhead ? all.filter((d) => dayNumber(year, month, d) >= todayNumber) : [];
  const pool = ahead.length ? ahead : all;
  return pool.reduce((best, d) => (Math.abs(d - day) < Math.abs(best - day) ? d : best));
}

function monthPattern(month) {
  return Object.keys(MONTH_WORDS).filter((w) => MONTH_WORDS[w] === month).join('|');
}

/** Whether the creator's own words name this date ("31 October", "Oct 31st"). */
function briefNamesDate(brief, month, day) {
  const names = monthPattern(month);
  const re = new RegExp(`\\b0?${day}(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?:${names})\\b`
    + `|\\b(?:${names})\\.?\\s+(?:the\\s+)?0?${day}(?:st|nd|rd|th)?(?![\\d:a-z])`, 'i');
  return re.test(String(brief || ''));
}

/** Whether the creator's own words name this weekday ("Thursday", "Thursdays", "Thurs"). */
function briefNamesWeekday(brief, weekday) {
  const words = Object.keys(WEEKDAY_WORDS)
    .filter((w) => WEEKDAY_WORDS[w] === weekday && w.length >= 4);
  return new RegExp(`\\b(?:${words.join('|')})s?\\b`, 'i').test(String(brief || ''));
}

function capitalised(word) {
  return word && word === word.toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word;
}

/** A weekday written as `original` was: in full or short, in its case; capitalised. */
function weekdayWord(original, weekday) {
  if (WEEKDAY_WORDS[original.toLowerCase()] === weekday) return capitalised(original);
  const full = WEEKDAYS.some((w) => w.toLowerCase() === original.toLowerCase());
  const word = full ? WEEKDAYS[weekday] : WEEKDAYS[weekday].slice(0, 3);
  return original.length > 1 && original === original.toUpperCase() ? word.toUpperCase() : word;
}

function ordinal(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
}

function dayDigits(original, day) {
  return original.length === 2 && original[0] === '0' ? String(day).padStart(2, '0') : String(day);
}

function sameCase(original, word) {
  if (original.length > 1 && original === original.toUpperCase()) return word.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/**
 * The sketch's markup with its dates made true to the calendar (see the
 * header). `today` is localToday()'s answer (or a Date, read in UTC); `brief`
 * is the creator's description. Text only: tags pass through untouched.
 * Never throws on markup it cannot read; it leaves that as it is.
 */
function checkSketchDates(html, { today = null, brief = '' } = {}) {
  const source = String(html || '');
  if (!source) return source;
  const now = todayOf(today);
  const todayNumber = dayNumber(now.year, now.month, now.day);

  // The text with each tag as TAG, and where each piece of text sits in it.
  const parts = source.split(/(<[^>]*>)/);
  let text = '';
  const pieces = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      text += TAG;
      return;
    }
    pieces.push({ index, start: text.length, end: text.length + part.length });
    text += part;
  });

  const edits = [];
  const claimed = [];
  const overlaps = (start, end) => claimed.some(([a, b]) => start < b && a < end);
  const edit = ([start, end], next) => {
    if (next != null && text.slice(start, end) !== next) edits.push({ start, end, next });
  };
  // Every date shown with a weekday, by "y-m-d": the day it is shown on now,
  // or null when two of them disagree about it.
  const shown = new Map();

  const readPairs = (re, at) => {
    for (const m of text.matchAll(re)) {
      const span = m.indices[0];
      if (overlaps(span[0], span[1])) continue;
      const day = Number(m[at.day]);
      const month = MONTH_WORDS[m[at.month].toLowerCase()];
      if (!(day >= 1 && day <= 31) || !month) continue;
      claimed.push(span);
      const weekday = WEEKDAY_WORDS[m[at.weekday].toLowerCase()];
      const year = m[at.year] ? Number(m[at.year]) : nearestYear(month, day, now);
      const last = daysInMonth(year, month);
      let showDay = day;
      let showWeekday = weekday;
      if (day > last || weekdayOf(year, month, day) !== weekday) {
        const keepWeekday = day > last
          || (!briefNamesDate(brief, month, day) && briefNamesWeekday(brief, weekday));
        if (keepWeekday) showDay = nearestWeekdayInMonth({ year, month, day, weekday, todayNumber });
        else showWeekday = weekdayOf(year, month, day);
      }
      const key = `${year}-${month}-${day}`;
      shown.set(key, shown.has(key) && shown.get(key) !== showDay ? null : showDay);
      edit(m.indices[at.weekday], weekdayWord(m[at.weekday], showWeekday));
      edit(m.indices[at.day], dayDigits(m[at.day], showDay));
      if (m[at.suffix]) edit(m.indices[at.suffix], sameCase(m[at.suffix], ordinal(showDay)));
      edit(m.indices[at.month], capitalised(m[at.month]));
    }
  };
  readPairs(PAIR_DAY_FIRST, { weekday: 1, day: 2, suffix: 3, month: 4, year: 5 });
  readPairs(PAIR_MONTH_FIRST, { weekday: 1, month: 2, day: 3, suffix: 4, year: 5 });

  const readBare = (re, at) => {
    for (const m of text.matchAll(re)) {
      const span = m.indices[0];
      if (overlaps(span[0], span[1])) continue;
      const day = Number(m[at.day]);
      const monthWord = m[at.month].toLowerCase();
      const month = MONTH_WORDS[monthWord];
      if (!(day >= 1 && day <= 31) || !month) continue;
      const year = m[at.year] ? Number(m[at.year]) : nearestYear(month, day, now);
      const moved = shown.get(`${year}-${month}-${day}`);
      const isMoved = moved != null && moved !== day;
      if (EVERYDAY_MONTHS.has(monthWord) && !isMoved) continue;
      claimed.push(span);
      if (isMoved) {
        edit(m.indices[at.day], dayDigits(m[at.day], moved));
        if (m[at.suffix]) edit(m.indices[at.suffix], sameCase(m[at.suffix], ordinal(moved)));
      }
      edit(m.indices[at.month], capitalised(m[at.month]));
    }
  };
  readBare(BARE_DAY_FIRST, { day: 1, suffix: 2, month: 3, year: 4 });
  readBare(BARE_MONTH_FIRST, { month: 1, day: 2, suffix: 3, year: 4 });

  // A count of days to a date that moved: the old count becomes the new one.
  const recount = new Map();
  for (const [key, showDay] of shown) {
    const [year, month, day] = key.split('-').map(Number);
    if (showDay == null || showDay === day) continue;
    const from = dayNumber(year, month, day) - todayNumber;
    const to = dayNumber(year, month, showDay) - todayNumber;
    if (from < 1 || to < 0) continue;
    recount.set(from, recount.has(from) && recount.get(from) !== to ? null : to);
  }
  if (recount.size) {
    for (const m of text.matchAll(COUNTDOWN)) {
      const span = m.indices[0];
      if (overlaps(span[0], span[1])) continue;
      const to = recount.get(Number(m[1]));
      if (to == null) continue;
      claimed.push(span);
      edit(m.indices[1], String(to));
      edit(m.indices[2], sameCase(m[2], to === 1 ? 'day' : 'days'));
    }
  }

  for (const re of [FULL_WEEKDAY, FULL_MONTH]) {
    for (const m of text.matchAll(re)) {
      const span = m.indices[1];
      if (overlaps(span[0], span[1])) continue;
      edit(span, capitalised(m[1]));
    }
  }

  if (!edits.length) return source;
  for (const piece of pieces) {
    const inside = edits
      .filter((e) => e.start >= piece.start && e.end <= piece.end)
      .sort((a, b) => b.start - a.start);
    let part = parts[piece.index];
    for (const e of inside) {
      part = part.slice(0, e.start - piece.start) + e.next + part.slice(e.end - piece.start);
    }
    parts[piece.index] = part;
  }
  return parts.join('');
}

module.exports = {
  WEEKDAYS,
  MONTHS,
  localToday,
  todayLine,
  calendarLines,
  checkSketchDates,
  weekdayOf,
};
