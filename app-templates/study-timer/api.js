// This app's API: a 25 minute focus timer, and the count of the sessions
// each person finished today.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user). "Now" is req.now, never new Date() or SQL's
// NOW(), wherever it is stored or shown.
//
// It came from Homeroom's ready-made Study timer. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The staging conventions ask every app to seed obviously fake demo rows a
// staging preview can show. This app seeds none, on purpose: its only data
// is each viewer's own count of finished sessions, and those conventions
// forbid seeding rows the viewer owns. A preview's Today card starts empty,
// which is the honest state for it. (IS_STAGING stays declared so a first
// build that does add a staging path starts from the usual shape.)

const KEY_SHAPE = /^[A-Za-z0-9-]{8,40}$/;

/** The zone a device reported ("Europe/Berlin"), or UTC when it sent
 * nothing, something too long to be one, or a name this browser does not
 * know. Never trust it further than a Date accepts. */
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

/** How many of this person's sessions were finished on the day `now` falls
 * on, where they are. The count is each person's own: nobody sees anybody
 * else's. */
const TODAY_SQL = `
  SELECT COUNT(*)::int AS count
    FROM study_sessions
   WHERE user_id = $1
     AND (finished_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date
`;

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

async function migrate(pool) {
  // One row per finished session. `client_key` is made by the page when the
  // session starts, and UNIQUE (user_id, client_key) makes the POST
  // idempotent: a retry on a bad connection never counts a session twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      client_key VARCHAR(40) NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      UNIQUE (user_id, client_key)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS study_sessions_user_time ON study_sessions (user_id, finished_at)');
  // Each person's own study record: never copied into a staging preview.
  await pool.query("COMMENT ON TABLE study_sessions IS 'staging:private'");
}

function routes(app, pool) {
  // Your count for today. A guest gets no count: the page asks them to make
  // an account to keep one.
  app.get('/api/today', async (req, res) => {
    const zone = zoneOf(req.query.tz);
    try {
      const me = req.user ? req.user.id : null;
      if (!me) return res.json({ me: null, count: 0 });
      const { rows } = await pool.query(TODAY_SQL, [me, zone, req.now]);
      res.json({ me: req.user ? { id: me, username: req.user.username } : null, day: localDay(req.now, zone), count: rows[0].count });
    } catch (err) {
      fail(res, err);
    }
  });

  // A session that ran out. The page sends the key it made when the session
  // started; the same key twice is one session, so a retry counts once.
  app.post('/api/sessions', async (req, res) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key : '';
    if (!KEY_SHAPE.test(key)) return res.status(400).json({ error: 'That session could not be counted.' });
    const zone = zoneOf(body.tz);
    try {
      await pool.query(
        `INSERT INTO study_sessions (user_id, username, client_key, finished_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, client_key) DO NOTHING`,
        [req.user.id, req.user.username, key, req.now]
      );
      const { rows } = await pool.query(TODAY_SQL, [req.user.id, zone, req.now]);
      res.status(201).json({ me: { id: req.user.id, username: req.user.username }, day: localDay(req.now, zone), count: rows[0].count });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
