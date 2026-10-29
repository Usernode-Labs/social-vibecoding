// This app's API, in one of two modes chosen when the project was made
// (MODE below):
//
//   - 'dates': the group's plans for finding a time. A plan is a name and a
//     few suggested times; everyone marks each time free, if needed or
//     can't, and the time the most people can make is named as the best so
//     far. Whoever started a plan sets its time, which closes it, and can
//     reopen it.
//   - 'weekly': a group that meets every week finding its regular time.
//     Everyone marks the hours of the week that work for them, and the hour
//     the most people can make is named as the best ("The week" below).
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user).
//
// "Now" is req.now, never new Date() or SQL's NOW(), so a staging preview
// opened at a chosen moment shows which plans are still to come at that
// moment ("Time-dependent features" in the platform conventions).
//
// HOW A TIME IS STORED. Every suggested time is a real timestamp
// (time_slots.starts_at, TIMESTAMPTZ). The page builds it from the
// suggester's own day and time inputs and sends it as an ISO string, and
// every viewer sees it in their own time zone. A whole-day suggestion
// (all_day) is a calendar date, the same date wherever you are: it is
// stored as that date's midnight UTC, and the page shows it in UTC, as a
// date with no time. A timed suggestion has passed once it has started; a
// whole day has passed once that date is over everywhere, 36 hours after its
// midnight UTC (the last time zone, UTC-12, finishes the day then). A plan
// moves to Past once its set time has passed or, while it is open, once all
// of its times have.
//
// It came from Homeroom's ready-made find-a-time app. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
// The words this project was made with (words.json beside this file, which
// Homeroom writes when the project is made; the page's {{...}} come from the
// same file). Every project made from this starter runs this same code, and
// only its words.json differs. A missing or unreadable file reads as none.
const WORDS = (() => {
  try {
    const parsed = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'words.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
})();
// How this app finds a time, set when the project was made: 'dates' (a
// plan's suggested days and times) or 'weekly' (the hours of every week).
// Only that mode's tables and routes are made.
const MODE = WORDS.TIME_MODE === 'weekly' ? 'weekly' : 'dates';
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL || process.env.USERNODE_PLATFORM_API_URL;

const NAME_MAX = 80;
// A new plan suggests two to eight times; with the ones the group adds
// later, a plan has twelve at most, so the grid stays readable on a phone.
const START_MIN = 2;
const START_MAX = 8;
const TIMES_MAX = 12;
const MARKS = ['free', 'maybe', 'no'];
const HOUR_MS = 60 * 60 * 1000;
const ALL_DAY_MS = 36 * HOUR_MS;
const AHEAD_MS = 5 * 366 * 24 * HOUR_MS;
const OPEN_SHOWN = 50;
const PAST_SHOWN = 10;
const WAITING_SHOWN = 200;

/** One line of text, whitespace tidied, cut to `max`. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

const GONE = 'That plan is not here any more.';
const CLOSED = 'The time is set, so this plan is closed. Whoever started it can reopen it.';

/** When a suggested time has passed, in ms (see "How a time is stored"). */
function endsAt(slot) {
  return slot.starts_at.getTime() + (slot.all_day ? ALL_DAY_MS : 0);
}

/**
 * A suggested time from a body ({ startsAt: ISO string, allDay }): a moment,
 * or a whole day kept as its date's midnight UTC. Refused when it has
 * already passed, or is years away (a mistyped year).
 */
function parseTime(raw, now) {
  const at = new Date(raw && typeof raw.startsAt === 'string' ? raw.startsAt : NaN);
  if (Number.isNaN(at.getTime())) return { error: 'Pick a day for each time.' };
  const allDay = !!(raw && raw.allDay === true);
  const startsAt = allDay ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) : at;
  if (startsAt.getTime() + (allDay ? ALL_DAY_MS : 0) <= now.getTime()) return { error: 'That time has already passed.' };
  if (startsAt.getTime() > now.getTime() + AHEAD_MS) return { error: 'Pick a time in the next few years.' };
  return { startsAt, allDay };
}

const sameTime = (a, b) => a.allDay === b.allDay && a.startsAt.getTime() === b.startsAt.getTime();

