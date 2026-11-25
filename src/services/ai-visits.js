'use strict';

// Homeroom mobile polish, item 05 (24 Nov 2026): the Homeroom bot tab's list
// marks what is new since your last visit, with a dot on each new row, a
// blue line under the last of them and a count in each band's heading. This
// is where "your last visit" is kept: per person, so a phone and a computer
// agree (db/migrations/ai-list-visits.sql).
//
// WHAT IS KEPT. The time a visit ended and what the list's three bands held
// then, as the page saw them: `seen` is { needs, busy, done }, each a map of
// a row's identity to where it stood ('' when only being there counts; In
// progress keeps its list and stage, `next:building`). The page compares
// what it lists now with that (frontend/src/features/ai/model.ts): a row
// that was not in its band then arrived since, and a row of In progress
// whose stage differs moved. Unread messages stay thread-reads.js's.
//
// A VISIT. The page opens one each time the tab is shown (openVisit) and
// says what it has in view while it is up and when it leaves (noteVisit).
// The marks hold for the whole visit; the next visit measures from when
// this one ended. So that a visit is what a person would call one:
//
//   - It lasts while any of the person's tabs has the list open: a second
//     device opened meanwhile shares the same last visit, and the same marks.
//   - A reload, or a phone put away and taken out again, is the same tab
//     coming back: within VISIT_GAP_MS of leaving it carries on the visit
//     (the tab keeps its token in sessionStorage), and its marks stay.
//   - A tab that stops being heard from without saying it left (a phone
//     that closed the page) has left VISIT_GAP_MS after its last word.
//   - Coming back any other way starts the next visit: the visit just left
//     becomes the last one, measured from when it ended.
//
// A first visit has nothing before it: `since` and `seen` are null until a
// visit has ended, and the page marks nothing new by this rule.
//
// A ROW OPENED stops being new at once, for the rest of the visit (24 Nov
// 2026, #7121): the page adds the row to the last visit's record
// (noteOpened), and the list is drawn from it, so its dot, its share of the
// band's count and its place above the line go. The line's time does not
// move; a reload within the visit reads the patched record and agrees.
//
//   openVisit(db, { userId, token }) → { visit, since, seen }
//   noteVisit(db, { userId, token, seen, left }) → { ok: true } | null
//   noteOpened(db, { userId, token, band, identity, standing }) → { ok: true } | null
//   parseSeen(raw)  → a cleaned `seen`, or null when it is not one
//   demoVisit(lists, now) → staging's ?demo=1 answer (routes/ai-work.js)

const crypto = require('node:crypto');

/** How long a tab may be away (a reload, a phone in a pocket) and still be the same visit. */
const VISIT_GAP_MS = 10 * 60 * 1000;
/** The bands a visit remembers, as the page names them. */
const BANDS = ['needs', 'busy', 'done'];
/**
 * Bounds on what a visit may say it saw: the page's lists, never more. The
 * lists hold up to 500 threads a kind (ai-work.js THREADS_MAX), and the
 * bytes stay under the 64 KB a leaving page's keepalive request may carry.
 */
