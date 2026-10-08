// This app's API: one shared grocery list, working exactly as Homeroom's
// Todo List app works inside a list (usernode-bot/todo-list-b91765,
// server.js), for one list the whole project shares instead of many lists
// each shared by invitation. The list is named after the project.
//
// The rules it keeps from Todo List:
//   - Categories, with an invisible "General" bucket (is_default) pinned
//     first. Every list keeps at least one category; deleting one deletes its
//     items.
//   - A new item goes to the TOP of its category. Quick-add puts it in
//     General.
//   - Ticking keeps an item's sort_order, so its rank in its section survives
//     a tick and untick. Items are read unticked first, then ticked, each by
//     sort_order. Ticking or unticking records who did it (last_checked_by).
//   - Moving an item to another category puts it at that category's end.
//   - Due dates and times are opt-in for the list, stored as wall-clock
//     values; clearing the date clears the time; switching due dates off
//     keeps them.
//   - Removing an item records who removed what, so the activity line can
//     say so after the item is gone.
//   - The activity line is the latest thing somebody else did in the last
//     week: ticked, added or removed.
//   - Creates carry an idempotency key (client_op_id), so a retried add never
//     makes a second row.
//   - Markdown import adds to the list or replaces it.
// Todo List streams changes over server-sent events; this app's screen asks
// again every few seconds instead, because an always-open connection keeps
// the platform's check runner from ever seeing the page idle.
//
// server.js mounts it after the sign-in check: a write always has req.user
// ({ id, username }); a read may come from a guest with no account
// (req.guest, no req.user). "Now" is req.now, never new Date() or SQL's
// NOW(), wherever it is stored or compared.
//
// It came from Homeroom's ready-made grocery list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TEXT_MAX = 500;
const NAME_MAX = 100;
const MAX_IMPORT_CATS = 200;
const MAX_IMPORT_ITEMS = 3000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Idempotency key for item creates: a short, safe token, or nothing.
const CLIENT_OP_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
function clientOpId(body) {
  const v = body && body.client_op_id;
  return typeof v === 'string' && CLIENT_OP_ID_RE.test(v) ? v : null;
}

async function migrate(pool) {
  // The list itself: whether it has due dates. One row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_list (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      due_dates_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      examples_offered BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query('INSERT INTO grocery_list (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES grocery_categories(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      last_checked_by VARCHAR(255),
      client_op_id VARCHAR(64),
      due_date DATE,
      due_time TIME,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS grocery_items_category_idx ON grocery_items (category_id)');
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS grocery_items_client_op_id_key
    ON grocery_items (client_op_id) WHERE client_op_id IS NOT NULL`);
  // Who removed what; it outlives the item row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grocery_events (
      id SERIAL PRIMARY KEY,
      actor VARCHAR(255) NOT NULL,
      text TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Every list has its General bucket.
  const { rows } = await pool.query('SELECT 1 FROM grocery_categories WHERE is_default LIMIT 1');
  if (!rows.length) {
    await pool.query(`INSERT INTO grocery_categories (name, is_default, sort_order) VALUES ('General', TRUE, 0)`);
  }

  // A staging preview gets a populated list for the checks in dapp.json and
  // the people reviewing it: categories (one of them empty, one finished),
  // ticked rows in place, and somebody else's tick for the activity line.
  // All obviously fake; fixed ids and ON CONFLICT keep it idempotent. Never
  // runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO grocery_categories (id, name, is_default, sort_order) VALUES
        (900001, 'Staging demo produce', FALSE, 1),
        (900002, 'Staging demo dairy', FALSE, 2),
        (900003, 'Staging demo household', FALSE, 3)
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO grocery_items (id, category_id, text, checked, sort_order, completed_at, created_by, last_checked_by) VALUES
        (900001, (SELECT id FROM grocery_categories WHERE is_default LIMIT 1), 'Staging demo coffee', FALSE, 1, NULL, 'staging-demo-user', NULL),
        (900002, 900001, 'Staging demo apples', FALSE, 1, NULL, 'staging-demo-user', NULL),
        (900003, 900001, 'Staging demo bananas', TRUE, 2, NOW(), 'staging-demo-user', 'staging-demo-ana'),
        (900004, 900001, 'Staging demo spinach', FALSE, 3, NULL, 'staging-demo-ana', NULL),
        (900005, 900002, 'Staging demo milk', TRUE, 1, NOW(), 'staging-demo-user', 'staging-demo-user')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

// First run: a list nobody has used yet starts with a few example items in
// General, ticked in place (Bread), attributed to whoever opened it first so
// no "@someone" activity shows for them. Offered once: delete them and they
// do not come back.
async function offerExamples(pool, req) {
  if (!req.user) return;
  const { rows } = await pool.query(
    'UPDATE grocery_list SET examples_offered = TRUE WHERE id = 1 AND NOT examples_offered RETURNING id');
  if (!rows.length) return;
  const { rows: any } = await pool.query('SELECT 1 FROM grocery_items LIMIT 1');
  if (any.length) return;
  const general = await defaultCategory(pool);
  await pool.query(
    `INSERT INTO grocery_items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by) VALUES
       ($1, 'Milk', FALSE, 1, NULL, $2, NULL),
       ($1, 'Eggs', FALSE, 2, NULL, $2, NULL),
       ($1, 'Bread', TRUE, 3, $3, $2, $2),
       ($1, 'Coffee', FALSE, 4, NULL, $2, NULL)`,
    [general.id, req.user.username, req.now]
  );
}

// The General bucket, made again if it was ever deleted.
async function defaultCategory(pool) {
  const { rows } = await pool.query('SELECT * FROM grocery_categories WHERE is_default ORDER BY id LIMIT 1');
  if (rows.length) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO grocery_categories (name, is_default, sort_order) VALUES ('General', TRUE, 0) RETURNING *`);
  return created[0];
}

