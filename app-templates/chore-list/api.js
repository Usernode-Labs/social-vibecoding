// This app's API: the group's chores, each one either always the same
// person's or taking turns. Turns go round the project's members (the
// platform's member list) and move on every Monday, UTC. server.js mounts it after the sign-in check: a write always has
// req.user ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user).
//
// "This week" is read from req.now, never new Date() or SQL's NOW(), so a
// staging preview opened at a chosen moment shows that moment's rota
// ("Time-dependent features" in the platform conventions).
//
// It came from Homeroom's ready-made chore list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL || process.env.USERNODE_PLATFORM_API_URL;

const NAME_MAX = 80;
const CHORES_SHOWN = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 5 January 1970 was a Monday: week numbers count from it.
const FIRST_MONDAY = Date.UTC(1970, 0, 5);

/** The Monday (UTC, 00:00) of the week `now` falls in. */
function weekStart(now) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

function weekNumber(monday) {
  return Math.round((monday.getTime() - FIRST_MONDAY) / WEEK_MS);
}

/** Chore `index` of the list goes to this member in week `week`. */
function turnOf(roster, index, week) {
  return roster[(((index + week) % roster.length) + roster.length) % roster.length];
}

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

// ── Who is in the group ──────────────────────────────────────────────────
//
// The project's members, from the platform ("Members" in the platform
// conventions): the creator first, then oldest member first, which is the
// rota's order. Asked with the viewer's own token, so only a member gets an
// answer; anyone else (an admin looking in, the platform's check runner)
// sees the chores without the rota. Cached for a minute per viewer, so the
// answer one member got is never shown to somebody the platform refuses.

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

// A fixed rota for a staging preview's declared check (`/?demo=1` only),
// since the check runner is not a member: the viewer and two made-up people.
// The plain route always shows the real members.
function demoMembers(req) {
  const fake = [{ id: -1, username: 'staging-demo-ana' }, { id: -2, username: 'staging-demo-ben' }];
  return req.user ? [{ id: req.user.id, username: req.user.username }, ...fake] : fake;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chores (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Always this person's; NULL takes turns round the members.
      assignee_id INTEGER,
      assignee_name VARCHAR(255)
    )
  `);
  // One row per chore done in a week, keyed by that week's Monday.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chore_done (
      chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
      week DATE NOT NULL,
      done_by INTEGER NOT NULL,
      done_by_name VARCHAR(255) NOT NULL,
      done_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (chore_id, week)
    )
  `);

  // A staging preview starts with no rows, so seed a few obviously fake
  // chores for the checks in dapp.json to find. Fixed ids and ON CONFLICT
  // keep it idempotent across rebuilds; the owner is a fake identity.
  // Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO chores (id, name, created_by, created_by_name)
      VALUES
        (900001, 'Staging demo dishes', 0, 'staging-demo-user'),
        (900002, 'Staging demo bins out', 0, 'staging-demo-user'),
        (900003, 'Staging demo vacuuming', 0, 'staging-demo-user'),
        (900004, 'Staging demo bathroom', 0, 'staging-demo-user')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO chores (id, name, created_by, created_by_name, assignee_id, assignee_name)
      VALUES (900005, 'Staging demo plants', 0, 'staging-demo-user', 0, 'staging-demo-user')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

function rosterFor(req) {
  return IS_STAGING && req.query.demo === '1'
    ? Promise.resolve({ status: 'ok', members: demoMembers(req) })
    : members(req);
}

/**
 * Who a body says does a chore: undefined when it says nothing, null for
 * "takes turns", or a member. A person the platform does not list as a
 * member is refused, so nobody is given a chore in a group they are not in.
 */
async function assigneeOf(req) {
  const body = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(body, 'assigneeId')) return { value: undefined };
  if (body.assigneeId === null || body.assigneeId === '') return { value: null };
  const roster = await rosterFor(req);
  const person = (roster.members || []).find((m) => m.id === Number(body.assigneeId));
  return person ? { value: person } : { error: 'Only somebody in this project can have a chore.' };
}