const MAX_ENTRIES = 2000;
const MAX_KEY = 120;
const MAX_VALUE = 60;
const MAX_BYTES = 60000;
/** How many of a person's tabs are kept as having the list open. */
const MAX_TABS = 20;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
// A row's identity and where it stood: short, printable, no spaces.
const KEY = /^[A-Za-z0-9_:#.@/-]+$/;
const VALUE = /^[A-Za-z0-9_:.-]*$/;

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function cleanToken(raw) {
  return typeof raw === 'string' && TOKEN.test(raw) ? raw : null;
}

/**
 * Pure: `raw` as a visit's `seen`, or null when it is not one: an object of
 * the three bands (any may be missing), each a map of identity to standing,
 * within the bounds above. Anything else is refused whole rather than kept
 * in part, so a page never measures from half a list.
 */
function parseSeen(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let entries = 0;
  for (const name of Object.keys(raw)) {
    if (!BANDS.includes(name)) return null;
  }
  for (const name of BANDS) {
    const band = raw[name] == null ? {} : raw[name];
    if (typeof band !== 'object' || Array.isArray(band)) return null;
    const clean = {};
    for (const [key, value] of Object.entries(band)) {
      if (key.length > MAX_KEY || !KEY.test(key)) return null;
      if (typeof value !== 'string' || value.length > MAX_VALUE || !VALUE.test(value)) return null;
      clean[key] = value;
      entries += 1;
      if (entries > MAX_ENTRIES) return null;
    }
    out[name] = clean;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_BYTES) return null;
  return out;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Pure: the tabs still open at `nowMs`: each heard from within the gap, the newest MAX_TABS. */
function liveTabs(tabs, nowMs) {
  const kept = Object.entries(tabs && typeof tabs === 'object' ? tabs : {})
    .filter(([token, at]) => TOKEN.test(token) && Number.isFinite(Number(at)) && nowMs - Number(at) <= VISIT_GAP_MS)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_TABS);
  return Object.fromEntries(kept.map(([token, at]) => [token, Number(at)]));
}

/**
 * Pure: what opening the list does to a person's visit row, at `nowMs`, for
 * a tab that brings `token` (its own from before a reload, or none).
 *   'keep'    another tab still has the list open, or no visit has said
 *             what it saw yet: the last visit stays the last visit.
 *   'resume'  this same tab left a moment ago (a reload, a phone put away):
 *             the visit carries on.
 *   'promote' the visit under way has ended: it becomes the last visit.
 */
function openStep(row, token, nowMs) {
  if (!row || !row.current_seen || !row.current_at) return 'keep';
  if (Object.keys(liveTabs(row.current_tabs, nowMs)).length) return 'keep';
  const leftMs = row.left_at ? new Date(row.left_at).getTime() : NaN;
  if (token && row.left_tab === token && Number.isFinite(leftMs) && nowMs - leftMs <= VISIT_GAP_MS) return 'resume';
  return 'promote';
}

async function transaction(pool, fn) {
  if (typeof pool.connect !== 'function') return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the error above is the one to report */ }
    throw err;
  } finally {
    client.release();
  }
}

/** The person's visit row, locked for this transaction, made first if they have none. */
async function lockRow(db, userId) {
  await db.query('INSERT INTO ai_list_visits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows: [row] } = await db.query(
    `SELECT v.*, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS now_ms
       FROM ai_list_visits v WHERE v.user_id = $1 FOR UPDATE`,
    [userId]
  );
  return row;
}

/**
 * The tab is showing the list: the visit it is part of, and what to measure
 * it from. `since` is when the last visit ended and `seen` what the bands
 * held then, both null when no visit has ended yet. `visit` is the tab's
 * token: the one it brought, else a new one, to send with what it sees.
 */
async function openVisit(pool, { userId, token: raw = null } = {}) {
  if (!userId) return null;
  const token = cleanToken(raw) || newToken();
  return transaction(pool, async (db) => {
    const row = await lockRow(db, userId);
    const nowMs = Number(row.now_ms) || Date.now();
    const step = openStep(row, cleanToken(raw), nowMs);
    let since = row.last_visit_at;
    let seen = row.last_visit_seen;
    if (step === 'promote') {
      since = row.current_at;
      seen = row.current_seen;
    }
    // This tab has the list open now, so a device opened meanwhile shares
    // the visit. Its first word (noteVisit) says what it sees.
    const tabs = { ...(step === 'promote' ? {} : liveTabs(row.current_tabs, nowMs)), [token]: nowMs };
    await db.query(
      `UPDATE ai_list_visits
          SET last_visit_at = $2, last_visit_seen = $3,
              current_at = CASE WHEN $5 THEN NULL ELSE current_at END,
              current_seen = CASE WHEN $5 THEN NULL ELSE current_seen END,
              current_tabs = $4,
              left_tab = CASE WHEN $5 OR $6 THEN NULL ELSE left_tab END,
              left_at = CASE WHEN $5 OR $6 THEN NULL ELSE left_at END,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, since, seen == null ? null : JSON.stringify(seen), JSON.stringify(liveTabs(tabs, nowMs)), step === 'promote', step === 'resume']
    );
    return { visit: token, since: iso(since), seen: seen && typeof seen === 'object' ? seen : null };
  });
}

/**
 * The tab says what its list has in view now, while it is up (`left`
 * false) or as it leaves (`left` true): the visit's last word, which the
 * next visit measures from. A tab leaving while another still has the list
 * open leaves the visit going. Null when `seen` is not one (parseSeen).
 */
async function noteVisit(pool, { userId, token: raw, seen: rawSeen, left = false } = {}) {
  const token = cleanToken(raw);
  const seen = parseSeen(rawSeen);
  if (!userId || !token || !seen) return null;
  return transaction(pool, async (db) => {
    const row = await lockRow(db, userId);
    const nowMs = Number(row.now_ms) || Date.now();
    const tabs = liveTabs(row.current_tabs, nowMs);
    if (left) delete tabs[token];
    else tabs[token] = nowMs;
    await db.query(
      `UPDATE ai_list_visits
          SET current_at = to_timestamp($2::float8 / 1000), current_seen = $3, current_tabs = $4,
              left_tab = CASE WHEN $5 THEN $6 ELSE left_tab END,
              left_at = CASE WHEN $5 THEN to_timestamp($2::float8 / 1000) ELSE left_at END,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, nowMs, JSON.stringify(seen), JSON.stringify(liveTabs(tabs, nowMs)), !!left, token]
    );
    return { ok: true };
  });
}