// ── Who is in the group ──────────────────────────────────────────────────
//
// The project's members, from the platform ("Members" in the platform
// conventions), for "Still to answer". Asked with the viewer's own token, so
// only a member gets an answer; anyone else (a guest, an admin looking in,
// the platform's check runner) sees the plans without that line. Cached for
// a minute per viewer, so the answer one member got is never shown to
// somebody the platform refuses.

const cache = new Map(); // viewer id -> { at, members }
const CACHE_MS = 60 * 1000;

async function members(req) {
  if (!req.user) return { status: 'unavailable', members: null };
  const hit = cache.get(req.user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { status: 'ok', members: hit.members };
  const token = req.query.token || req.headers['x-usernode-token'];
  if (!PLATFORM_API_BASE || !token) return { status: 'unavailable', members: null };
  const headers = { 'x-usernode-user-token': token };
  if (process.env.USERNODE_LLM_PROXY_TOKEN) headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
  try {
    const resp = await fetch(`${PLATFORM_API_BASE}/members?limit=${WAITING_SHOWN}`, { headers });
    if (resp.status === 403) return { status: 'not_member', members: null };
    if (!resp.ok) return { status: 'unavailable', members: null };
    const body = await resp.json();
    const list = (body.members || []).map((m) => ({ id: m.id, username: m.username }));
    if (!list.length) return { status: 'unavailable', members: null };
    if (cache.size > 500) cache.clear();
    cache.set(req.user.id, { at: Date.now(), members: list });
    return { status: 'ok', members: list };
  } catch (err) {
    console.warn('members lookup failed: ' + err.message);
    return { status: 'unavailable', members: null };
  }
}

async function migratePlans(pool) {
  // A plan; set_slot_id is the time its starter set (NULL while it is open).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_plans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      set_slot_id INTEGER,
      set_at TIMESTAMPTZ
    )
  `);
  // Its suggested times ("How a time is stored" above).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_slots (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES time_plans(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT FALSE,
      suggested_by INTEGER NOT NULL,
      suggested_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS time_slots_plan_idx ON time_slots (plan_id, starts_at)');
  // One mark per person per time. marked_at is when they first marked it
  // (the grid's column order); changed_at moves with every change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_marks (
      slot_id INTEGER NOT NULL REFERENCES time_slots(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      mark VARCHAR(8) NOT NULL CHECK (mark IN ('free', 'maybe', 'no')),
      marked_at TIMESTAMPTZ NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (slot_id, user_id)
    )
  `);

  // A staging preview starts with no rows, so seed one obviously fake open
  // plan, with four times a few days ahead and marks from made-up people,
  // for the checks in dapp.json to find (the grid and the best time). A time
  // that has passed is moved forward again on the next boot, so the preview
  // always has the plan coming up. Fixed ids and ON CONFLICT keep it
  // idempotent across rebuilds; everyone in it is a fake identity. Never
  // runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO time_plans (id, name, created_by, created_by_name, created_at)
      VALUES (900001, 'Staging demo get-together', 0, 'staging-demo-user', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    const day = "(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
    await pool.query(`
      INSERT INTO time_slots (id, plan_id, starts_at, all_day, suggested_by, suggested_by_name, created_at)
      VALUES
        (900001, 900001, ${day} + INTERVAL '3 days 19 hours', FALSE, 0, 'staging-demo-user', NOW()),
        (900002, 900001, ${day} + INTERVAL '5 days 19 hours', FALSE, 0, 'staging-demo-user', NOW()),
        (900003, 900001, ${day} + INTERVAL '7 days 14 hours', FALSE, -1, 'staging-demo-ana', NOW()),
        (900004, 900001, ${day} + INTERVAL '8 days', TRUE, -2, 'staging-demo-ben', NOW())
      ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at WHERE time_slots.starts_at < NOW()
    `);
    // Who marked what: the second time is the best (four free, one if needed).
    const people = [[0, 'staging-demo-user'], [-1, 'staging-demo-ana'], [-2, 'staging-demo-ben'], [-3, 'staging-demo-cy'], [-4, 'staging-demo-dee']];
    const marks = {
      900001: ['free', 'free', 'no', 'maybe', 'free'],
      900002: ['free', 'free', 'free', 'free', 'maybe'],
      900003: ['no', 'free', 'maybe', 'no', 'free'],
      900004: ['maybe', 'no', 'free', 'free', 'no'],
    };
    const slotIds = [];
    const userIds = [];
    const names = [];
    const values = [];
    const order = [];
    for (const [slot, row] of Object.entries(marks)) {
      row.forEach((mark, i) => {
        slotIds.push(Number(slot));
        userIds.push(people[i][0]);
        names.push(people[i][1]);
        values.push(mark);
        order.push(people.length - i);
      });
    }
    await pool.query(
      `INSERT INTO time_marks (slot_id, user_id, username, mark, marked_at, changed_at)
       SELECT t.slot_id, t.user_id, t.username, t.mark, NOW() - t.hours * INTERVAL '1 hour', NOW() - t.hours * INTERVAL '1 hour'
         FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::int[]) AS t(slot_id, user_id, username, mark, hours)
       ON CONFLICT (slot_id, user_id) DO NOTHING`,
      [slotIds, userIds, names, values, order]
    );
  }
}

