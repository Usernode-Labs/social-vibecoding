'use strict';

// A staging preview shown as of a chosen moment.
//
// Some changes only show at certain times: a reminder the evening before bins
// day, a rota that turns over on Monday, a deadline, "tonight". A preview
// opens on whatever day it happens to be, so on 5 October 2026 a group was
// asked to approve a Thursday-evening banner that nobody could see: Try it
// opened on a Monday, and the shots agent said the banner "can't be made to
// appear". So a change may declare the moment it should be seen at, and the
// preview opens at that moment.
//
// THE DECLARATION. One HTML comment in the change's "==== TESTING ====" block
// (or in `testingSteps` on submit_work). Both land in chat_sessions.testing_md
// and, through pr-metadata's "How to test" section, in the pull request body,
// where an HTML comment shows to nobody:
//
//   <!-- usernode:preview-at 2026-10-08T19:00 Europe/London -->
//
// A local date and time, then the IANA time zone the app reasons in. The zone
// may be left out (UTC), and the time may carry its own offset instead
// (`2026-10-08T18:00Z`, `2026-10-08T19:00+01:00`). The first valid
// declaration wins; an invalid one is ignored, never an error.
//
// THE TRANSPORT. The platform adds `?un-now=<ISO instant>` to the preview's
// address, namespaced like `token` and `un-theme` so it cannot collide with a
// parameter an app gives meaning to. The bridge reads it into
// `usernode.now()` (public/usernode-bridge/v1/bridge.js, the clock block), the
// page sends that time on as the `x-usernode-now` header, and the app's
// server reads it into `req.now` only when USERNODE_ENV is `staging` (the
// scaffold's server.js; "Time-dependent features" in app-conventions.md).
// Production ignores it entirely: the platform never puts it on a production
// app's address, the bridge never reads it on one, and a production server
// never reads the header.
//
// Read here and nowhere else: the ensure-staging / preview-status answer
// carries `previewAt` to Try it (AppView.swapToStaging), and the shots brief
// carries it to the shots agent (shots-orchestrator.shotsBrief).

const PREVIEW_NOW_PARAM = 'un-now';
const PREVIEW_NOW_HEADER = 'x-usernode-now';

// Whitespace-tolerant, case-insensitive on the marker only. The two value
// tokens are anything but whitespace and `>`, validated below.
const DECLARATION_RE = /<!--\s*usernode:preview-at\s+([^\s>]+)(?:\s+([^\s>]+))?\s*-->/gi;
// Testing guidance is capped at 4,000 characters (testing-notes TESTING_MD_MAX);
// this bound only keeps a pathological input from being scanned at length.
const SCAN_MAX = 20_000;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/i;
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu']);

// The canonical name of an IANA zone, or null when Intl does not know it.
function canonicalZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// The wall-clock fields of instant `ms` in `zone`.
function wallClock(ms, zone) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    // Some ICU builds still write midnight as 24 under h23.
    hour: parts.hour === 24 ? 0 : parts.hour, minute: parts.minute, second: parts.second,
  };
}

// How far `zone` is ahead of UTC at instant `ms`, in milliseconds.
function zoneOffsetMs(ms, zone) {
  const w = wallClock(ms, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time in `zone` names. Two passes settle the offset
// either side of a daylight-saving change; a time that does not exist (the
// hour skipped in spring) lands an hour on, which is what a clock shows.
function instantOf(wallMs, zone) {
  let guess = wallMs - zoneOffsetMs(wallMs, zone);
  guess = wallMs - zoneOffsetMs(guess, zone);
  return guess;
}

/**
 * "Thursday 8 Oct, 7 pm": the moment in plain words, in `zone`. Minutes only
 * when there are some ("7:30 pm"). UTC says so, since it is nobody's local
 * time; a named zone is the group's own, so it says nothing more.
 */
function formatLabel(ms, zone) {
  const z = canonicalZone(zone) || 'UTC';
  const w = wallClock(ms, z);
  const weekday = WEEKDAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()];
  const hour12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const minutes = w.minute ? `:${String(w.minute).padStart(2, '0')}` : '';
  const half = w.hour < 12 ? 'am' : 'pm';
  const suffix = UTC_ZONES.has(z) ? ' UTC' : '';
  return `${weekday} ${w.day} ${MONTHS[w.month - 1]}, ${hour12}${minutes} ${half}${suffix}`;
}

function parseOffsetMinutes(token) {
  if (!token) return null;
  if (/^z$/i.test(token)) return 0;
  const m = token.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Read ONE declaration's two tokens. Returns
 *   { at, zone, local, label }
 * where `at` is the ISO instant (`2026-10-08T18:00:00.000Z`) that goes on the
 * preview's address, `zone` the canonical zone the label is written in,
 * `local` the wall-clock time as declared and `label` the plain words. Null
 * when the time, the zone or the date is not real.
 */
function parseMoment(timeToken, zoneToken) {
  const m = typeof timeToken === 'string' ? timeToken.trim().match(LOCAL_RE) : null;
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const second = m[6] ? Number(m[6]) : 0;
  if (year < YEAR_MIN || year > YEAR_MAX) return null;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // 31 February rolls into March under Date.UTC; a real date round-trips.
  const check = new Date(wallMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }

  let zone = null;
  if (zoneToken != null && zoneToken !== '') {
    zone = canonicalZone(zoneToken);
    if (!zone) return null;
  }

  const offsetToken = m[7] || null;
  let ms;
  if (offsetToken) {
    const offset = parseOffsetMinutes(offsetToken);
    if (offset == null) return null;
    ms = wallMs - offset * 60_000;
    if (!zone) zone = 'UTC';
  } else {
    if (!zone) zone = 'UTC';
    ms = instantOf(wallMs, zone);
  }
  if (!Number.isFinite(ms)) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}`;
  return { at: new Date(ms).toISOString(), zone, local, label: formatLabel(ms, zone) };
}

/** The first valid preview moment declared in `text`, or null. */
function declaredMoment(text) {
  if (typeof text !== 'string' || !text) return null;
  const scanned = text.length > SCAN_MAX ? text.slice(0, SCAN_MAX) : text;
  DECLARATION_RE.lastIndex = 0;
  for (let match; (match = DECLARATION_RE.exec(scanned)) !== null;) {
    const moment = parseMoment(match[1], match[2]);
    if (moment) return moment;
  }
  return null;
}

/** Whether a line of a TESTING block is a declaration (testing-notes keeps it). */
function isDeclarationLine(line) {
  return typeof line === 'string' && /^\s*<!--\s*usernode:preview-at\b[^>]*-->\s*$/i.test(line);
}

/** The moment a proposal's preview opens at, read off its testing guidance. */
function forSession(session) {
  return declaredMoment(session && session.testing_md);
}

/**
 * What a preview answer carries for Try it: `{ previewAt: { at, label, zone } }`,
 * or nothing at all when the change declares no moment, so every other
 * answer stays exactly as it was.
 */
function previewAnswer(session) {
  const moment = forSession(session);
  return moment ? { previewAt: { at: moment.at, label: moment.label, zone: moment.zone } } : {};
}

module.exports = {
  PREVIEW_NOW_PARAM,
  PREVIEW_NOW_HEADER,
  // Also the first session's sketch's "today where its creator is"
  // (services/sketch-dates.js).
  canonicalZone,
  wallClock,
  declaredMoment,
  parseMoment,
  formatLabel,
  isDeclarationLine,
  forSession,
  previewAnswer,
};