const ITEM_COLUMNS = `id, category_id, text, checked, sort_order, completed_at, created_by, last_checked_by,
  to_char(due_date, 'YYYY-MM-DD') AS due_date, to_char(due_time, 'HH24:MI') AS due_time`;

async function insertItem(pool, req, categoryId) {
  const value = text(req.body && req.body.text, TEXT_MAX);
  if (!value) return { status: 400, body: { error: 'Item text is required' } };
  const opId = clientOpId(req.body);
  if (opId) {
    const { rows } = await pool.query(`SELECT ${ITEM_COLUMNS} FROM grocery_items WHERE client_op_id = $1`, [opId]);
    if (rows.length) return { status: 200, body: { item: rows[0] } };
  }
  const { rows } = await pool.query(
    `INSERT INTO grocery_items (category_id, text, checked, sort_order, created_by, client_op_id, created_at)
     VALUES ($1, $2, FALSE, COALESCE((SELECT MIN(sort_order) FROM grocery_items WHERE category_id = $1), 1) - 1, $3, $4, $5)
     RETURNING id`,
    [categoryId, value, req.user.username, opId, req.now]
  );
  const { rows: item } = await pool.query(`SELECT ${ITEM_COLUMNS} FROM grocery_items WHERE id = $1`, [rows[0].id]);
  return { status: 200, body: { item: item[0] } };
}

