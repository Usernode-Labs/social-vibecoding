// This app's API: potlucks, each with a date, a time and a place, who is
// bringing what by course, reactions and comments on each dish, and a chat
// for each potluck. server.js mounts it after the sign-in check: a
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
// The reactions a dish can get. A short, fixed set keeps them readable.
const REACTIONS = ['😋', '🤤', '👏', '❤️', '🔥'];
const COMMENT_MAX = 280;
const MESSAGE_MAX = 500;
const MESSAGES_SHOWN = 50;

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS potluck_reactions (
      dish_id INTEGER NOT NULL REFERENCES potluck_dishes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      emoji VARCHAR(8) NOT NULL,
      PRIMARY KEY (dish_id, user_id, emoji)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS potluck_comments (
      id SERIAL PRIMARY KEY,
      dish_id INTEGER NOT NULL REFERENCES potluck_dishes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      text VARCHAR(${COMMENT_MAX}) NOT NULL,
      at TIMESTAMPTZ NOT NULL
    )
  `);
  // Each potluck's own chat: who is coming, what to bring, where to park.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS potluck_messages (
      id SERIAL PRIMARY KEY,
      potluck_id INTEGER NOT NULL REFERENCES potlucks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      text VARCHAR(${MESSAGE_MAX}) NOT NULL,
      at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS potluck_messages_potluck_idx ON potluck_messages (potluck_id, at)');

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
    await pool.query(`
      INSERT INTO potluck_reactions (dish_id, user_id, username, emoji)
      VALUES (900001, -1, 'staging-demo-ana', '😋'), (900001, -2, 'staging-demo-ben', '😋'), (900002, -3, 'staging-demo-cy', '🔥')
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      INSERT INTO potluck_comments (id, dish_id, user_id, username, text, at)
      VALUES (900001, 900001, -1, 'staging-demo-ana', 'Staging demo comment: the one with spinach?', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO potluck_messages (id, potluck_id, user_id, username, text, at)
      VALUES
        (900001, 900001, 0, 'staging-demo-user', 'Staging demo message: doors open at six.', NOW() - INTERVAL '1 hour'),
        (900002, 900001, -2, 'staging-demo-ben', 'Staging demo message: can someone bring ice?', NOW())
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
      const dishIds = dishes.map((d) => d.id);
      const { rows: reactions } = dishIds.length
        ? await pool.query(
          'SELECT dish_id, user_id, username, emoji FROM potluck_reactions WHERE dish_id = ANY($1::int[]) ORDER BY username',
          [dishIds])
        : { rows: [] };
      const { rows: comments } = dishIds.length
        ? await pool.query(
          'SELECT id, dish_id, user_id, username, text, at FROM potluck_comments WHERE dish_id = ANY($1::int[]) ORDER BY at, id',
          [dishIds])
        : { rows: [] };
      const { rows: messages } = upcoming.length
        ? await pool.query(
          `SELECT id, potluck_id, user_id, username, text, at FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY potluck_id ORDER BY at DESC, id DESC) AS n
               FROM potluck_messages WHERE potluck_id = ANY($1::int[])) m
            WHERE n <= $2 ORDER BY at, id`,
          [upcoming.map((p) => p.id), MESSAGES_SHOWN])
        : { rows: [] };
      const reactionsOf = (dishId) => REACTIONS.map((emoji) => {
        const these = reactions.filter((r) => r.dish_id === dishId && r.emoji === emoji);
        return { emoji, count: these.length, mine: these.some((r) => r.user_id === me), people: these.map((r) => r.username) };
      }).filter((r) => r.count);
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
              reactions: reactionsOf(d.id),
              comments: comments.filter((c) => c.dish_id === d.id).map((c) => ({
                id: c.id, by: c.username, mine: c.user_id === me, text: c.text, at: c.at.toISOString(),
              })),
            })),
          })),
          messages: messages.filter((m) => m.potluck_id === p.id).map((m) => ({
            id: m.id, by: m.username, mine: m.user_id === me, text: m.text, at: m.at.toISOString(),
          })),
        };
      };
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        courses: COURSES,
        reactions: REACTIONS,
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

  // React to a dish, or take your reaction back: the same call toggles it.
  app.post('/api/dishes/:id/reactions', async (req, res) => {
    const id = idParam(req);
    const emoji = req.body && req.body.emoji;
    if (!id) return res.status(404).json({ error: 'That dish is not on the list any more.' });
    if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Pick one of the reactions.' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM potluck_reactions WHERE dish_id = $1 AND user_id = $2 AND emoji = $3', [id, req.user.id, emoji]);
      if (rowCount) return res.json({ on: false });
      const { rows } = await pool.query(
        `INSERT INTO potluck_reactions (dish_id, user_id, username, emoji)
         SELECT id, $2, $3, $4 FROM potluck_dishes WHERE id = $1 RETURNING dish_id`,
        [id, req.user.id, req.user.username, emoji]
      );
      if (!rows.length) return res.status(404).json({ error: 'That dish is not on the list any more.' });
      res.json({ on: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // A comment on a dish: "the one with spinach?"
  app.post('/api/dishes/:id/comments', async (req, res) => {
    const id = idParam(req);
    const text = cleanText(req.body && req.body.text, COMMENT_MAX);
    if (!id) return res.status(404).json({ error: 'That dish is not on the list any more.' });
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO potluck_comments (dish_id, user_id, username, text, at)
         SELECT id, $2, $3, $4, $5 FROM potluck_dishes WHERE id = $1 RETURNING id`,
        [id, req.user.id, req.user.username, text, req.now]
      );
      if (!rows.length) return res.status(404).json({ error: 'That dish is not on the list any more.' });
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // A message in a potluck's chat.
  app.post('/api/potlucks/:id/messages', async (req, res) => {
    const id = idParam(req);
    const text = cleanText(req.body && req.body.text, MESSAGE_MAX);
    if (!id) return res.status(404).json({ error: 'That potluck is not planned any more.' });
    if (!text) return res.status(400).json({ error: 'Write a message first.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO potluck_messages (potluck_id, user_id, username, text, at)
         SELECT id, $2, $3, $4, $5 FROM potlucks WHERE id = $1 RETURNING id`,
        [id, req.user.id, req.user.username, text, req.now]
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