// When each plan is over: its set time's end, or while it is open, the end
// of its last time (see "How a time is stored").
const PLAN_ENDS = `
  SELECT p.id, p.name, p.created_by, p.created_by_name, p.set_slot_id,
         COALESCE(
           (SELECT s.starts_at + CASE WHEN s.all_day THEN INTERVAL '36 hours' ELSE INTERVAL '0 hours' END
              FROM time_slots s WHERE s.id = p.set_slot_id AND s.plan_id = p.id),
           (SELECT MAX(s.starts_at + CASE WHEN s.all_day THEN INTERVAL '36 hours' ELSE INTERVAL '0 hours' END)
              FROM time_slots s WHERE s.plan_id = p.id)) AS ends_at
    FROM time_plans p`;

/** A plan's row with what decides who may change it, or null. */
async function planRow(pool, id) {
  const { rows } = await pool.query('SELECT id, created_by, set_slot_id FROM time_plans WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * The best time so far, among the times that have not passed: the most
 * free, then the most "if needed", then the earliest. A time nobody can
 * make (no free, no if needed) is never the best.
 */
function bestOf(slots) {
  const candidates = slots.filter((s) => !s.passed && s.free + s.maybe > 0);
  candidates.sort((a, b) => (b.free - a.free) || (b.maybe - a.maybe)
    || (Date.parse(a.startsAt) - Date.parse(b.startsAt)) || (a.id - b.id));
  return candidates[0] || null;
}

function planRoutes(app, pool) {
  // The open plans (soonest first), each with its times, everyone's marks,
  // the best time so far and who has not answered yet; then the last few
  // plans that are over.
  app.get('/api/plans', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const now = req.now.getTime();
      const { rows: open } = await pool.query(
        `SELECT * FROM (${PLAN_ENDS}) x WHERE ends_at > $1 ORDER BY ends_at, id LIMIT $2`,
        [req.now, OPEN_SHOWN]
      );
      const { rows: past } = await pool.query(
        `SELECT * FROM (${PLAN_ENDS}) x WHERE ends_at <= $1 ORDER BY ends_at DESC, id DESC LIMIT $2`,
        [req.now, PAST_SHOWN]
      );
      const ids = open.concat(past).map((p) => p.id);
      const { rows: slots } = ids.length
        ? await pool.query(
          `SELECT id, plan_id, starts_at, all_day, suggested_by, suggested_by_name FROM time_slots
            WHERE plan_id = ANY($1::int[]) ORDER BY starts_at, all_day DESC, id`,
          [ids])
        : { rows: [] };
      const openIds = open.map((p) => p.id);
      const { rows: marks } = openIds.length
        ? await pool.query(
          `SELECT m.slot_id, s.plan_id, m.user_id, m.username, m.mark FROM time_marks m
             JOIN time_slots s ON s.id = m.slot_id
            WHERE s.plan_id = ANY($1::int[]) ORDER BY m.marked_at, m.user_id`,
          [openIds])
        : { rows: [] };
      const roster = openIds.length ? await members(req) : { status: 'unavailable', members: null };

      const plans = open.map((p) => {
        const own = slots.filter((s) => s.plan_id === p.id);
        const ownMarks = marks.filter((m) => m.plan_id === p.id);
        const isOpen = p.set_slot_id === null;
        // Who has answered: you first, then in the order they first did.
        const people = [];
        for (const m of ownMarks) {
          if (!people.some((x) => x.id === m.user_id)) people.push({ id: m.user_id, username: m.username, me: m.user_id === me });
        }
        people.sort((a, b) => Number(b.me) - Number(a.me));
        const shaped = own.map((s) => {
          const these = ownMarks.filter((m) => m.slot_id === s.id);
          const byPerson = {};
          for (const m of these) byPerson[m.user_id] = m.mark;
          return {
            id: s.id,
            startsAt: s.starts_at.toISOString(),
            allDay: s.all_day,
            by: s.suggested_by_name,
            passed: endsAt(s) <= now,
            canRemove: isOpen && me !== null && own.length > START_MIN && (s.suggested_by === me || p.created_by === me),
            marks: byPerson,
            free: these.filter((m) => m.mark === 'free').length,
            maybe: these.filter((m) => m.mark === 'maybe').length,
            maybeNames: these.filter((m) => m.mark === 'maybe').map((m) => m.username),
          };
        });
        const best = bestOf(shaped);
        const setSlot = shaped.find((s) => s.id === p.set_slot_id) || null;
        // Soonest first: by the set time, or by the next time still to come.
        const next = setSlot || shaped.find((s) => !s.passed) || shaped[shaped.length - 1];
        return {
          id: p.id,
          name: p.name,
          by: p.created_by_name,
          mine: p.created_by === me,
          open: isOpen,
          set: setSlot ? setSlot.id : null,
          best: best ? best.id : null,
          answered: people.length,
          people,
          slots: shaped,
          // Members who have not marked any of its times, or null when the
          // member list is not known (see members() above).
          waiting: isOpen && roster.members
            ? roster.members.filter((m) => !people.some((x) => x.id === m.id)).map((m) => ({ id: m.id, username: m.username, me: m.id === me }))
            : null,
          nextAt: next ? next.startsAt : null,
        };
      });
      plans.sort((a, b) => (Date.parse(a.nextAt) - Date.parse(b.nextAt)) || (a.id - b.id));

      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        maxTimes: TIMES_MAX,
        members: roster.status,
        plans,
        past: past.map((p) => {
          const s = slots.find((x) => x.id === p.set_slot_id && x.plan_id === p.id);
          return {
            id: p.id,
            name: p.name,
            by: p.created_by_name,
            mine: p.created_by === me,
            set: s ? { id: s.id, startsAt: s.starts_at.toISOString(), allDay: s.all_day } : null,
          };
        }),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Start a plan: a name and two to eight times, each { startsAt, allDay }.
  app.post('/api/plans', async (req, res) => {
    const body = req.body || {};
    const name = cleanText(body.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'Give the plan a name.' });
    const raw = Array.isArray(body.times) ? body.times : [];
    if (raw.length < START_MIN) return res.status(400).json({ error: 'Suggest at least two times.' });
    if (raw.length > START_MAX) return res.status(400).json({ error: 'Suggest eight times at most. Anyone can add more later.' });
    const times = [];
    for (const r of raw) {
      const t = parseTime(r, req.now);
      if (t.error) return res.status(400).json({ error: t.error });
      if (!times.some((x) => sameTime(x, t))) times.push(t);
    }
    if (times.length < START_MIN) return res.status(400).json({ error: 'Suggest at least two different times.' });
    try {
      // The plan and its times in one statement, so neither is ever saved
      // without the other.
      const { rows } = await pool.query(
        `WITH p AS (
           INSERT INTO time_plans (name, created_by, created_by_name, created_at)
           VALUES ($1, $2, $3, $4) RETURNING id
         )
         INSERT INTO time_slots (plan_id, starts_at, all_day, suggested_by, suggested_by_name, created_at)
         SELECT p.id, t.starts_at, t.all_day, $2, $3, $4
           FROM p, unnest($5::timestamptz[], $6::boolean[]) AS t(starts_at, all_day)
         RETURNING plan_id`,
        [name, req.user.id, req.user.username, req.now, times.map((t) => t.startsAt), times.map((t) => t.allDay)]
      );
      res.status(201).json({ id: rows[0].plan_id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Suggest another time, while the plan is open.
  app.post('/api/plans/:id/slots', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    const t = parseTime(req.body, req.now);
    if (t.error) return res.status(400).json({ error: t.error });
    try {
      const plan = await planRow(pool, id);
      if (!plan) return res.status(404).json({ error: GONE });
      if (plan.set_slot_id !== null) return res.status(409).json({ error: CLOSED });
      const { rows: have } = await pool.query('SELECT starts_at, all_day FROM time_slots WHERE plan_id = $1', [id]);
      if (have.some((s) => sameTime({ startsAt: s.starts_at, allDay: s.all_day }, t))) {
        return res.status(409).json({ error: 'That time is already suggested.' });
      }
      if (have.length >= TIMES_MAX) return res.status(400).json({ error: 'A plan has twelve times at most.' });
      const { rows } = await pool.query(
        `INSERT INTO time_slots (plan_id, starts_at, all_day, suggested_by, suggested_by_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, t.startsAt, t.allDay, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Take a time off an open plan: whoever suggested it, or whoever started
  // the plan. Everyone's marks on it go too. A plan keeps at least two.
  app.delete('/api/slots/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That time is not on the plan any more.' });
    try {
      const { rows } = await pool.query(
        `SELECT s.plan_id, s.suggested_by, p.created_by, p.set_slot_id,
                (SELECT COUNT(*)::int FROM time_slots o WHERE o.plan_id = s.plan_id) AS n
           FROM time_slots s JOIN time_plans p ON p.id = s.plan_id WHERE s.id = $1`,
        [id]
      );
      const s = rows[0];
      if (!s) return res.status(404).json({ error: 'That time is not on the plan any more.' });
      if (s.suggested_by !== req.user.id && s.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only whoever suggested it, or started the plan, can take it off.' });
      }
      if (s.set_slot_id !== null) return res.status(409).json({ error: CLOSED });
      if (s.n <= START_MIN) return res.status(400).json({ error: 'A plan keeps at least two times.' });
      await pool.query('DELETE FROM time_slots WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Your marks on a plan's times: { marks: [{ slotId, mark }] }, mark one of
  // free, maybe (if needed) or no (can't). Change them any time while the
  // plan is open; times you leave out keep what you said before.
  app.put('/api/plans/:id/marks', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    const raw = req.body && Array.isArray(req.body.marks) ? req.body.marks : [];
    if (!raw.length) return res.status(400).json({ error: 'Mark at least one time.' });
    if (raw.length > TIMES_MAX) return res.status(400).json({ error: 'That is more times than a plan has.' });
    const bySlot = new Map();
    for (const m of raw) {
      const slotId = Number(m && m.slotId);
      if (!Number.isInteger(slotId) || slotId <= 0) return res.status(400).json({ error: 'That time is not on this plan.' });
      if (!MARKS.includes(m.mark)) return res.status(400).json({ error: 'Mark each time free, if needed or can\'t.' });
      bySlot.set(slotId, m.mark);
    }
    try {
      const plan = await planRow(pool, id);
      if (!plan) return res.status(404).json({ error: GONE });
      if (plan.set_slot_id !== null) return res.status(409).json({ error: CLOSED });
      const { rows: have } = await pool.query('SELECT id FROM time_slots WHERE plan_id = $1', [id]);
      const ids = [...bySlot.keys()];
      if (!ids.every((s) => have.some((x) => x.id === s))) {
        return res.status(400).json({ error: 'That time is not on this plan any more. Look again and mark the ones that are.' });
      }
      await pool.query(
        `INSERT INTO time_marks (slot_id, user_id, username, mark, marked_at, changed_at)
         SELECT t.slot_id, $2, $3, t.mark, $4, $4 FROM unnest($1::int[], $5::text[]) AS t(slot_id, mark)
         ON CONFLICT (slot_id, user_id) DO UPDATE
           SET mark = EXCLUDED.mark, username = EXCLUDED.username, changed_at = EXCLUDED.changed_at`,
        [ids, req.user.id, req.user.username, req.now, ids.map((s) => bySlot.get(s))]
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Set the time ({ slotId }: any of the plan's times), which closes the
  // plan; { slotId: null } reopens it. Only whoever started it.
  app.put('/api/plans/:id/set', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    const body = req.body || {};
    try {
      const plan = await planRow(pool, id);
      if (!plan) return res.status(404).json({ error: GONE });
      if (plan.created_by !== req.user.id) return res.status(403).json({ error: 'Only whoever started the plan can set the time.' });
      if (body.slotId === null) {
        await pool.query('UPDATE time_plans SET set_slot_id = NULL, set_at = NULL WHERE id = $1', [id]);
        return res.json({ set: null });
      }
      const slotId = Number(body.slotId);
      const { rowCount } = Number.isInteger(slotId) && slotId > 0
        ? await pool.query(
          `UPDATE time_plans p SET set_slot_id = s.id, set_at = $3
             FROM time_slots s WHERE p.id = $1 AND s.id = $2 AND s.plan_id = p.id`,
          [id, slotId, req.now])
        : { rowCount: 0 };
      if (!rowCount) return res.status(400).json({ error: 'Pick one of the plan\'s times.' });
      res.json({ set: slotId });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever started a plan can delete it, with its times and everyone's marks.
  app.delete('/api/plans/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const plan = await planRow(pool, id);
      if (!plan) return res.status(404).json({ error: GONE });
      if (plan.created_by !== req.user.id) return res.status(403).json({ error: 'Only whoever started the plan can delete it.' });
      await pool.query('DELETE FROM time_plans WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

// ── The week ─────────────────────────────────────────────────────────────
//
// HOW AN HOUR IS STORED. A weekly hour is a day of the week (0 Monday to 6
// Sunday) and an hour of the day (FIRST_HOUR to LAST_HOUR - 1, the hour
// that starts then): a wall-clock time for the group, "Tuesdays at 7 PM",
// with no time zone and no date. Everyone sees the same hours, wherever
// they are, which is what a group that meets in one place means by it.
// week_free holds one row per person per hour that works for them; an hour
// not there does not. Somebody has answered once they have marked one.

const FIRST_HOUR = 8;
const LAST_HOUR = 22; // the last hour shown starts at 9 PM and ends at 10 PM
const DAYS = 7;
const BEST_SHOWN = 3;

const hourKey = (day, hour) => `${day}-${hour}`;

async function migrateWeek(pool) {
  // One row per person per weekly hour that works for them. marked_at is
  // when they first marked it, kept while they keep it, so who answered
  // first stays first however often they change their week.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS week_free (
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      day SMALLINT NOT NULL CHECK (day BETWEEN 0 AND 6),
      hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
      marked_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, day, hour)
    )
  `);

  // A staging preview starts with no rows, so seed five made-up people's
  // weeks for the checks in dapp.json to find (the shaded grid and the best
  // weekly time): Tuesday evening suits the most. Everyone in it is a fake
  // identity, ON CONFLICT keeps it idempotent across rebuilds, and it never
  // runs in production.
  if (IS_STAGING) {
    const people = [[0, 'staging-demo-user'], [-1, 'staging-demo-ana'], [-2, 'staging-demo-ben'], [-3, 'staging-demo-cy'], [-4, 'staging-demo-dee']];
    // [day, from, to] blocks per person, in the order above.
    const weeks = [
      [[1, 18, 21], [3, 19, 21]],
      [[1, 19, 22], [2, 18, 20], [5, 10, 13]],
      [[1, 19, 21], [3, 18, 21]],
      [[1, 17, 20], [5, 9, 12]],
      [[3, 19, 22], [6, 14, 17]],
    ];
    const ids = [];
    const names = [];
    const days = [];
    const hours = [];
    weeks.forEach((blocks, i) => {
      for (const [day, from, to] of blocks) {
        for (let hour = from; hour < to; hour += 1) {
          ids.push(people[i][0]);
          names.push(people[i][1]);
          days.push(day);
          hours.push(hour);
        }
      }
    });
    await pool.query(
      `INSERT INTO week_free (user_id, username, day, hour, marked_at)
       SELECT t.user_id, t.username, t.day, t.hour, NOW()
         FROM unnest($1::int[], $2::text[], $3::smallint[], $4::smallint[]) AS t(user_id, username, day, hour)
       ON CONFLICT (user_id, day, hour) DO NOTHING`,
      [ids, names, days, hours]
    );
  }
}

/**
 * The best weekly hours: the most people free, then the most free in the
 * hour after (a meeting runs on), then the earliest in the week. An hour
 * next to one already named on the same day is the same evening, so it is
 * skipped for the next best.
 */
function bestHours(free) {
  const count = (day, hour) => (free.get(hourKey(day, hour)) || []).length;
  const candidates = [];
  for (const [key, ids] of free) {
    const [day, hour] = key.split('-').map(Number);
    if (ids.length) candidates.push({ day, hour, n: ids.length, next: count(day, hour + 1) });
  }
  candidates.sort((a, b) => (b.n - a.n) || (b.next - a.next) || (a.day - b.day) || (a.hour - b.hour));
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= BEST_SHOWN) break;
    if (picked.some((p) => p.day === c.day && Math.abs(p.hour - c.hour) <= 1)) continue;
    picked.push(c);
  }
  return picked.map((c) => ({ day: c.day, hour: c.hour }));
}

function weekRoutes(app, pool) {
  // The week: who has answered (you first, then in the order they did),
  // which of them can make each hour, the best hours, and who in the
  // project has not answered yet.
  app.get('/api/week', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `SELECT user_id, username, day, hour, marked_at FROM week_free
          WHERE hour >= $1 AND hour < $2 ORDER BY marked_at, user_id, day, hour`,
        [FIRST_HOUR, LAST_HOUR]
      );
      const people = [];
      const free = new Map();
      for (const r of rows) {
        if (!people.some((p) => p.id === r.user_id)) people.push({ id: r.user_id, username: r.username, me: r.user_id === me });
        const key = hourKey(r.day, r.hour);
        if (!free.has(key)) free.set(key, []);
        free.get(key).push(r.user_id);
      }
      people.sort((a, b) => Number(b.me) - Number(a.me));
      const roster = await members(req);
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        days: DAYS,
        firstHour: FIRST_HOUR,
        lastHour: LAST_HOUR,
        members: roster.status,
        people,
        // "day-hour" -> the ids of everyone who can make it, in answer order.
        free: Object.fromEntries([...free.entries()].sort()),
        best: bestHours(free),
        // Members who have not marked an hour yet, or null when the member
        // list is not known (see members() above).
        waiting: roster.members
          ? roster.members.filter((m) => !people.some((p) => p.id === m.id)).map((m) => ({ id: m.id, username: m.username, me: m.id === me }))
          : null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Your week: { hours: [[day, hour], ...] }, every hour that works for you,
  // which replaces what you said before. An empty list takes your answer
  // back. Hours you keep keep when you first marked them.
  app.put('/api/week/mine', async (req, res) => {
    const raw = req.body && req.body.hours;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'Say which hours work for you.' });
    if (raw.length > DAYS * (LAST_HOUR - FIRST_HOUR)) return res.status(400).json({ error: 'That is more hours than the week has.' });
    const keys = new Map();
    for (const h of raw) {
      const day = Array.isArray(h) ? h[0] : NaN;
      const hour = Array.isArray(h) ? h[1] : NaN;
      if (!Number.isInteger(day) || day < 0 || day >= DAYS || !Number.isInteger(hour) || hour < FIRST_HOUR || hour >= LAST_HOUR) {
        return res.status(400).json({ error: 'Pick hours from the week\'s grid.' });
      }
      keys.set(hourKey(day, hour), [day, hour]);
    }
    const hours = [...keys.values()];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM week_free w WHERE w.user_id = $1
            AND NOT EXISTS (SELECT 1 FROM unnest($2::smallint[], $3::smallint[]) AS t(day, hour) WHERE t.day = w.day AND t.hour = w.hour)`,
        [req.user.id, hours.map((x) => x[0]), hours.map((x) => x[1])]
      );
      await client.query(
        `INSERT INTO week_free (user_id, username, day, hour, marked_at)
         SELECT $1, $2, t.day, t.hour, $5 FROM unnest($3::smallint[], $4::smallint[]) AS t(day, hour)
         ON CONFLICT (user_id, day, hour) DO UPDATE SET username = EXCLUDED.username`,
        [req.user.id, req.user.username, hours.map((x) => x[0]), hours.map((x) => x[1]), req.now]
      );
      await client.query('COMMIT');
      res.json({ ok: true, hours: hours.length });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client.release();
    }
  });
}

async function migrate(pool) {
  if (MODE === 'weekly') await migrateWeek(pool);
  else await migratePlans(pool);
}

function routes(app, pool) {
  if (MODE === 'weekly') weekRoutes(app, pool);
  else planRoutes(app, pool);
}

module.exports = { migrate, routes };
