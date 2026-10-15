// This app's API: a lending library of things members can lend each other.
// Each thing has an owner and, at any moment, somebody who has it: its owner,
// or whoever it was last handed to. Nobody sets a due date. Instead, anyone
// can ask for a thing, and whoever has it hands it on to someone who asked;
// its owner can always say it is back with them.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user). "Now" is req.now, never new Date() or SQL's
// NOW(), wherever it is stored or shown.
//
// It came from Homeroom's ready-made lending library. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 80;
const NOTE_MAX = 120;
const THINGS_SHOWN = 500;

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

const GONE = 'That is not in the library any more.';

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      note VARCHAR(${NOTE_MAX}),
      owner_id INTEGER NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      holder_id INTEGER NOT NULL,
      holder_name VARCHAR(255) NOT NULL,
      held_since TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  // Who has asked for each thing, first come first served.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_requests (
      item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      asked_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (item_id, user_id)
    )
  `);

  // A staging preview starts with no rows, so seed a few obviously fake
  // ones for the checks in dapp.json to find: things on their owners'
  // shelves, one with somebody else, and one that somebody asked for, all
  // fake identities. Fixed ids and ON CONFLICT keep it idempotent across
  // rebuilds. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO library_items (id, name, note, owner_id, owner_name, holder_id, holder_name, held_since, created_at)
      VALUES
        (900001, 'Staging demo drill', 'Bits are in the case', 0, 'staging-demo-user', 0, 'staging-demo-user', NOW(), NOW()),
        (900002, 'Staging demo tent', 'Sleeps four', 0, 'staging-demo-user', -1, 'staging-demo-ana', NOW() - INTERVAL '3 days', NOW()),
        (900003, 'Staging demo board game', NULL, -1, 'staging-demo-ana', -1, 'staging-demo-ana', NOW(), NOW()),
        (900004, 'Staging demo ladder', NULL, -1, 'staging-demo-ana', 0, 'staging-demo-user', NOW() - INTERVAL '9 days', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO library_requests (item_id, user_id, username, asked_at)
      VALUES (900002, -2, 'staging-demo-ben', NOW())
      ON CONFLICT DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // Every thing, with who has it and who has asked for it. Things you have
  // that somebody asked for come first, then everything else you have, then
  // the rest by name.
  app.get('/api/things', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `SELECT id, name, note, owner_id, owner_name, holder_id, holder_name, held_since
           FROM library_items ORDER BY LOWER(name), id LIMIT $1`,
        [THINGS_SHOWN]
      );
      const { rows: asks } = await pool.query(
        'SELECT item_id, user_id, username FROM library_requests ORDER BY asked_at, user_id'
      );
      const things = rows.map((r) => {
        const line = asks.filter((a) => a.item_id === r.id);
        return {
          id: r.id,
          name: r.name,
          note: r.note,
          owner: r.owner_name,
          mine: r.owner_id === me,
          holder: r.holder_name,
          withMe: r.holder_id === me,
          atHome: r.holder_id === r.owner_id,
          since: r.held_since.toISOString(),
          asks: line.map((a) => ({ id: a.user_id, username: a.username, mine: a.user_id === me })),
          askedByMe: line.some((a) => a.user_id === me),
        };
      });
      const rank = (t) => (t.withMe && t.asks.length ? 0 : t.withMe ? 1 : 2);
      things.sort((a, b) => rank(a) - rank(b));
      res.json({ me: req.user ? { id: me, username: req.user.username } : null, now: req.now.toISOString(), things });
    } catch (err) {
      fail(res, err);
    }
  });

  // Something you can lend. It starts on your shelf.
  app.post('/api/things', async (req, res) => {
    const name = cleanText(req.body && req.body.name, NAME_MAX);
    const note = cleanText(req.body && req.body.note, NOTE_MAX) || null;
    if (!name) return res.status(400).json({ error: 'Say what you can lend.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO library_items (name, note, owner_id, owner_name, holder_id, holder_name, held_since, created_at)
         VALUES ($1, $2, $3, $4, $3, $4, $5, $5) RETURNING id`,
        [name, note, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Ask for it: you join the line of people who asked. Asking again does nothing.
  app.post('/api/things/:id/ask', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const { rows } = await pool.query('SELECT holder_id FROM library_items WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: GONE });
      if (rows[0].holder_id === req.user.id) return res.status(400).json({ error: 'You have it already.' });
      await pool.query(
        `INSERT INTO library_requests (item_id, user_id, username, asked_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [id, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Take your ask back.
  app.delete('/api/things/:id/ask', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      await pool.query('DELETE FROM library_requests WHERE item_id = $1 AND user_id = $2', [id, req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Hand it on to somebody who asked for it. Whoever has it does this (or
  // its owner, who may be lending it out from somebody else's hands).
  app.post('/api/things/:id/hand', async (req, res) => {
    const id = idParam(req);
    const to = Number(req.body && req.body.to);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const { rows } = await pool.query('SELECT owner_id, holder_id FROM library_items WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: GONE });
      if (rows[0].holder_id !== req.user.id && rows[0].owner_id !== req.user.id) {
        return res.status(403).json({ error: 'Only whoever has it, or its owner, can hand it on.' });
      }
      const { rows: asked } = await pool.query(
        'DELETE FROM library_requests WHERE item_id = $1 AND user_id = $2 RETURNING user_id, username', [id, to]);
      if (!asked.length) return res.status(400).json({ error: 'Hand it to somebody who asked for it.' });
      await pool.query(
        'UPDATE library_items SET holder_id = $2, holder_name = $3, held_since = $4 WHERE id = $1',
        [id, asked[0].user_id, asked[0].username, req.now]
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Back with its owner: the owner says so, or whoever has it gives it back.
  app.post('/api/things/:id/back', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const { rowCount } = await pool.query(
        `UPDATE library_items SET holder_id = owner_id, holder_name = owner_name, held_since = $3
          WHERE id = $1 AND holder_id <> owner_id AND (owner_id = $2 OR holder_id = $2)`,
        [id, req.user.id, req.now]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only its owner or whoever has it can say it is back.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Its owner can take a thing out of the library while it is with them.
  app.delete('/api/things/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM library_items WHERE id = $1 AND owner_id = $2 AND holder_id = owner_id',
        [id, req.user.id]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only its owner can take it out, once it is back with them.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
