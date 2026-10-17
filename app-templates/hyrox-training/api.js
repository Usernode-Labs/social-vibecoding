// This app's API: the Hyrox race's eight stations and eight runs, and a
// training log each person keeps for themselves.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user). "Now" is req.now, never new Date() or SQL's
// NOW(), wherever it is stored or shown.
//
// It came from Homeroom's ready-made Hyrox training app. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The staging conventions ask every app to seed obviously fake demo rows a
// staging preview can show. They are owned by a fake identity and kept out
// of every signed-in viewer's log: the log itself (user_id > 0) is private,
// so a preview starts empty for whoever opens it, which is the honest state.

// What can be logged, in the page's select's own order: the eight stations
// of the race, the 1 km run between them, and the whole race in one go.
const WORKOUTS = Object.freeze([
  'SkiErg',
  'Sled Push',
  'Sled Pull',
  'Burpee Broad Jumps',
  'Rowing',
  'Farmers Carry',
  'Sandbag Lunges',
  'Wall Balls',
  '1 km run',
  'Full race simulation',
]);

const NOTE_MAX = 200;

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

async function migrate(pool) {
  // One row per logged session. Every column a row needs, nothing more.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      workout VARCHAR(64) NOT NULL,
      minutes INTEGER NOT NULL,
      note VARCHAR(200) NOT NULL DEFAULT '',
      done_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS training_sessions_user_time ON training_sessions (user_id, done_at)');
  // Each person's own training record: never copied into a staging preview.
  await pool.query("COMMENT ON TABLE training_sessions IS 'staging:private'");
  // A staging preview's demo log, owned by a fake identity and always dated
  // back from the day it runs, so the week reads as ordinary. Refreshed on
  // every staging boot so the dates keep up; production seeds none.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO training_sessions (id, user_id, username, workout, minutes, note, done_at)
      VALUES
        (900001, 0, 'staging-demo-user', 'Wall Balls', 45, 'Staging demo session', date_trunc('day', NOW()) - INTERVAL '1 day' + INTERVAL '18 hours'),
        (900002, 0, 'staging-demo-user', 'Sled Push', 30, 'Staging demo practice', date_trunc('day', NOW()) - INTERVAL '3 days' + INTERVAL '7 hours'),
        (900003, 0, 'staging-demo-user', 'Full race simulation', 85, 'Staging demo race', date_trunc('day', NOW()) - INTERVAL '6 days' + INTERVAL '9 hours')
      ON CONFLICT (id) DO UPDATE SET done_at = EXCLUDED.done_at
    `);
  }
}

function routes(app, pool) {
  // Your log: the sessions you have put in, latest first, and how today and
  // this week add up. A guest gets an empty log: the page asks them to make
  // an account to keep one.
  app.get('/api/sessions', async (req, res) => {
    const zone = typeof req.query.tz === 'string' && req.query.tz.length <= 64 ? req.query.tz : 'UTC';
    const me = req.user ? req.user.id : null;
    try {
      if (!me) return res.json({ me: null, today: null, week: null, sessions: [] });
      const counts = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE (done_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date)::int AS today_count,
           COALESCE(SUM(minutes) FILTER (WHERE (done_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date), 0)::int AS today_minutes,
           COUNT(*) FILTER (WHERE date_trunc('week', done_at AT TIME ZONE $2) = date_trunc('week', $3::timestamptz AT TIME ZONE $2))::int AS week_count,
           COALESCE(SUM(minutes) FILTER (WHERE date_trunc('week', done_at AT TIME ZONE $2) = date_trunc('week', $3::timestamptz AT TIME ZONE $2)), 0)::int AS week_minutes
         FROM training_sessions WHERE user_id = $1`,
        [me, zone, req.now]
      );
      const { rows } = await pool.query(
        `SELECT id, workout, minutes, note, done_at
           FROM training_sessions
          WHERE user_id = $1
          ORDER BY done_at DESC, id DESC
          LIMIT 15`,
        [me]
      );
      res.json({
        me: { id: me, username: req.user ? req.user.username : null },
        today: { count: counts.rows[0].today_count, minutes: counts.rows[0].today_minutes },
        week: { count: counts.rows[0].week_count, minutes: counts.rows[0].week_minutes },
        sessions: rows.map((row) => ({ id: row.id, workout: row.workout, minutes: row.minutes, note: row.note, doneAt: row.done_at })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // A session put in. The workout is one of the list above, the minutes a
  // whole number from 1 to 600, and the note at most 200 characters.
  app.post('/api/sessions', async (req, res) => {
    const body = req.body || {};
    const workout = WORKOUTS.indexOf(body.workout) === -1 ? null : body.workout;
    const minutes = typeof body.minutes === 'number' && Number.isInteger(body.minutes) ? body.minutes : NaN;
    const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
    if (!workout || Number.isNaN(minutes) || minutes < 1 || minutes > 600) {
      return res.status(400).json({ error: 'Pick what you trained and how many minutes it took.' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO training_sessions (user_id, username, workout, minutes, note, done_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, workout, minutes, note, done_at`,
        [req.user.id, req.user.username, workout, minutes, note, req.now]
      );
      const row = rows[0];
      res.status(201).json({ id: row.id, workout: row.workout, minutes: row.minutes, note: row.note, doneAt: row.done_at });
    } catch (err) {
      fail(res, err);
    }
  });

  // Taking your own session back. Only yours: the WHERE clause carries the
  // id and the person together.
  app.delete('/api/sessions/:id', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'That session could not be found.' });
    try {
      await pool.query('DELETE FROM training_sessions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
