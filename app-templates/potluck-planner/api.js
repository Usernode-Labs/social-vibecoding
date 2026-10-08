// This app's API: potlucks, each with a date, a time and a place, and who is
// bringing what by course. server.js mounts it after the sign-in check: a
// write always has req.user ({ id, username }); a read may come from a guest
// with no account (req.guest, no req.user).
//
// "Now" is req.now, never new Date() or SQL's NOW(), so a staging preview
// opened at a chosen moment shows what is coming up at that moment
// ("Time-dependent features" in the platform conventions).
//
// It came from Homeroom's ready-made potluck planner. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TITLE_MAX = 80;
const PLACE_MAX = 120;
const DISH_MAX = 80;
const PAST_SHOWN = 5;
const HOUR_MS = 60 * 60 * 1000;
// A potluck stays "coming up" until six hours after it starts.
const STILL_ON_MS = 6 * HOUR_MS;
const COURSES = ['Mains', 'Sides', 'Salads', 'Desserts', 'Drinks', 'Other'];

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

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS potlucks (
      id SERIAL PRIMARY KEY,
      title VARCHAR(${TITLE_MAX}) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      place VARCHAR(${PLACE_MAX}),
      host_id INTEGER NOT NULL,
      host_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS potluck_dishes (
      id SERIAL PRIMARY KEY,
      potluck_id INTEGER NOT NULL REFERENCES potlucks(id) ON DELETE CASCADE,
      course VARCHAR(16) NOT NULL,
      dish VARCHAR(${DISH_MAX}) NOT NULL,
      bringer_id INTEGER NOT NULL,
      bringer_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS potluck_dishes_potluck_idx ON potluck_dishes (potluck_id)');

  // A staging preview starts with no rows, so seed one obviously fake
  // potluck, with a few dishes and two courses nobody has taken, for the
  // checks in dapp.json to find. Its date is moved forward whenever it has
  // passed, so the preview always has one coming up. Fixed ids and
  // ON CONFLICT keep it idempotent across rebuilds; everyone in it is a
  // fake identity. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO potlucks (id, title, starts_at, place, host_id, host_name)
      VALUES (900001, 'Staging demo potluck', date_trunc('day', NOW()) + INTERVAL '9 days 18 hours',
              'Staging demo place', 0, 'staging-demo-user')
      ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at WHERE potlucks.starts_at < NOW()
    `);
    await pool.query(`
      INSERT INTO potluck_dishes (id, potluck_id, course, dish, bringer_id, bringer_name)
      VALUES
        (900001, 900001, 'Mains', 'Staging demo lasagna', 0, 'staging-demo-user'),
        (900002, 900001, 'Sides', 'Staging demo roast potatoes', -1, 'staging-demo-ana'),
        (900003, 900001, 'Salads', 'Staging demo green salad', -2, 'staging-demo-ben'),
        (900004, 900001, 'Salads', 'Staging demo bean salad', -3, 'staging-demo-cy')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // Potlucks coming up (soonest first, each with its dishes by course) and
  // the last few that have passed.
  app.get('/api/potlucks', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const cutoff = new Date(req.now.getTime() - STILL_ON_MS);
      const { rows: upcoming } = await pool.query(
        `SELECT id, title, starts_at, place, host_id, host_name FROM potlucks
          WHERE starts_at >= $1 ORDER BY starts_at, id LIMIT 50`,
        [cutoff]
      );
      const { rows: past } = await pool.query(
        `SELECT id, title, starts_at, place, host_id, host_name FROM potlucks
          WHERE starts_at < $1 ORDER BY starts_at DESC, id DESC LIMIT $2`,
        [cutoff, PAST_SHOWN]
      );
      const ids = upcoming.concat(past).map((p) => p.id);
      const { rows: dishes } = ids.length
        ? await pool.query(
          `SELECT id, potluck_id, course, dish, bringer_id, bringer_name FROM potluck_dishes
            WHERE potluck_id = ANY($1::int[]) ORDER BY created_at, id`,
          [ids]
        )
        : { rows: [] };
      const shape = (p) => {
        const own = dishes.filter((d) => d.potluck_id === p.id);
        return {
          id: p.id,
          title: p.title,
          startsAt: p.starts_at.toISOString(),
          place: p.place,
          host: p.host_name,
          mine: p.host_id === me,
          dishes: own.length,
          courses: COURSES.map((course) => ({
            course,
            dishes: own.filter((d) => d.course === course).map((d) => ({
              id: d.id,
              dish: d.dish,
              by: d.bringer_name,
              mine: d.bringer_id === me,
              canRemove: d.bringer_id === me || p.host_id === me,
            })),
          })),
        };
      };
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        courses: COURSES,
        upcoming: upcoming.map(shape),
        past: past.map(shape),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Plan one: a name, when it starts (an ISO time the page builds from the
  // planner's own date and time) and, if they like, where.
  app.post('/api/potlucks', async (req, res) => {
    const title = cleanText(req.body && req.body.title, TITLE_MAX);
    const place = cleanText(req.body && req.body.place, PLACE_MAX) || null;
    const startsAt = new Date(req.body && req.body.startsAt);
    if (!title) return res.status(400).json({ error: 'Give the potluck a name.' });
    if (Number.isNaN(startsAt.getTime())) return res.status(400).json({ error: 'Pick a date and a time.' });
    if (startsAt.getTime() < req.now.getTime() - HOUR_MS) return res.status(400).json({ error: 'That time has already passed.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO potlucks (title, starts_at, place, host_id, host_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [title, startsAt, place, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever planned it can call it off.
  app.delete('/api/potlucks/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That potluck is not planned any more.' });
    try {
      const { rowCount } = await pool.query('DELETE FROM potlucks WHERE id = $1 AND host_id = $2', [id, req.user.id]);
      if (!rowCount) return res.status(403).json({ error: 'Only the person who planned it can call it off.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Say what you are bringing, and which course it is.
  app.post('/api/potlucks/:id/dishes', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That potluck is not planned any more.' });
    const dish = cleanText(req.body && req.body.dish, DISH_MAX);
    const course = req.body && req.body.course;
    if (!dish) return res.status(400).json({ error: 'Say what you are bringing.' });
    if (!COURSES.includes(course)) return res.status(400).json({ error: 'Pick a course.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO potluck_dishes (potluck_id, course, dish, bringer_id, bringer_name, created_at)
         SELECT id, $2, $3, $4, $5, $6 FROM potlucks WHERE id = $1
         RETURNING id`,
        [id, course, dish, req.user.id, req.user.username, req.now]
      );
      if (!rows.length) return res.status(404).json({ error: 'That potluck is not planned any more.' });
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever is bringing it, or the host, can take a dish off.
  app.delete('/api/dishes/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That dish is not on the list any more.' });
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM potluck_dishes d USING potlucks p
          WHERE d.id = $1 AND p.id = d.potluck_id AND (d.bringer_id = $2 OR p.host_id = $2)`,
        [id, req.user.id]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only whoever is bringing it, or the host, can take it off.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
