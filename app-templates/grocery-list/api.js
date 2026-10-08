// This app's API: one shared grocery list, sorted into aisles. Anyone in the
// project adds what is needed; whoever is at the store ticks things off, and
// they stay where they are, struck through, until the bought ones are
// cleared. The aisles can be renamed, added, removed and put in the order the
// group's store is laid out. A short activity log says who did what.
//
// Aisles, items that stay in place when ticked, and the activity line come
// from Homeroom's Todo List app, cut down to one list for one group.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user). "Now" is req.now, never new Date() or SQL's
// NOW(), wherever it is stored or shown.
//
// It came from Homeroom's ready-made grocery list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 80;
const NOTE_MAX = 80;
const AISLE_MAX = 40;
const ITEMS_SHOWN = 500;
const ACTIVITY_SHOWN = 12;

// A new list's aisles, in a typical store's order. Change them in the app.
const DEFAULT_AISLES = ['Produce', 'Bakery', 'Dairy & eggs', 'Meat & fish', 'Pantry', 'Frozen', 'Drinks', 'Household'];

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
    CREATE TABLE IF NOT EXISTS grocery_aisles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${AISLE_MAX}) NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      note VARCHAR(${NOTE_MAX}),
      aisle_id INTEGER REFERENCES grocery_aisles(id) ON DELETE SET NULL,
      added_by INTEGER NOT NULL,
      added_by_name VARCHAR(255) NOT NULL,
      added_at TIMESTAMPTZ NOT NULL,
      bought_by_name VARCHAR(255),
      bought_at TIMESTAMPTZ
    )
  `);
  // Who did what, newest first on screen. It outlives the items it names.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_events (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER NOT NULL,
      actor_name VARCHAR(255) NOT NULL,
      verb VARCHAR(12) NOT NULL,
      text VARCHAR(120) NOT NULL,
      at TIMESTAMPTZ NOT NULL
    )
  `);
  // A new list starts with the usual aisles (once: an empty table only).
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM grocery_aisles');
  if (!rows[0].n) {
    for (const [i, name] of DEFAULT_AISLES.entries()) {
      await pool.query('INSERT INTO grocery_aisles (name, position) VALUES ($1, $2)', [name, i + 1]);
    }
  }

  // A staging preview starts with no items, so seed a few obviously fake
  // ones for the checks in dapp.json to find: some needed, one bought, in
  // their aisles. Fixed ids and ON CONFLICT keep it idempotent across
  // rebuilds; the people are fake identities. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO grocery_items (id, name, note, aisle_id, added_by, added_by_name, added_at, bought_by_name, bought_at)
      VALUES
        (900001, 'Staging demo milk', '2 cartons', (SELECT id FROM grocery_aisles WHERE name = 'Dairy & eggs' LIMIT 1), 0, 'staging-demo-user', NOW(), NULL, NULL),
        (900002, 'Staging demo bread', NULL, (SELECT id FROM grocery_aisles WHERE name = 'Bakery' LIMIT 1), 0, 'staging-demo-user', NOW(), NULL, NULL),
        (900003, 'Staging demo apples', 'the crunchy kind', (SELECT id FROM grocery_aisles WHERE name = 'Produce' LIMIT 1), -1, 'staging-demo-ana', NOW(), NULL, NULL),
        (900004, 'Staging demo bananas', NULL, (SELECT id FROM grocery_aisles WHERE name = 'Produce' LIMIT 1), -1, 'staging-demo-ana', NOW(), 'staging-demo-user', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO grocery_events (id, actor_id, actor_name, verb, text, at)
      VALUES (900001, -1, 'staging-demo-ana', 'bought', 'Staging demo bananas', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function record(pool, req, verb, text) {
  await pool.query(
    'INSERT INTO grocery_events (actor_id, actor_name, verb, text, at) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, req.user.username, verb, String(text).slice(0, 120), req.now]
  );
}

/** The aisle id a body names, if it is one; null puts the item under Other. */
async function aisleOf(pool, value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query('SELECT id FROM grocery_aisles WHERE id = $1', [id]);
  return rows.length ? id : null;
}

function routes(app, pool) {
  // The whole list, aisle by aisle in the store's order (anything without an
  // aisle last, as Other), each aisle's items in the order they were asked
  // for. A bought item stays where it is until it is cleared.
  app.get('/api/list', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows: aisles } = await pool.query('SELECT id, name FROM grocery_aisles ORDER BY position, id');
      const { rows: items } = await pool.query(
        `SELECT id, name, note, aisle_id, added_by, added_by_name, bought_by_name, bought_at
           FROM grocery_items ORDER BY added_at, id LIMIT $1`,
        [ITEMS_SHOWN]
      );
      const { rows: events } = await pool.query(
        'SELECT actor_id, actor_name, verb, text, at FROM grocery_events ORDER BY at DESC, id DESC LIMIT $1',
        [ACTIVITY_SHOWN]
      );
      const shape = (r) => ({
        id: r.id,
        name: r.name,
        note: r.note,
        aisleId: r.aisle_id,
        by: r.added_by_name,
        mine: r.added_by === me,
        bought: !!r.bought_at,
        boughtBy: r.bought_by_name,
      });
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        aisles: aisles.map((a) => ({ id: a.id, name: a.name, items: items.filter((i) => i.aisle_id === a.id).map(shape) })),
        other: items.filter((i) => i.aisle_id === null).map(shape),
        activity: events.map((e) => ({ by: e.actor_name, mine: e.actor_id === me, verb: e.verb, text: e.text, at: e.at.toISOString() })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Add something. If it is already on the list and not bought yet, the list
  // keeps the one it has (the note is added to it if it had none).
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
      const aisleId = await aisleOf(pool, req.body && req.body.aisleId);
      const { rows } = await pool.query(
        `INSERT INTO grocery_items (name, note, aisle_id, added_by, added_by_name, added_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, note, aisleId, req.user.id, req.user.username, req.now]
      );
      await record(pool, req, 'added', name);
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Change an item: tick it off or back (bought), or edit its name, note or aisle.
  app.patch('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not on the list any more.' });
    const body = req.body || {};
    try {
      const { rows: found } = await pool.query('SELECT name, bought_at FROM grocery_items WHERE id = $1', [id]);
      if (!found.length) return res.status(404).json({ error: 'That is not on the list any more.' });
      if (Object.prototype.hasOwnProperty.call(body, 'bought')) {
        const bought = !!body.bought;
        await pool.query(
          `UPDATE grocery_items
              SET bought_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END,
                  bought_by_name = CASE WHEN $2 THEN $3 ELSE NULL END
            WHERE id = $1`,
          [id, bought, req.user.username, req.now]
        );
        if (bought && !found[0].bought_at) await record(pool, req, 'bought', found[0].name);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = cleanText(body.name, NAME_MAX);
        if (!name) return res.status(400).json({ error: 'An item needs a name.' });
        await pool.query('UPDATE grocery_items SET name = $2 WHERE id = $1', [id, name]);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'note')) {
        await pool.query('UPDATE grocery_items SET note = $2 WHERE id = $1', [id, cleanText(body.note, NOTE_MAX) || null]);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'aisleId')) {
        await pool.query('UPDATE grocery_items SET aisle_id = $2 WHERE id = $1', [id, await aisleOf(pool, body.aisleId)]);
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Anyone can take an item off the list: it is one shared list.
  app.delete('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not on the list any more.' });
    try {
      const { rows } = await pool.query('DELETE FROM grocery_items WHERE id = $1 RETURNING name', [id]);
      if (rows.length) await record(pool, req, 'removed', rows[0].name);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Clear everything bought, once the shopping is put away.
  app.post('/api/items/clear-bought', async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM grocery_items WHERE bought_at IS NOT NULL');
      if (rowCount) await record(pool, req, 'cleared', `${rowCount} bought ${rowCount === 1 ? 'item' : 'items'}`);
      res.json({ cleared: rowCount });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Aisles ───────────────────────────────────────────────────────────────

  app.post('/api/aisles', async (req, res) => {
    const name = cleanText(req.body && req.body.name, AISLE_MAX);
    if (!name) return res.status(400).json({ error: 'Give the aisle a name.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO grocery_aisles (name, position)
         VALUES ($1, COALESCE((SELECT MAX(position) FROM grocery_aisles), 0) + 1) RETURNING id`,
        [name]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch('/api/aisles/:id', async (req, res) => {
    const id = idParam(req);
    const name = cleanText(req.body && req.body.name, AISLE_MAX);
    if (!id) return res.status(404).json({ error: 'That aisle is gone.' });
    if (!name) return res.status(400).json({ error: 'Give the aisle a name.' });
    try {
      const { rowCount } = await pool.query('UPDATE grocery_aisles SET name = $2 WHERE id = $1', [id, name]);
      if (!rowCount) return res.status(404).json({ error: 'That aisle is gone.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Removing an aisle keeps its items: they move to Other.
  app.delete('/api/aisles/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That aisle is gone.' });
    try {
      await pool.query('DELETE FROM grocery_aisles WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // The store's order: every aisle id, first to last.
  app.post('/api/aisles/order', async (req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ error: 'Send the aisles in order.' });
    }
    try {
      await pool.query(
        `UPDATE grocery_aisles a SET position = x.ord
           FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
          WHERE a.id = x.id`,
        [ids]
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
