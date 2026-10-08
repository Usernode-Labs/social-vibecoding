// This app's API: a lending library of things members can lend each other.
// Each thing has an owner; a member borrows it for a week, two weeks or a
// month; the owner or the borrower marks it back. server.js mounts it after
// the sign-in check: a write always has req.user ({ id, username }); a read
// may come from a guest with no account (req.guest, no req.user).
//
// "Now" is req.now, never new Date() or SQL's NOW(), so a staging preview
// opened at a chosen moment shows what is overdue at that moment
// ("Time-dependent features" in the platform conventions).
//
// It came from Homeroom's ready-made lending library. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 80;
const NOTE_MAX = 120;
const THINGS_SHOWN = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a loan can be, in days: a week, two weeks or a month.
const LOAN_DAYS = [7, 14, 28];

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
    CREATE TABLE IF NOT EXISTS library_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      note VARCHAR(${NOTE_MAX}),
      owner_id INTEGER NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_loans (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      borrower_id INTEGER NOT NULL,
      borrower_name VARCHAR(255) NOT NULL,
      borrowed_at TIMESTAMPTZ NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      returned_at TIMESTAMPTZ
    )
  `);
  // A thing is with one person at a time.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS library_loans_open_idx
    ON library_loans (item_id) WHERE returned_at IS NULL`);

  // A staging preview starts with no rows, so seed a few obviously fake
  // ones for the checks in dapp.json to find: things on the shelf, one out
  // on loan and one overdue, all owned and borrowed by fake identities.
  // Fixed ids and ON CONFLICT keep it idempotent across rebuilds. Never
  // runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO library_items (id, name, note, owner_id, owner_name)
      VALUES
        (900001, 'Staging demo drill', 'Bits are in the case', 0, 'staging-demo-user'),
        (900002, 'Staging demo tent', 'Sleeps four', 0, 'staging-demo-user'),
        (900003, 'Staging demo board game', NULL, -1, 'staging-demo-ana'),
        (900004, 'Staging demo ladder', NULL, -1, 'staging-demo-ana')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO library_loans (id, item_id, borrower_id, borrower_name, borrowed_at, due_at)
      VALUES
        (900001, 900002, -1, 'staging-demo-ana', NOW() - INTERVAL '3 days', NOW() + INTERVAL '11 days'),
        (900002, 900004, 0, 'staging-demo-user', NOW() - INTERVAL '9 days', NOW() - INTERVAL '2 days')
      ON CONFLICT DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // Every thing, with who has it now and when it is due back. What the
  // viewer has borrowed comes first, then the rest by name.
  app.get('/api/things', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `SELECT i.id, i.name, i.note, i.owner_id, i.owner_name,
                l.id AS loan_id, l.borrower_id, l.borrower_name, l.due_at
           FROM library_items i
           LEFT JOIN library_loans l ON l.item_id = i.id AND l.returned_at IS NULL
          ORDER BY (l.borrower_id IS NOT NULL AND l.borrower_id = $1) DESC, LOWER(i.name), i.id
          LIMIT $2`,
        [me, THINGS_SHOWN]
      );
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        things: rows.map((r) => ({
          id: r.id,
          name: r.name,
          note: r.note,
          owner: r.owner_name,
          mine: r.owner_id === me,
          out: !!r.loan_id,
          borrower: r.loan_id ? r.borrower_name : null,
          borrowedByMe: !!r.loan_id && r.borrower_id === me,
          due: r.loan_id ? r.due_at.toISOString() : null,
          overdue: !!r.loan_id && r.due_at.getTime() < req.now.getTime(),
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/things', async (req, res) => {
    const name = cleanText(req.body && req.body.name, NAME_MAX);
    const note = cleanText(req.body && req.body.note, NOTE_MAX) || null;
    if (!name) return res.status(400).json({ error: 'Say what you can lend.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO library_items (name, note, owner_id, owner_name, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name, note, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Borrow it for `days` (7, 14 or 28), from now.
  app.post('/api/things/:id/borrow', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not in the library any more.' });
    const days = Number(req.body && req.body.days);
    if (!LOAN_DAYS.includes(days)) return res.status(400).json({ error: 'Borrow it for a week, two weeks or a month.' });
    try {
      const { rows: things } = await pool.query('SELECT owner_id FROM library_items WHERE id = $1', [id]);
      if (!things.length) return res.status(404).json({ error: 'That is not in the library any more.' });
      if (things[0].owner_id === req.user.id) return res.status(400).json({ error: 'That one is yours already.' });
      const due = new Date(req.now.getTime() + days * DAY_MS);
      const { rows } = await pool.query(
        `INSERT INTO library_loans (item_id, borrower_id, borrower_name, borrowed_at, due_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, req.user.id, req.user.username, req.now, due]
      );
      if (!rows.length) return res.status(409).json({ error: 'Somebody has just borrowed it.' });
      res.status(201).json({ due: due.toISOString() });
    } catch (err) {
      fail(res, err);
    }
  });

  // Back on the shelf. The borrower returns it, or its owner says it is back.
  app.post('/api/things/:id/return', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not in the library any more.' });
    try {
      const { rowCount } = await pool.query(
        `UPDATE library_loans l SET returned_at = $3
           FROM library_items i
          WHERE l.item_id = $1 AND i.id = l.item_id AND l.returned_at IS NULL
            AND (l.borrower_id = $2 OR i.owner_id = $2)`,
        [id, req.user.id, req.now]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only its owner or whoever has it can mark it back.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Its owner can take a thing out of the library while it is on the shelf.
  app.delete('/api/things/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That is not in the library any more.' });
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM library_items i
          WHERE i.id = $1 AND i.owner_id = $2
            AND NOT EXISTS (SELECT 1 FROM library_loans l WHERE l.item_id = i.id AND l.returned_at IS NULL)`,
        [id, req.user.id]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only its owner can take it out, once it is back on the shelf.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