function routes(app, pool) {
  // This week's chores: whose they are (always one person's, or whose turn it
  // is when the rota is known), who is next, and whether it is done.
  app.get('/api/chores', async (req, res) => {
    try {
      const monday = weekStart(req.now);
      const week = weekNumber(monday);
      const weekDate = monday.toISOString().slice(0, 10);
      const roster = await rosterFor(req);
      const { rows } = await pool.query(
        `SELECT c.id, c.name, c.assignee_id, c.assignee_name, d.done_by_name
           FROM chores c
           LEFT JOIN chore_done d ON d.chore_id = c.id AND d.week = $1
          ORDER BY c.id
          LIMIT $2`,
        [weekDate, CHORES_SHOWN]
      );
      const me = req.user ? req.user.id : null;
      // Turns are dealt out among the chores that take turns only, so a
      // chore that is always one person's does not unbalance the rota.
      let turnIndex = 0;
      const chores = rows.map((r) => {
        const fixed = r.assignee_id !== null;
        let turn = null;
        let next = null;
        if (fixed) {
          turn = { id: r.assignee_id, username: r.assignee_name };
        } else if (roster.members) {
          turn = turnOf(roster.members, turnIndex, week);
          if (roster.members.length > 1) next = turnOf(roster.members, turnIndex, week + 1);
          turnIndex += 1;
        }
        return {
          id: r.id,
          name: r.name,
          fixed,
          done: !!r.done_by_name,
          doneBy: r.done_by_name,
          turn: turn ? turn.username : null,
          turnId: turn ? turn.id : null,
          yours: !!turn && turn.id === me,
          next: next ? next.username : null,
        };
      });
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        week: weekDate,
        rota: roster.status,
        people: roster.members ? roster.members.length : null,
        members: roster.members || [],
        chores,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/chores', async (req, res) => {
    const name = cleanText(req.body && req.body.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'Say what the chore is.' });
    try {
      const who = await assigneeOf(req);
      if (who.error) return res.status(400).json({ error: who.error });
      const { rows } = await pool.query(
        `INSERT INTO chores (name, created_by, created_by_name, assignee_id, assignee_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name, req.user.id, req.user.username, who.value ? who.value.id : null, who.value ? who.value.username : null]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Rename a chore, or change who does it (assigneeId null: takes turns).
  app.patch('/api/chores/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That chore is not on the list any more.' });
    const body = req.body || {};
    try {
      const { rows: found } = await pool.query('SELECT 1 FROM chores WHERE id = $1', [id]);
      if (!found.length) return res.status(404).json({ error: 'That chore is not on the list any more.' });
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = cleanText(body.name, NAME_MAX);
        if (!name) return res.status(400).json({ error: 'Say what the chore is.' });
        await pool.query('UPDATE chores SET name = $2 WHERE id = $1', [id, name]);
      }
      const who = await assigneeOf(req);
      if (who.error) return res.status(400).json({ error: who.error });
      if (who.value !== undefined) {
        await pool.query('UPDATE chores SET assignee_id = $2, assignee_name = $3 WHERE id = $1',
          [id, who.value ? who.value.id : null, who.value ? who.value.username : null]);
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Done this week (done: true), or not after all (done: false). Anyone can
  // tick a chore off: somebody covering for a housemate is fine.
  app.put('/api/chores/:id/done', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That chore is not on the list any more.' });
    const done = !!(req.body && req.body.done);
    const weekDate = weekStart(req.now).toISOString().slice(0, 10);
    try {
      if (!done) {
        await pool.query('DELETE FROM chore_done WHERE chore_id = $1 AND week = $2', [id, weekDate]);
        return res.json({ done: false });
      }
      const { rows } = await pool.query(
        `INSERT INTO chore_done (chore_id, week, done_by, done_by_name, done_at)
         SELECT id, $2, $3, $4, $5 FROM chores WHERE id = $1
         ON CONFLICT (chore_id, week) DO NOTHING
         RETURNING chore_id`,
        [id, weekDate, req.user.id, req.user.username, req.now]
      );
      if (!rows.length) {
        const { rows: exists } = await pool.query('SELECT 1 FROM chores WHERE id = $1', [id]);
        if (!exists.length) return res.status(404).json({ error: 'That chore is not on the list any more.' });
      }
      res.json({ done: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Anyone can take a chore off the list: it is the group's list.
  app.delete('/api/chores/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That chore is not on the list any more.' });
    try {
      await pool.query('DELETE FROM chores WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
