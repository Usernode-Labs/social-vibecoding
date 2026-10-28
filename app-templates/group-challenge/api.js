// This app's API: a monthly group challenge. Everyone in the project logs
// what they did by hand (an amount, a day this month, a note if they like),
// the leaderboard and the group goal add it up, and every month starts
// again at zero while the months before keep their results.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user).
//
// "This month" is the calendar month of req.now where the viewer is: the
// page sends its time zone as `?tz=Europe/Berlin` on every call (UTC when it
// sends none, or a name this server does not know). An entry is kept with
// the calendar day its logger picked, so it belongs to one month for
// everybody; only "today", and so which month is the current one, depends
// on where the viewer is. "Now" is req.now, never new Date() or SQL's NOW(),
// so a staging preview opened at a chosen moment shows that moment's month
// ("Time-dependent features" in the platform conventions).
//
// It came from Homeroom's ready-made group challenge. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL || process.env.USERNODE_PLATFORM_API_URL;

// The words this project was made with (words.json beside this file, which
// Homeroom writes when the project is made; the page's {{...}} come from the
// same file). Every project made from this starter runs this same code, and
// only its words.json differs. A missing or unreadable file reads as none,
// and each value below then falls back to the miles challenge's.
const WORDS = (() => {
  try {
    const parsed = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'words.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
})();
// What this challenge counts, set when the project was made. The page
// carries the same words (public/index.html, its data-unit-* values).
const UNIT_PLURAL = typeof WORDS.UNIT_PLURAL === 'string' && WORDS.UNIT_PLURAL ? WORDS.UNIT_PLURAL : 'miles';
// The group's goal for a month nobody changed it for. A month's goal is
// kept from its first entry on (challenge_goals), so a new default here
// applies from the next month that starts.
const DEFAULT_GOAL = Number(WORDS.DEFAULT_GOAL) > 0 ? Number(WORDS.DEFAULT_GOAL) : 200;
// Whether an amount may have decimals ("3.1 miles"), or is a whole number.
const DECIMALS = (WORDS.DECIMALS == null ? 'yes' : WORDS.DECIMALS) === 'yes';
// The most one entry can be: half the group's usual monthly goal. Far more
// than anybody does in a day, so it only stops a slipped finger's extra
// zeros; a big day can still be logged as two entries.
const MAX_AMOUNT = Math.max(1, DEFAULT_GOAL / 2);
const MAX_GOAL = 1000000000;
const NOTE_MAX = 120;
// Last month's results card shows on the first days of a new month.
const RESULTS_DAYS = 7;
const LATELY_SHOWN = 6;
const YOURS_SHOWN = 100;
const PEOPLE_SHOWN = 200;
const PAST_SHOWN = 24;

/** The zone a device reported ("Europe/Berlin"), or UTC when it sent
 * nothing, something too long to be one, or a name this server does not
 * know. */
function zoneOf(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (err) {
    return 'UTC';
  }
}

/** The day a moment falls on, where the viewer is: "2026-10-11". */
function localDay(at, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** "2026-10" -> [2026, 10]. */
function partsOf(month) {
  return month.split('-').slice(0, 2).map(Number);
}

function shiftMonth(month, by) {
  const [y, m] = partsOf(month);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

function daysIn(month) {
  const [y, m] = partsOf(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** A real calendar day written as "2026-10-11". */
function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** One line of text, whitespace tidied, cut to `max`. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** An amount from a body: a positive number (whole when DECIMALS is off,
 * else kept to two decimals) no bigger than `max`. `say` words the two
 * refusals that depend on what the amount is for. */
function amountOf(raw, max, say) {
  const text = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
  if (!/^-?\d{1,10}(\.\d+)?$/.test(text)) return { error: `Say how many ${UNIT_PLURAL}, as a number.` };
  const n = Number(text);
  if (!DECIMALS && !Number.isInteger(n)) return { error: `Whole ${UNIT_PLURAL} only.` };
  const value = Math.round(n * 100) / 100;
  if (!(value > 0)) return { error: say.zero };
  if (value > max) return { error: say.over };
  return { value };
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

// ── Who is in the group ──────────────────────────────────────────────────
//
// The project's members, from the platform ("Members" in the platform
// conventions), so the board can say who has not logged anything yet this
// month. Asked with the viewer's own token, so only a member gets an
// answer; anyone else (a guest, an admin looking in, the platform's check
// runner) sees the board without that line. Cached for a minute per viewer.

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
    const resp = await fetch(`${PLATFORM_API_BASE}/members?limit=200`, { headers });
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

async function migrate(pool) {
  // One row per entry. `day` is the calendar day its logger picked (the
  // month it counts toward); `logged_at` is when it was logged, for Lately.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS challenge_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      day DATE NOT NULL,
      note VARCHAR(${NOTE_MAX}),
      logged_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS challenge_entries_day ON challenge_entries (day)');
  await pool.query('CREATE INDEX IF NOT EXISTS challenge_entries_user_day ON challenge_entries (user_id, day)');
  // A month's goal, by its first day. Written with the default when the
  // month's first entry is logged, so a later change to DEFAULT_GOAL leaves
  // that month's result as it was; `set_by_name` says somebody changed it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS challenge_goals (
      month DATE PRIMARY KEY,
      goal NUMERIC(14, 2) NOT NULL CHECK (goal > 0),
      set_by INTEGER,
      set_by_name VARCHAR(255),
      set_at TIMESTAMPTZ
    )
  `);

  // A staging preview starts with no rows, so seed obviously fake entries
  // from a few made-up people for the checks in dapp.json to find: this
  // month's (the leaderboard, the goal bar, Lately) and last month's (the
  // results card and Past months). The amounts are shares of this app's
  // default goal, so they suit miles, steps or books alike. Days are
  // relative to the boot, and a row left behind in an earlier month is moved
  // forward on the next boot, so a preview always has this month's board.
  // Fixed ids and ON CONFLICT keep it idempotent; every owner is a fake
  // identity. Never runs in production.
  if (IS_STAGING) {
    const round = DECIMALS ? 1 : 0;
    const least = DECIMALS ? 0.1 : 1;
    await pool.query(`
      INSERT INTO challenge_entries (id, user_id, username, amount, day, note, logged_at)
      SELECT v.id, v.user_id, v.username, GREATEST(ROUND(v.share * $1::numeric, $2::int), $3::numeric),
             (s.at AT TIME ZONE 'UTC')::date, v.note, s.at
        FROM (VALUES (900001, -1, 'staging-demo-ana', 0.0405, INTERVAL '3 hours', 'Staging demo entry, before work'),
                     (900002, -3, 'staging-demo-cy', 0.0255, INTERVAL '20 hours', 'Staging demo entry'),
                     (900003, 0, 'staging-demo-user', 0.031, INTERVAL '26 hours', 'Staging demo entry, a good day'),
                     (900004, -1, 'staging-demo-ana', 0.0345, INTERVAL '2 days', 'Staging demo entry'),
                     (900005, -2, 'staging-demo-ben', 0.0285, INTERVAL '3 days', 'Staging demo entry, catching up'),
                     (900006, -4, 'staging-demo-dee', 0.021, INTERVAL '4 days', 'Staging demo entry'),
                     (900007, -3, 'staging-demo-cy', 0.0235, INTERVAL '5 days', 'Staging demo entry'),
                     (900008, -1, 'staging-demo-ana', 0.0305, INTERVAL '6 days', 'Staging demo entry'),
                     (900009, 0, 'staging-demo-user', 0.0265, INTERVAL '8 days', 'Staging demo entry'),
                     (900010, -2, 'staging-demo-ben', 0.0295, INTERVAL '9 days', 'Staging demo entry'),
                     (900011, -4, 'staging-demo-dee', 0.016, INTERVAL '11 days', 'Staging demo entry'),
                     (900012, -1, 'staging-demo-ana', 0.0245, INTERVAL '12 days', 'Staging demo entry'))
             AS v(id, user_id, username, share, ago, note)
       CROSS JOIN LATERAL (
         SELECT GREATEST(date_trunc('month', NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC') - v.ago) AT TIME ZONE 'UTC' AS at
       ) s
      ON CONFLICT (id) DO UPDATE SET day = EXCLUDED.day, logged_at = EXCLUDED.logged_at
       WHERE date_trunc('month', challenge_entries.day) < date_trunc('month', EXCLUDED.day)
    `, [DEFAULT_GOAL, round, least]);
    await pool.query(`
      INSERT INTO challenge_entries (id, user_id, username, amount, day, note, logged_at)
      SELECT v.id, v.user_id, v.username, GREATEST(ROUND(v.share * $1::numeric, $2::int), $3::numeric),
             s.day::date, v.note, (s.day + INTERVAL '18 hours') AT TIME ZONE 'UTC'
        FROM (VALUES (900101, -1, 'staging-demo-ana', 0.1805, 2, 'Staging demo entry, last month'),
                     (900102, -2, 'staging-demo-ben', 0.1465, 5, 'Staging demo entry, last month'),
                     (900103, -3, 'staging-demo-cy', 0.1215, 9, 'Staging demo entry, last month'),
                     (900104, 0, 'staging-demo-user', 0.0985, 12, 'Staging demo entry, last month'),
                     (900105, -1, 'staging-demo-ana', 0.1605, 16, 'Staging demo entry, last month'),
                     (900106, -4, 'staging-demo-dee', 0.0815, 19, 'Staging demo entry, last month'),
                     (900107, -2, 'staging-demo-ben', 0.1385, 22, 'Staging demo entry, last month'),
                     (900108, -3, 'staging-demo-cy', 0.1415, 26, 'Staging demo entry, last month'))
             AS v(id, user_id, username, share, day_of, note)
       CROSS JOIN LATERAL (
         SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 month' + (v.day_of - 1) * INTERVAL '1 day' AS day
       ) s
      ON CONFLICT (id) DO UPDATE SET day = EXCLUDED.day, logged_at = EXCLUDED.logged_at
       WHERE date_trunc('month', challenge_entries.day) < date_trunc('month', EXCLUDED.day)
    `, [DEFAULT_GOAL, round, least]);
  }
}

// ── Reading a month ──────────────────────────────────────────────────────

/** Everyone who logged something in `month`, most first, with ranks (a tie
 * shares one), the days they logged on, and the group's total. */
async function standings(pool, month, me) {
  const { rows } = await pool.query(
    `SELECT user_id, (array_agg(username ORDER BY logged_at DESC, id DESC))[1] AS username,
            SUM(amount) AS total, COUNT(DISTINCT day)::int AS days
       FROM challenge_entries
      WHERE day >= $1::date AND day < $2::date
      GROUP BY user_id
      ORDER BY total DESC, username
      LIMIT $3`,
    [`${month}-01`, `${shiftMonth(month, 1)}-01`, PEOPLE_SHOWN]
  );
  const { rows: sum } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_entries WHERE day >= $1::date AND day < $2::date',
    [`${month}-01`, `${shiftMonth(month, 1)}-01`]
  );
  let rank = 0;
  let last = null;
  const people = rows.map((r, i) => {
    const total = Number(r.total);
    if (total !== last) { rank = i + 1; last = total; }
    return { userId: r.user_id, username: r.username, total, days: r.days, rank, me: r.user_id === me };
  });
  return { total: Number(sum[0].total), people };
}

/** A month's goal: the one kept for it, or the default. */
async function goalOf(pool, month) {
  const { rows } = await pool.query(
    'SELECT goal, set_by_name, set_at FROM challenge_goals WHERE month = $1::date', [`${month}-01`]);
  if (!rows.length) return { amount: DEFAULT_GOAL, custom: false, setBy: null };
  const r = rows[0];
  return { amount: Number(r.goal), custom: !!r.set_by_name, setBy: r.set_by_name || null };
}

/** What a month that is over comes to: the total against its goal, the top
 * three, and who logged on the most days. */
function resultsOf(month, board, goal) {
  const mostDays = board.people.reduce((n, p) => Math.max(n, p.days), 0);
  return {
    month,
    total: board.total,
    goal: goal.amount,
    beaten: board.total >= goal.amount,
    people: board.people.length,
    top: board.people.slice(0, 3),
    others: board.people.slice(3, 12).map((p) => ({ username: p.username, total: p.total, me: p.me })),
    mostDays: mostDays ? {
      days: mostDays,
      of: daysIn(month),
      people: board.people.filter((p) => p.days === mostDays).slice(0, 3).map((p) => ({ username: p.username, me: p.me })),
    } : null,
  };
}

function entryOf(r, me) {
  return {
    id: r.id,
    username: r.username,
    amount: Number(r.amount),
    day: r.day,
    note: r.note,
    at: r.logged_at.toISOString(),
    mine: r.user_id === me,
  };
}

function routes(app, pool) {
  // A month: this one unless `month` ("2026-09") names one that is over.
  // This month comes with the goal and its pace, the leaderboard, Lately,
  // your own entries, who has not logged yet, and (on its first days) last
  // month's results; a month that is over comes with its results.
  app.get('/api/challenge', async (req, res) => {
    const zone = zoneOf(req.query.tz);
    const today = localDay(req.now, zone);
    const thisMonth = today.slice(0, 7);
    let month = thisMonth;
    if (req.query.month !== undefined && req.query.month !== '') {
      if (!isMonth(req.query.month)) return res.status(400).json({ error: 'That is not a month.' });
      if (req.query.month > thisMonth) return res.status(400).json({ error: 'That month has not started yet.' });
      month = req.query.month;
    }
    const current = month === thisMonth;
    try {
      const me = req.user ? req.user.id : null;
      const board = await standings(pool, month, me);
      const goal = await goalOf(pool, month);
      const dayOfMonth = Number(today.slice(8, 10));
      const days = daysIn(month);
      const out = {
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        today,
        month,
        thisMonth,
        current,
        daysInMonth: days,
        dayOfMonth: current ? dayOfMonth : days,
        daysLeft: current ? days - dayOfMonth : 0,
        maxAmount: MAX_AMOUNT,
        defaultGoal: DEFAULT_GOAL,
        goal,
        total: board.total,
        progress: Math.min(100, Math.floor((board.total / goal.amount) * 100)),
        beaten: board.total >= goal.amount,
        pace: null,
        leaderboard: board.people,
        lately: [],
        yours: [],
        members: 'unavailable',
        notYet: null,
        results: null,
        pastMonths: [],
      };

      if (current) {
        // Where the group finishes at this rate, and what it takes a day
        // from here (today included) to reach the goal.
        if (board.total > 0) {
          const projected = (board.total / dayOfMonth) * days;
          const toGo = goal.amount - board.total;
          out.pace = { projected, perDay: toGo > 0 ? toGo / (days - dayOfMonth + 1) : 0 };
        }
        const range = [`${month}-01`, `${shiftMonth(month, 1)}-01`];
        const { rows: lately } = await pool.query(
          `SELECT id, user_id, username, amount, to_char(day, 'YYYY-MM-DD') AS day, note, logged_at
             FROM challenge_entries WHERE day >= $1::date AND day < $2::date
            ORDER BY logged_at DESC, id DESC LIMIT $3`,
          [...range, LATELY_SHOWN]
        );
        out.lately = lately.map((r) => entryOf(r, me));
        if (me !== null) {
          const { rows: yours } = await pool.query(
            `SELECT id, user_id, username, amount, to_char(day, 'YYYY-MM-DD') AS day, note, logged_at
               FROM challenge_entries WHERE user_id = $3 AND day >= $1::date AND day < $2::date
              ORDER BY day DESC, logged_at DESC, id DESC LIMIT $4`,
            [...range, me, YOURS_SHOWN]
          );
          out.yours = yours.map((r) => entryOf(r, me));
        }
        const roster = await members(req);
        out.members = roster.status;
        if (roster.members) {
          out.notYet = roster.members
            .filter((m) => !board.people.some((p) => p.userId === m.id))
            .map((m) => ({ username: m.username, me: m.id === me }));
        }
        // Last month's results, on the first days of this one.
        if (dayOfMonth <= RESULTS_DAYS) {
          const before = shiftMonth(month, -1);
          const lastBoard = await standings(pool, before, me);
          if (lastBoard.people.length) out.results = resultsOf(before, lastBoard, await goalOf(pool, before));
        }
      } else {
        out.results = resultsOf(month, board, goal);
      }

      // The months before this one that have entries, newest first.
      const { rows: past } = await pool.query(
        `SELECT to_char(e.day, 'YYYY-MM') AS month, SUM(e.amount) AS total, MAX(g.goal) AS goal
           FROM challenge_entries e
           LEFT JOIN challenge_goals g ON g.month = (to_char(e.day, 'YYYY-MM') || '-01')::date
          WHERE e.day < $1::date
          GROUP BY 1
          ORDER BY 1 DESC
          LIMIT $2`,
        [`${thisMonth}-01`, PAST_SHOWN]
      );
      out.pastMonths = past.map((r) => {
        const total = Number(r.total);
        const target = r.goal == null ? DEFAULT_GOAL : Number(r.goal);
        return { month: r.month, total, goal: target, beaten: total >= target };
      });
      res.json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  // Log an amount: a day this month up to today (today when it says none),
  // and a note if you like.
  app.post('/api/entries', async (req, res) => {
    const body = req.body || {};
    const amount = amountOf(body.amount, MAX_AMOUNT, {
      zero: `Log more than zero ${UNIT_PLURAL}.`,
      over: `One entry can be up to ${MAX_AMOUNT.toLocaleString('en-US')} ${UNIT_PLURAL}. Log the rest as another entry.`,
    });
    if (amount.error) return res.status(400).json({ error: amount.error });
    const today = localDay(req.now, zoneOf(req.query.tz || body.tz));
    const day = body.day === undefined || body.day === null || body.day === '' ? today : body.day;
    if (!isDay(day) || day > today || day.slice(0, 7) !== today.slice(0, 7)) {
      return res.status(400).json({ error: 'Pick a day this month, up to today.' });
    }
    const note = cleanText(body.note, NOTE_MAX) || null;
    try {
      // The month keeps the goal it started with (see challenge_goals).
      await pool.query(
        'INSERT INTO challenge_goals (month, goal) VALUES ($1::date, $2) ON CONFLICT (month) DO NOTHING',
        [`${day.slice(0, 7)}-01`, DEFAULT_GOAL]
      );
      const { rows } = await pool.query(
        `INSERT INTO challenge_entries (user_id, username, amount, day, note, logged_at)
         VALUES ($1, $2, $3, $4::date, $5, $6)
         RETURNING id, user_id, username, amount, to_char(day, 'YYYY-MM-DD') AS day, note, logged_at`,
        [req.user.id, req.user.username, amount.value, day, note, req.now]
      );
      res.status(201).json({ id: rows[0].id, entry: entryOf(rows[0], req.user.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Take one of your own entries back. A month that is over keeps its
  // entries, so its results stay as they were.
  app.delete('/api/entries/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That entry is not there any more.' });
    const thisMonth = localDay(req.now, zoneOf(req.query.tz)).slice(0, 7);
    try {
      const { rows } = await pool.query(
        "SELECT user_id, to_char(day, 'YYYY-MM') AS month FROM challenge_entries WHERE id = $1", [id]);
      if (!rows.length) return res.status(404).json({ error: 'That entry is not there any more.' });
      if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Only whoever logged it can remove it.' });
      if (rows[0].month < thisMonth) return res.status(403).json({ error: 'That month is over, so its entries stay as they are.' });
      await pool.query('DELETE FROM challenge_entries WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Change this month's goal (for this month only), or put it back to the
  // usual one with `goal: null`. Anyone in the group can.
  app.put('/api/goal', async (req, res) => {
    const body = req.body || {};
    const month = localDay(req.now, zoneOf(req.query.tz || body.tz)).slice(0, 7);
    try {
      if (body.goal === null) {
        await pool.query(
          `INSERT INTO challenge_goals (month, goal) VALUES ($1::date, $2)
           ON CONFLICT (month) DO UPDATE SET goal = EXCLUDED.goal, set_by = NULL, set_by_name = NULL, set_at = NULL`,
          [`${month}-01`, DEFAULT_GOAL]
        );
        return res.json({ month, goal: await goalOf(pool, month) });
      }
      const goal = amountOf(body.goal, MAX_GOAL, {
        zero: `Set a goal of more than zero ${UNIT_PLURAL}.`,
        over: `A goal can be up to ${MAX_GOAL.toLocaleString('en-US')} ${UNIT_PLURAL}.`,
      });
      if (goal.error) return res.status(400).json({ error: goal.error });
      await pool.query(
        `INSERT INTO challenge_goals (month, goal, set_by, set_by_name, set_at) VALUES ($1::date, $2, $3, $4, $5)
         ON CONFLICT (month) DO UPDATE SET goal = EXCLUDED.goal, set_by = EXCLUDED.set_by,
           set_by_name = EXCLUDED.set_by_name, set_at = EXCLUDED.set_at`,
        [`${month}-01`, goal.value, req.user.id, req.user.username, req.now]
      );
      res.json({ month, goal: await goalOf(pool, month) });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
