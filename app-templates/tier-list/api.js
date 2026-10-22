// This app's API: a shared tier list. Anyone in the project adds things to
// rank, each person puts each one in a tier (or in Want to, below F, for one
// they have not got to yet), the group's tier list is where the average
// lands, and anyone can see who put each one where. GET /api/presence says
// who has the list open right now: names kept in memory, never stored, and
// forgotten after a minute and a half without a look. server.js
// mounts it after the sign-in check: a write always has req.user ({ id,
// username }); a read may come from a guest with no account (req.guest, no
// req.user). Live updates (live-updates.js) are mounted before it, so every
// write here that succeeds tells the screens that are open.
//
// It came from Homeroom's ready-made tier list. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const NAME_MAX = 60;
const ITEMS_SHOWN = 300;

// Who has the list open: user id -> { username, seen }, in this process only.
// A screen checks in on the timer it already keeps (public/live-updates.js,
// a look a minute), so somebody gone from the window drops off within a look
// or two. At most this many names come back; `more` counts the rest.
const present = new Map();
const PRESENCE_WINDOW_MS = 90000;
const PRESENCE_NAMES = 50;

// The tiers, best first. Each is worth a score (S 5 down to F 0, in the
// query below), and an item's place on the group's list is the tier its
// average score is nearest, a tie going up: 4.5 is S, 4.4 is A.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
// W is not a tier: Want to, the row below F (index.html says what to: go,
// hike, play). It is a person's one place for an item like a tier is, but
// worth no score, so no average, no "N people ranked it" and no "From N
// people's rankings" counts it.
const WANT = 'W';
const PLACES = [...TIERS, WANT];

const GONE = 'That one is not on the list any more.';

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
      tier CHAR(1) NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F', 'W')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_id, user_id)
    )
  `);
  // Who put it there, by name, for "who ranked it what" (GET
  // /api/items/:id). Tiers set before the name was kept have none: they
  // get it from the items that person added, and from their next tier.
  await pool.query('ALTER TABLE tier_votes ADD COLUMN IF NOT EXISTS username VARCHAR(255)');
  await pool.query(`
    UPDATE tier_votes v SET username = i.created_by_name
      FROM tier_items i
     WHERE v.username IS NULL AND v.user_id = i.created_by
  `);

  // A staging preview starts with no rows, so seed a few obviously fake
  // ones for the checks in dapp.json to find: items, and tiers from three
  // fake people (negative ids, never a real account), two of whom want to
  // get to one nobody has ranked. Fixed ids and ON CONFLICT keep it
  // idempotent across rebuilds. Never runs in production.
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
      INSERT INTO tier_votes (item_id, user_id, username, tier)
      VALUES
        (900001, -1, 'staging-demo-ana', 'S'), (900001, -2, 'staging-demo-ben', 'S'), (900001, -3, 'staging-demo-cy', 'A'),
        (900002, -1, 'staging-demo-ana', 'A'), (900002, -2, 'staging-demo-ben', 'B'),
        (900003, -1, 'staging-demo-ana', 'B'), (900003, -2, 'staging-demo-ben', 'C'), (900003, -3, 'staging-demo-cy', 'B'),
        (900004, -1, 'staging-demo-ana', 'F'), (900004, -3, 'staging-demo-cy', 'D'),
        (900005, -1, 'staging-demo-ana', 'W'), (900005, -2, 'staging-demo-ben', 'W'),
        (900002, -3, 'staging-demo-cy', 'W')
      ON CONFLICT DO NOTHING
    `);
  }
}

// Items with the group's tier, how many people ranked each and how many
// want to, and the viewer's own place ($1); the caller adds its WHERE,
// GROUP BY and ORDER. A W is worth no score, so AVG leaves it out.
const SUMMARY = `
  SELECT i.id, i.name, i.created_by, i.created_by_name,
         COUNT(v.user_id) FILTER (WHERE v.tier <> 'W')::int AS votes,
         COUNT(v.user_id) FILTER (WHERE v.tier = 'W')::int AS wants,
         AVG(CASE v.tier WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                         WHEN 'C' THEN 2 WHEN 'D' THEN 1 WHEN 'F' THEN 0 END)::float AS average,
         MAX(CASE WHEN v.user_id = $1 THEN v.tier END) AS yours
    FROM tier_items i
    LEFT JOIN tier_votes v ON v.item_id = i.id`;

function shape(r, me) {
  return {
    id: r.id,
    name: r.name,
    by: r.created_by_name,
    mine: r.created_by === me,
    votes: r.votes,
    wants: r.wants,
    average: r.votes ? Math.round(r.average * 100) / 100 : null,
    tier: r.votes ? tierOf(r.average) : null,
    yours: r.yours || null,
  };
}

