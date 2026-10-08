// This app's API: one shared grocery list. Anyone in the project adds what
// is needed, whoever is at the store ticks things off, and the bought ones
// are cleared when the shopping is done. server.js mounts it after the
// sign-in check: a write always has req.user ({ id, username }); a read may
// come from a guest with no account (req.guest, no req.user).
//
// It came from Homeroom's ready-made grocery list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 80;
const NOTE_MAX = 80;
const ITEMS_SHOWN = 500;

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
    CREATE TABLE IF NOT EXISTS grocery_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      note VARCHAR(${NOTE_MAX}),
      added_by INTEGER NOT NULL,
      added_by_name VARCHAR(255) NOT NULL,
      added_at TIMESTAMPTZ NOT NULL,
      bought_by_name VARCHAR(255),
      bought_at TIMESTAMPTZ
    )
  `);

  // A staging preview starts with no rows, so seed a few obviously fake
  // ones for the checks in dapp.json to find: some needed, one bought.
  // Fixed ids and ON CONFLICT keep it idempotent across rebuilds; the owner
  // is a fake identity. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO grocery_items (id, name, note, added_by, added_by_name, added_at, bought_by_name, bought_at)
      VALUES
        (900001, 'Staging demo milk', '2 cartons', 0, 'staging-demo-user', NOW(), NULL, NULL),
        (900002, 'Staging demo bread', NULL, 0, 'staging-demo-user', NOW(), NULL, NULL),
        (900003, 'Staging demo apples', 'the crunchy kind', 0, 'staging-demo-user', NOW(), NULL, NULL),
        (900004, 'Staging demo coffee', NULL, 0, 'staging-demo-user', NOW(), 'staging-demo-user', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // The whole list: what is needed (oldest first, the order it was asked
  // for) and what has been bought (latest first).
  app.get('/api/items', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `SELECT id, name, note, added_by, added_by_name, bought_by_name, bought_at
           FROM grocery_items
          ORDER BY (bought_at IS NOT NULL), bought_at DESC, added_at, id
          LIMIT $1`,
        [ITEMS_SHOWN]
      );
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          note: r.note,
          by: r.added_by_name,
          mine: r.added_by === me,
          bought: !!r.bought_at,
          boughtBy: r.bought_by_name,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Add something. If it is already on the list and not bought yet, the
  // list keeps the one it has (the note is added to it if it had none).
  app.post('/api/items', async (req, res) => {
    const name = cleanText(req.body && req.body.name, NAME_MAX);
    const note = cleanText(req.body && req.body.note, NOTE_MAX) || null;
    if (!name) return res.status(400).json({ error: 'Say what is needed.' });
    try {
      const { rows: same } = await pool.query(
        `UPDATE grocery_items SET note = COALESCE(note, $2)
          WHERE id = (SELECT id FROM grocery_items WHERE LOWER(name) = LOWER($1) AND bought_at IS NULL
                       ORDER BY id LIMIT 1)
          RETURNING id`,
        [name, note]
      );
      if (same.length) return res.json({ id: same[0].id, already: true });
      const { rows } = await pool.query(
        `INSERT INTO grocery_items (name, note, added_by, added_by_name, added_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name, note, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Tick it off (bought: true) or put it back on the list (bought: false).
  app.put('/api/items/:id/bought', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not on the list any more.' });
    const bought = !!(req.body && req.body.bought);
    try {
      const { rowCount } = await pool.query(
        `UPDATE grocery_items
            SET bought_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END,
                bought_by_name = CASE WHEN $2 THEN $3 ELSE NULL END
          WHERE id = $1`,
        [id, bought, req.user.username, req.now]
      );
      if (!rowCount) return res.status(404).json({ error: 'That is not on the list any more.' });
      res.json({ bought });
    } catch (err) {
      fail(res, err);
    }
  });

  // Anyone can take an item off the list: it is one shared list.
  app.delete('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not on the list any more.' });
    try {
      await pool.query('DELETE FROM grocery_items WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Clear everything bought, once the shopping is put away.
  app.post('/api/items/clear-bought', async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM grocery_items WHERE bought_at IS NOT NULL');
      res.json({ cleared: rowCount });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