/** Pure: a row opened, cleaned: its band, identity and standing, or null when any is not one. */
function cleanOpened({ band, identity, standing } = {}) {
  const name = typeof band === 'string' && BANDS.includes(band) ? band : null;
  const key = typeof identity === 'string' && identity.length <= MAX_KEY && KEY.test(identity) ? identity : null;
  const value = typeof standing === 'string' && standing.length <= MAX_VALUE && VALUE.test(standing) ? standing : null;
  if (!name || !key || value == null) return null;
  return { band: name, identity: key, standing: value };
}

/**
 * A row was opened: the last visit's record learns it was seen, so its band
 * no longer marks it new for the rest of the visit. A first visit has no
 * record to learn it (`last_visit_seen` is null), so nothing is written.
 * Null when the token, band, identity or standing is not one.
 */
async function noteOpened(pool, { userId, token: raw, band, identity, standing } = {}) {
  const token = cleanToken(raw);
  const entry = cleanOpened({ band, identity, standing });
  if (!userId || !token || !entry) return null;
  return transaction(pool, async (db) => {
    const row = await lockRow(db, userId);
    if (!row.last_visit_seen) return { ok: true };
    const seen = parseSeen(row.last_visit_seen);
    if (!seen) return { ok: true };
    seen[entry.band][entry.identity] = entry.standing;
    const clean = parseSeen(seen);
    // A record at its bounds cannot take another row: the list is drawn from
    // what it already had, rather than from half a list.
    if (!clean) return { ok: true };
    await db.query(
      'UPDATE ai_list_visits SET last_visit_seen = $2, updated_at = NOW() WHERE user_id = $1',
      [userId, JSON.stringify(clean)]
    );
    return { ok: true };
  });
}

/**
 * Pure: staging's `?demo=1` answer (routes/ai-work.js): a last visit 70
 * minutes ago that saw every demo row but three, so the before & after shots
 * show the marks on the fixture account, which is in no thread of its own.
 * Arrived since: a vote in Needs you (`unseen.needs`); moved: a request now
 * Building that was Reading (`moved`); and a change gone live (`unseen.done`).
 * The demo's rows with unread messages are new as well, by their own rule.
 * Identities are the page's (frontend/src/features/ai/model.ts visitSeen):
 * a Needs you card `need:<kind>:<id>`, a thread `thread:<id>`, a private
 * thread `root:<id>`.
 */
function demoVisit({ feed = [], work = {}, privateRoots = [] } = {}, now = Date.now(), {
  unseenNeeds = ['need:proposal:-103'],
  moved = { 'thread:-9208': 'next:reading' },
  unseenDone = ['thread:-9221'],
} = {}) {
  const needs = {};
  for (const item of feed) if (item && item.kind && item.id != null) needs[`need:${item.kind}:${item.id}`] = '';
  for (const t of work.needs || []) needs[`thread:${t.threadId}`] = '';
  for (const p of work.private || []) needs[`root:${p.rootId}`] = '';
  for (const rootId of privateRoots) needs[`root:${rootId}`] = '';
  const busy = {};
  for (const t of [...(work.next || []), ...(work.waiting || [])]) busy[`thread:${t.threadId}`] = `${t.group}:${t.work?.stage || ''}`;
  const done = {};
  for (const t of work.live || []) done[`thread:${t.threadId}`] = '';
  for (const p of work.private || []) if (p.state === 'done') done[`root:${p.rootId}`] = '';
  for (const key of unseenNeeds) delete needs[key];
  for (const key of unseenDone) delete done[key];
  Object.assign(busy, moved);
  return {
    visit: 'staging-demo-visit',
    since: new Date(now - 70 * 60000).toISOString(),
    seen: { needs, busy, done },
  };
}

module.exports = {
  VISIT_GAP_MS, BANDS, MAX_ENTRIES, openVisit, noteVisit, noteOpened, parseSeen, openStep, liveTabs, demoVisit,
};