function routes(app, pool) {
  // What the group would share with a Homeroom-wide tier list if it ever
  // votes to (usernode-rankings.js, off as it comes): counts, never who.
  require('./usernode-rankings').mount(app, pool);

  // Who else has the list open right now: the names of the other people seen
  // in the last ninety seconds, sorted, the viewer left out. A signed-in
  // screen is recorded and only reads; a guest only reads (req.guest, no
  // req.user) and is never listed. A GET, so it never makes the live-updates
  // hook refetch every open board; the one thing it tells screens about is a
  // new arrival, through notify(), and only then, so check-ins do not loop.
  // Real time, not req.now: a preview opened at a chosen moment still moves
  // through today.
  app.get('/api/presence', (req, res) => {
    const now = Date.now();
    let arrived = false;
    if (req.user) {
      const was = present.get(req.user.id);
      arrived = !was || now - was.seen > PRESENCE_WINDOW_MS;
      present.set(req.user.id, { username: req.user.username, seen: now });
    }
    for (const [id, p] of present) {
      if (now - p.seen > PRESENCE_WINDOW_MS) present.delete(id);
    }
    const me = req.user ? req.user.id : null;
    const here = [...present]
      .filter(([id]) => id !== me)
      .map(([, p]) => p.username)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ here: here.slice(0, PRESENCE_NAMES), more: Math.max(0, here.length - PRESENCE_NAMES) });
    if (arrived) require('./live-updates').notify();
  });

  // Every item, with the group's tier, how many people ranked it and how
  // many want to, and the viewer's own place. Oldest first, so the list
  // does not reshuffle under somebody who is sorting it.
  app.get('/api/items', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(
        `${SUMMARY}
          GROUP BY i.id
          ORDER BY i.created_at, i.id
          LIMIT $2`,
        [me, ITEMS_SHOWN]
      );
      const { rows: people } = await pool.query("SELECT COUNT(DISTINCT user_id)::int AS n FROM tier_votes WHERE tier <> 'W'");
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        tiers: TIERS,
        rankers: people[0].n,
        items: rows.map((r) => shape(r, me)),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // One item, who put it in which tier and who wants to: what tapping it
  // shows. Best tier first, then by name. A tier from before names were
  // kept, whose person has not ranked anything since, has no name (null).
  app.get('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    try {
      const me = req.user ? req.user.id : null;
      const { rows } = await pool.query(`${SUMMARY} WHERE i.id = $2 GROUP BY i.id`, [me, id]);
      if (!rows.length) return res.status(404).json({ error: GONE });
      const { rows: votes } = await pool.query(
        `SELECT user_id, username, tier FROM tier_votes WHERE item_id = $1
          ORDER BY POSITION(tier IN 'SABCDFW'), LOWER(username) NULLS LAST, user_id`,
        [id]
      );
      const person = (v) => ({ name: v.username || null, you: v.user_id === me });
      res.json({
        item: shape(rows[0], me),
        raters: votes.filter((v) => v.tier !== WANT).map((v) => ({ ...person(v), tier: v.tier })),
        wanters: votes.filter((v) => v.tier === WANT).map(person),
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

  // Put an item in one of your tiers or in Want to (W), or take it out
  // again with tier null.
  app.put('/api/items/:id/tier', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
    const tier = req.body ? req.body.tier : undefined;
    if (tier !== null && !PLACES.includes(tier)) return res.status(400).json({ error: 'Pick S, A, B, C, D or F, or Want to.' });
    try {
      if (tier === null) {
        await pool.query('DELETE FROM tier_votes WHERE item_id = $1 AND user_id = $2', [id, req.user.id]);
        return res.json({ tier: null });
      }
      const { rows } = await pool.query(
        `INSERT INTO tier_votes (item_id, user_id, username, tier)
         SELECT id, $2, $4, $3 FROM tier_items WHERE id = $1
         ON CONFLICT (item_id, user_id) DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = NOW()
         RETURNING tier`,
        [id, req.user.id, tier, req.user.username]
      );
      if (!rows.length) return res.status(404).json({ error: GONE });
      // Their name on every tier they set, so one set before names were
      // kept, or before they were renamed, says who they are now.
      await pool.query(
        'UPDATE tier_votes SET username = $2 WHERE user_id = $1 AND username IS DISTINCT FROM $2',
        [req.user.id, req.user.username]
      );
      res.json({ tier: rows[0].tier });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever added an item can take it off the list, tiers and all.
  app.delete('/api/items/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: GONE });
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
