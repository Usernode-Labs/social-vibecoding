// This app's API: a shared tier list. Anyone in the project adds things to
// rank, each person puts each one in a tier, and the group's tier list is
// where the average lands. server.js mounts it after the sign-in check: a
// write always has req.user ({ id, username }); a read may come from a guest
// with no account (req.guest, no req.user).
//
// It came from Homeroom's ready-made tier list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 60;
const ITEMS_SHOWN = 300;

// The tiers, best first. Each is worth a score (S 5 down to F 0, in the
// query below), and an item's place on the group's list is the tier its
// average score is nearest, a tie going up: 4.5 is S, 4.4 is A.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

function tierOf(average) {
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, Math.ceil(4.5 - average)))];
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

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(${NAME_MAX}) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One of each: "Taco Place" and "taco place" are the same thing.
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS tier_items_name_idx ON tier_items (LOWER(name))');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_votes (
      item_id INTEGER NOT NULL REFERENCES tier_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      tier CHAR(1) NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_id, user_id)
    )
  `);

  // A staging preview starts with no rows, so seed a few obviously fake
  // ones for the checks in dapp.json to find: items, and tiers from three
  // fake people (negative ids, never a real account). Fixed ids and
  // ON CONFLICT keep it idempotent across rebuilds. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO tier_items (id, name, created_by, created_by_name)
      VALUES
        (900001, 'Staging demo one', 0, 'staging-demo-user'),
        (900002, 'Staging demo two', 0, 'staging-demo-user'),
        (900003, 'Staging demo three', 0, 'staging-demo-user'),
        (900004, 'Staging demo four', 0, 'staging-demo-user'),
        (900005, 'Staging demo five', 0, 'staging-demo-user')
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      INSERT INTO tier_votes (item_id, user_id, tier)
      VALUES
        (900001, -1, 'S'), (900001, -2, 'S'), (900001, -3, 'A'),
        (900002, -1, 'A'), (900002, -2, 'B'),
        (900003, -1, 'B'), (900003, -2, 'C'), (900003, -3, 'B'),
        (900004, -1, 'F'), (900004, -3, 'D')
      ON CONFLICT DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // Every item, with the group's tier, how many people ranked it, and the
  // viewer's own tier. Oldest first, so the list does not reshuffle under
  // somebody who is sorting it.
  app.get('/api/items', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `SELECT i.id, i.name, i.created_by, i.created_by_name,
                COUNT(v.user_id)::int AS votes,
                AVG(CASE v.tier WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                                WHEN 'C' THEN 2 WHEN 'D' THEN 1 WHEN 'F' THEN 0 END)::float AS average,
                MAX(CASE WHEN v.user_id = $1 THEN v.tier END) AS yours
           FROM tier_items i
           LEFT JOIN tier_votes v ON v.item_id = i.id
          GROUP BY i.id
          ORDER BY i.created_at, i.id
          LIMIT $2`,
        [me, ITEMS_SHOWN]
      );
      const { rows: people } = await pool.query('SELECT COUNT(DISTINCT user_id)::int AS n FROM tier_votes');
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        tiers: TIERS,
        rankers: people[0].n,
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          by: r.created_by_name,
          mine: r.created_by === me,
          votes: r.votes,
          average: r.votes ? Math.round(r.average * 100) / 100 : null,
          tier: r.votes ? tierOf(r.average) : null,
          yours: r.yours || null,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/items', async (req, res) => {
    const name = cleanText(req.body && req.body.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'Type a name first.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO tier_items (name, created_by, created_by_name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [name, req.user.id, req.user.username]
      );
      if (!rows.length) return res.status(409).json({ error: `"${name}" is already on the list.` });
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Put an item in one of your tiers, or take it out again with tier null.
  app.put('/api/items/:id/tier', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That one is not on the list any more.' });
    const tier = req.body ? req.body.tier : undefined;
    if (tier !== null && !TIERS.includes(tier)) return res.status(400).json({ error: 'Pick S, A, B, C, D or F.' });
    try {
      if (tier === null) {
        await pool.query('DELETE FROM tier_votes WHERE item_id = $1 AND user_id = $2', [id, req.user.id]);
        return res.json({ tier: null });
      }
      const { rows } = await pool.query(
        `INSERT INTO tier_votes (item_id, user_id, tier)
         SELECT id, $2, $3 FROM tier_items WHERE id = $1
         ON CONFLICT (item_id, user_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = NOW()
         RETURNING tier`,
        [id, req.user.id, tier]
      );
      if (!rows.length) return res.status(404).json({ error: 'That one is not on the list any more.' });
      res.json({ tier: rows[0].tier });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever added an item can take it off the list, tiers and all.
  app.delete('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That one is not on the list any more.' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM tier_items WHERE id = $1 AND created_by = $2', [id, req.user.id]);
      if (!rowCount) return res.status(403).json({ error: 'Only the person who added it can remove it.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