function routes(app, pool) {
  // The whole list: its settings, categories (General first, then by
  // sort_order), items (unticked first, then ticked, each by sort_order) and
  // the latest thing somebody else did this week.
  app.get('/api/list', async (req, res) => {
    try {
      await offerExamples(pool, req);
      const me = req.user ? req.user.username : null;
      const weekAgo = new Date(req.now.getTime() - WEEK_MS);
      const [list, cats, items, activity] = await Promise.all([
        pool.query('SELECT due_dates_enabled FROM grocery_list WHERE id = 1'),
        pool.query('SELECT id, name, is_default, sort_order FROM grocery_categories ORDER BY is_default DESC, sort_order, id'),
        pool.query(`SELECT ${ITEM_COLUMNS} FROM grocery_items ORDER BY checked, sort_order, id`),
        pool.query(
          `SELECT actor, verb, text FROM (
             SELECT last_checked_by AS actor, 'checked' AS verb, text, completed_at AS at FROM grocery_items
              WHERE checked AND last_checked_by IS NOT NULL AND LOWER(last_checked_by) <> LOWER($1) AND completed_at > $2
             UNION ALL
             SELECT created_by AS actor, 'added' AS verb, text, created_at AS at FROM grocery_items
              WHERE created_by IS NOT NULL AND LOWER(created_by) <> LOWER($1) AND created_at > $2
             UNION ALL
             SELECT actor, 'removed' AS verb, text, removed_at AS at FROM grocery_events
              WHERE LOWER(actor) <> LOWER($1) AND removed_at > $2
           ) x ORDER BY at DESC LIMIT 1`,
          [me || '', weekAgo]
        ),
      ]);
      res.json({
        me: req.user ? { id: req.user.id, username: req.user.username } : null,
        now: req.now.toISOString(),
        list: { due_dates_enabled: list.rows[0].due_dates_enabled },
        categories: cats.rows,
        items: items.rows,
        activity: activity.rows[0] || null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Switch due dates on or off. Switching them off keeps the dates, so
  // switching back on restores them.
  app.patch('/api/list', async (req, res) => {
    const body = req.body || {};
    if (typeof body.due_dates_enabled !== 'boolean') return res.status(400).json({ error: 'Nothing to update' });
    try {
      await pool.query('UPDATE grocery_list SET due_dates_enabled = $1 WHERE id = 1', [body.due_dates_enabled]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Items ────────────────────────────────────────────────────────────────

  // Quick-add: into the General bucket, at its top.
  app.post('/api/items', async (req, res) => {
    try {
      const general = await defaultCategory(pool);
      const out = await insertItem(pool, req, general.id);
      res.status(out.status).json(out.status === 200 ? { ...out.body, category: general } : out.body);
    } catch (err) {
      fail(res, err);
    }
  });

  // Add straight into a category, at its top.
  app.post('/api/categories/:id/items', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'Category not found' });
    try {
      const { rows } = await pool.query('SELECT id FROM grocery_categories WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Category not found' });
      const out = await insertItem(pool, req, id);
      res.status(out.status).json(out.body);
    } catch (err) {
      fail(res, err);
    }
  });

  // Edit the text, move to another category (to its end), tick or untick
  // (keeping the item's rank), and set or clear a due date and time.
  app.patch('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    const body = req.body || {};
    if (!id) return res.status(404).json({ error: 'Item not found' });
    try {
      const { rows: found } = await pool.query('SELECT * FROM grocery_items WHERE id = $1', [id]);
      if (!found.length) return res.status(404).json({ error: 'Item not found' });
      const item = found[0];
      if (typeof body.text === 'string') {
        const value = text(body.text, TEXT_MAX);
        if (!value) return res.status(400).json({ error: 'Item text is required' });
        await pool.query('UPDATE grocery_items SET text = $1 WHERE id = $2', [value, id]);
      }
      if (Number.isInteger(body.category_id) && body.category_id !== item.category_id) {
        const { rows: target } = await pool.query('SELECT id FROM grocery_categories WHERE id = $1', [body.category_id]);
        if (!target.length) return res.status(400).json({ error: 'Target category not found in this list' });
        await pool.query(
          `UPDATE grocery_items SET category_id = $1,
             sort_order = COALESCE((SELECT MAX(sort_order) FROM grocery_items WHERE category_id = $1), 0) + 1
           WHERE id = $2`,
          [body.category_id, id]
        );
      }
      if (typeof body.checked === 'boolean' && body.checked !== item.checked) {
        await pool.query(
          `UPDATE grocery_items SET checked = $1, completed_at = CASE WHEN $1 THEN $4::timestamptz ELSE NULL END,
             last_checked_by = $3 WHERE id = $2`,
          [body.checked, id, req.user.username, req.now]
        );
      }
      if (body.due_date !== undefined) {
        const d = body.due_date;
        if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
          return res.status(400).json({ error: 'due_date must be YYYY-MM-DD or null' });
        }
        await pool.query('UPDATE grocery_items SET due_date = $1::date WHERE id = $2', [d, id]);
        if (d === null) await pool.query('UPDATE grocery_items SET due_time = NULL WHERE id = $1', [id]);
      }
      if (body.due_time !== undefined) {
        const t = body.due_time;
        if (t !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))) {
          return res.status(400).json({ error: 'due_time must be HH:MM or null' });
        }
        await pool.query(
          'UPDATE grocery_items SET due_time = CASE WHEN due_date IS NULL THEN NULL ELSE $1::time END WHERE id = $2', [t, id]);
      }
      const { rows } = await pool.query(`SELECT ${ITEM_COLUMNS} FROM grocery_items WHERE id = $1`, [id]);
      res.json({ item: rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  // Remove an item, recording who removed what in the same transaction.
  app.delete('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'Item not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('DELETE FROM grocery_items WHERE id = $1 RETURNING text', [id]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item not found' });
      }
      await client.query('INSERT INTO grocery_events (actor, text, removed_at) VALUES ($1, $2, $3)',
        [req.user.username, rows[0].text, req.now]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client.release();
    }
  });

  // ── Categories ───────────────────────────────────────────────────────────

  app.post('/api/categories', async (req, res) => {
    const name = text(req.body && req.body.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO grocery_categories (name, is_default, sort_order)
         VALUES ($1, FALSE, COALESCE((SELECT MAX(sort_order) FROM grocery_categories), 0) + 1)
         RETURNING id, name, is_default, sort_order`,
        [name]
      );
      res.json({ category: rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch('/api/categories/:id', async (req, res) => {
    const id = idParam(req);
    const name = text(req.body && req.body.name, NAME_MAX);
    if (!id) return res.status(404).json({ error: 'Category not found' });
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    try {
      const { rowCount } = await pool.query('UPDATE grocery_categories SET name = $1 WHERE id = $2', [name, id]);
      if (!rowCount) return res.status(404).json({ error: 'Category not found' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Delete a category and its items, unless it is the list's only one. Each
  // item's removal is recorded in the same transaction.
  app.delete('/api/categories/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'Category not found' });
    const client = await pool.connect();
    try {
      const { rows: found } = await client.query('SELECT id FROM grocery_categories WHERE id = $1', [id]);
      if (!found.length) return res.status(404).json({ error: 'Category not found' });
      const { rows: count } = await client.query('SELECT COUNT(*)::int AS n FROM grocery_categories');
      if (count[0].n <= 1) return res.status(400).json({ error: "Can't delete the only category: a list needs at least one" });
      await client.query('BEGIN');
      const { rows: items } = await client.query('SELECT text FROM grocery_items WHERE category_id = $1', [id]);
      for (const row of items) {
        await client.query('INSERT INTO grocery_events (actor, text, removed_at) VALUES ($1, $2, $3)',
          [req.user.username, row.text, req.now]);
      }
      await client.query('DELETE FROM grocery_categories WHERE id = $1', [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client.release();
    }
  });

  // A drag-and-drop reorder of the categories: every id, in order. General
  // stays pinned first.
  app.post('/api/categories/reorder', async (req, res) => {
    const ids = req.body && req.body.categoryIds;
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ error: 'categoryIds must be an array of ids' });
    }
    try {
      await pool.query(
        `UPDATE grocery_categories c SET sort_order = x.ord
           FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
          WHERE c.id = x.id AND NOT c.is_default`,
        [ids]
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // A drag-and-drop reorder within one section (unticked or ticked) of a
  // category: that section's ids, in order.
  app.post('/api/categories/:id/reorder-items', async (req, res) => {
    const id = idParam(req);
    const ids = req.body && req.body.itemIds;
    if (!id) return res.status(404).json({ error: 'Category not found' });
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ error: 'itemIds must be an array of ids' });
    }
    try {
      await pool.query(
        `UPDATE grocery_items i SET sort_order = x.ord
           FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
          WHERE i.id = x.id AND i.category_id = $2`,
        [ids, id]
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Markdown import ──────────────────────────────────────────────────────
  //
  // [{ name, items: [{ text, checked }] }], parsed on the page. 'add' merges
  // into categories with the same name (case-insensitive) and appends;
  // 'replace' empties the list first. An imported "General" is the General
  // bucket.
  app.post('/api/import', async (req, res) => {
    const categories = req.body && req.body.categories;
    const mode = req.body && req.body.mode === 'replace' ? 'replace' : 'add';
    if (!Array.isArray(categories) || !categories.length) return res.status(400).json({ error: 'categories must be a non-empty array' });
    if (categories.length > MAX_IMPORT_CATS) return res.status(400).json({ error: `Too many categories (max ${MAX_IMPORT_CATS})` });
    let count = 0;
    for (const c of categories) {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) return res.status(400).json({ error: 'Every category needs a name' });
      if (!Array.isArray(c.items)) return res.status(400).json({ error: 'Every category needs an items array' });
      for (const it of c.items) {
        if (!it || typeof it.text !== 'string' || !it.text.trim()) return res.status(400).json({ error: 'Every item needs text' });
        count++;
      }
    }
    if (count > MAX_IMPORT_ITEMS) return res.status(400).json({ error: `Too many items (max ${MAX_IMPORT_ITEMS})` });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (mode === 'replace') await client.query('DELETE FROM grocery_categories');
      const { rows: existing } = await client.query('SELECT id, name, is_default FROM grocery_categories');
      const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c.id]));
      let hasDefault = existing.some((c) => c.is_default);
      let catSort = Number((await client.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM grocery_categories')).rows[0].max);
      for (const c of categories) {
        const key = c.name.trim().toLowerCase();
        let catId = byName.get(key);
        if (!catId) {
          const asDefault = !hasDefault && key === 'general';
          if (asDefault) hasDefault = true; else catSort++;
          const r = await client.query(
            'INSERT INTO grocery_categories (name, is_default, sort_order) VALUES ($1, $2, $3) RETURNING id',
            [c.name.trim().slice(0, NAME_MAX), asDefault, asDefault ? 0 : catSort]);
          catId = r.rows[0].id;
          byName.set(key, catId);
        }
        let itemSort = Number((await client.query(
          'SELECT COALESCE(MAX(sort_order), 0) AS max FROM grocery_items WHERE category_id = $1', [catId])).rows[0].max);
        for (const it of c.items) {
          const checked = !!it.checked;
          itemSort++;
          await client.query(
            `INSERT INTO grocery_items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [catId, it.text.trim().slice(0, TEXT_MAX), checked, itemSort, checked ? req.now : null,
              req.user.username, checked ? req.user.username : null, req.now]);
        }
      }
      if (!hasDefault) {
        await client.query(`INSERT INTO grocery_categories (name, is_default, sort_order) VALUES ('General', TRUE, 0)`);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client.release();
    }
  });
}

module.exports = { migrate, routes };
