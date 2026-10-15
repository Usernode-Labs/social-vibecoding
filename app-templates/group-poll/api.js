// This app's API: the group's polls. Anyone starts one with a question, a
// few options, how people vote and when it closes; anyone adds an option
// while it is open; everyone votes, either ticking every option they would
// be happy with (most ticks wins) or picking one. A closed poll keeps its
// winner under Decided. server.js mounts it after the sign-in check: a
// write always has req.user ({ id, username }); a read may come from a
// guest with no account (req.guest, no req.user).
//
// "Now" is req.now, never new Date() or SQL's NOW(), so a staging preview
// opened at a chosen moment shows which polls are still open at that moment
// ("Time-dependent features" in the platform conventions). A poll is closed
// once its closing time has passed or its starter closed it, worked out on
// every read: nothing runs in the background to close it.
//
// A secret poll's votes are counted, never shown: the API sends its totals
// and the viewer's own votes, and nobody's name next to an option.
//
// It came from Homeroom's ready-made group poll. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL || process.env.USERNODE_PLATFORM_API_URL;

const QUESTION_MAX = 140;
const OPTION_MAX = 80;
const OPTIONS_MAX = 20;
const OPEN_SHOWN = 50;
const DECIDED_SHOWN = 20;
const MODES = ['approval', 'single'];
// A closing time further off than this is a typo, not a plan.
const LONGEST_MS = 366 * 24 * 60 * 60 * 1000;

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

/** Closed: its starter closed it, or its closing time has come. */
function isClosed(poll, now) {
  return poll.closed_at !== null || (poll.closes_at !== null && poll.closes_at.getTime() <= now.getTime());
}

/** `work(client)` inside one transaction; its answer is the result. */
async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Who is in the group ──────────────────────────────────────────────────
//
// The project's members, from the platform ("Members" in the platform
// conventions), so a poll can say who has voted and who it is still waiting
// on. Asked with the viewer's own token, so only a member gets an answer;
// anyone else (an admin looking in, the platform's check runner) sees the
// polls with a plain count of voters. Cached for a minute per viewer, so the
// answer one member got is never shown to somebody the platform refuses.

const cache = new Map(); // viewer id -> { at, members }
const CACHE_MS = 60 * 1000;

async function members(req) {
  if (!req.user) return { status: 'unavailable', members: null };
  const hit = cache.get(req.user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { status: 'ok', members: hit.members };
  const token = req.query.token || req.headers['x-usernode-token'];
  if (!PLATFORM_API_BASE || !token) return { status: 'unavailable', members: null };
  const headers = { 'x-usernode-user-token': token };
  if (process.env.USERNODE_LLM_PROXY_TOKEN) headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
  try {
    const resp = await fetch(`${PLATFORM_API_BASE}/members?limit=200`, { headers });
    if (resp.status === 403) return { status: 'not_member', members: null };
    if (!resp.ok) return { status: 'unavailable', members: null };
    const body = await resp.json();
    const list = (body.members || []).map((m) => ({ id: m.id, username: m.username }));
    if (!list.length) return { status: 'unavailable', members: null };
    if (cache.size > 500) cache.clear();
    cache.set(req.user.id, { at: Date.now(), members: list });
    return { status: 'ok', members: list };
  } catch (err) {
    console.warn('members lookup failed: ' + err.message);
    return { status: 'unavailable', members: null };
  }
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      question VARCHAR(${QUESTION_MAX}) NOT NULL,
      -- 'approval': tick every option you would be happy with; 'single': pick one.
      mode VARCHAR(10) NOT NULL DEFAULT 'approval',
      secret BOOLEAN NOT NULL DEFAULT FALSE,
      -- When it closes by itself; NULL stays open until its starter closes it.
      closes_at TIMESTAMPTZ,
      -- When its starter closed it by hand.
      closed_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label VARCHAR(${OPTION_MAX}) NOT NULL,
      added_by INTEGER NOT NULL,
      added_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The same option twice is one option: labels are stored with their
  // whitespace tidied, and compared without case.
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS poll_options_label_idx ON poll_options (poll_id, LOWER(label))');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (option_id, user_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS poll_votes_poll_idx ON poll_votes (poll_id, user_id)');

  // A staging preview starts with no rows, so seed two obviously fake polls
  // for the checks in dapp.json to find: one open (no closing time, so it is
  // open at any moment a preview is opened at) with votes that give each
  // option a different bar, and one decided with a winner. Fixed ids and
  // ON CONFLICT keep it idempotent across rebuilds; everyone in it is a fake
  // identity. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO polls (id, question, mode, secret, closes_at, closed_at, created_by, created_by_name, created_at)
      VALUES
        (900001, 'Staging demo poll: which one should we choose?', 'approval', FALSE, NULL, NULL, 0, 'staging-demo-user', NOW() - INTERVAL '1 day'),
        (900002, 'Staging demo poll: which one did we choose last time?', 'approval', FALSE, NULL, NOW() - INTERVAL '2 days', -1, 'staging-demo-ana', NOW() - INTERVAL '4 days')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO poll_options (id, poll_id, label, added_by, added_by_name)
      VALUES
        (900001, 900001, 'Staging demo option A', 0, 'staging-demo-user'),
        (900002, 900001, 'Staging demo option B', -1, 'staging-demo-ana'),
        (900003, 900001, 'Staging demo option C', -2, 'staging-demo-ben'),
        (900004, 900001, 'Staging demo option D', -3, 'staging-demo-cy'),
        (900005, 900002, 'Staging demo winner', -1, 'staging-demo-ana'),
        (900006, 900002, 'Staging demo runner-up', -2, 'staging-demo-ben')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO poll_votes (option_id, poll_id, user_id, username)
      VALUES
        (900001, 900001, 0, 'staging-demo-user'), (900001, 900001, -1, 'staging-demo-ana'),
        (900001, 900001, -2, 'staging-demo-ben'), (900001, 900001, -3, 'staging-demo-cy'),
        (900002, 900001, -1, 'staging-demo-ana'), (900002, 900001, -2, 'staging-demo-ben'),
        (900002, 900001, -4, 'staging-demo-dee'),
        (900003, 900001, -3, 'staging-demo-cy'), (900003, 900001, -4, 'staging-demo-dee'),
        (900004, 900001, 0, 'staging-demo-user'),
        (900005, 900002, 0, 'staging-demo-user'), (900005, 900002, -1, 'staging-demo-ana'),
        (900005, 900002, -2, 'staging-demo-ben'),
        (900006, 900002, -3, 'staging-demo-cy')
      ON CONFLICT DO NOTHING
    `);
  }
}

/**
 * A poll as the screen draws it. Counts always; who voted for what only on
 * a poll that is not secret; the viewer's own votes always. `turnout.of` is
 * the group's size when the member list is known.
 */
function shape(p, closed, options, votes, group, me) {
  const own = options.filter((o) => o.poll_id === p.id);
  const cast = votes.filter((v) => v.poll_id === p.id);
  const byOption = own.map((o) => cast.filter((v) => v.option_id === o.id));
  const top = byOption.reduce((most, list) => Math.max(most, list.length), 0);
  const voters = new Map(); // user id -> username, first vote first
  for (const v of cast) if (!voters.has(v.user_id)) voters.set(v.user_id, v.username);
  const turnout = { voted: voters.size, of: null, ofVoted: null, votedBy: null, waitingOn: null };
  if (!p.secret) turnout.votedBy = [...voters.values()];
  if (group.members) {
    turnout.of = group.members.length;
    turnout.ofVoted = group.members.filter((m) => voters.has(m.id)).length;
    // Who has not voted yet says who has, so a secret poll keeps it to the count.
    if (!p.secret) turnout.waitingOn = group.members.filter((m) => !voters.has(m.id)).map((m) => m.username);
  }
  const mine = me !== null && p.created_by === me;
  const decidedAt = closed
    ? new Date(Math.min(...[p.closed_at, p.closes_at].filter(Boolean).map((d) => d.getTime())))
    : null;
  return {
    id: p.id,
    question: p.question,
    mode: p.mode,
    secret: p.secret,
    by: p.created_by_name,
    mine,
    closesAt: p.closes_at ? p.closes_at.toISOString() : null,
    closed,
    decidedAt: decidedAt ? decidedAt.toISOString() : null,
    canClose: mine && !closed,
    canDelete: mine,
    options: own.map((o, i) => ({
      id: o.id,
      label: o.label,
      by: o.added_by_name,
      mine: me !== null && o.added_by === me,
      votes: byOption[i].length,
      yours: me !== null && byOption[i].some((v) => v.user_id === me),
      voters: p.secret ? null : byOption[i].map((v) => v.username),
      leading: top > 0 && byOption[i].length === top,
      canRemove: me !== null && o.added_by === me && !closed && own.length > 2,
    })),
    turnout,
    // A tie names every option on top; nobody voting names none.
    winners: closed ? own.filter((o, i) => top > 0 && byOption[i].length === top).map((o) => o.label) : null,
  };
}

function routes(app, pool) {
  // The open polls (closing soonest first, then the ones their starter
  // closes) and the latest decided ones, each with its options and votes.
  app.get('/api/polls', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const group = await members(req);
      const columns = 'id, question, mode, secret, closes_at, closed_at, created_by, created_by_name';
      const { rows: open } = await pool.query(
        `SELECT ${columns} FROM polls
          WHERE closed_at IS NULL AND (closes_at IS NULL OR closes_at > $1)
          ORDER BY closes_at ASC NULLS LAST, id DESC LIMIT $2`,
        [req.now, OPEN_SHOWN]
      );
      const { rows: decided } = await pool.query(
        `SELECT ${columns} FROM polls
          WHERE closed_at IS NOT NULL OR closes_at <= $1
          ORDER BY LEAST(closed_at, closes_at) DESC, id DESC LIMIT $2`,
        [req.now, DECIDED_SHOWN]
      );
      const ids = open.concat(decided).map((p) => p.id);
      const { rows: options } = ids.length
        ? await pool.query(
          'SELECT id, poll_id, label, added_by, added_by_name FROM poll_options WHERE poll_id = ANY($1::int[]) ORDER BY id',
          [ids])
        : { rows: [] };
      const { rows: votes } = ids.length
        ? await pool.query(
          'SELECT option_id, poll_id, user_id, username FROM poll_votes WHERE poll_id = ANY($1::int[]) ORDER BY voted_at, username',
          [ids])
        : { rows: [] };
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        members: group.status,
        open: open.map((p) => shape(p, false, options, votes, group, me)),
        decided: decided.map((p) => shape(p, true, options, votes, group, me)),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Start a poll: a question, two or more options, how people vote, and
  // when it closes (an ISO time the page works out from the starter's own
  // clock, or null to stay open until they close it).
  app.post('/api/polls', async (req, res) => {
    const body = req.body || {};
    const question = cleanText(body.question, QUESTION_MAX);
    if (!question) return res.status(400).json({ error: 'Say what the group is deciding.' });
    const mode = body.mode == null || body.mode === '' ? 'approval' : body.mode;
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'Pick how people vote.' });
    const labels = (Array.isArray(body.options) ? body.options : []).map((o) => cleanText(o, OPTION_MAX)).filter(Boolean);
    if (labels.length < 2) return res.status(400).json({ error: 'Give the poll at least two options.' });
    if (labels.length > OPTIONS_MAX) return res.status(400).json({ error: `A poll has room for ${OPTIONS_MAX} options.` });
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      return res.status(400).json({ error: 'Two of the options are the same. Give each one once.' });
    }
    let closesAt = null;
    if (body.closesAt != null && body.closesAt !== '') {
      closesAt = typeof body.closesAt === 'string' ? new Date(body.closesAt) : null;
      if (!closesAt || Number.isNaN(closesAt.getTime())) return res.status(400).json({ error: 'Pick when the poll closes.' });
      if (closesAt.getTime() <= req.now.getTime()) return res.status(400).json({ error: 'That closing time has already passed.' });
      if (closesAt.getTime() - req.now.getTime() > LONGEST_MS) return res.status(400).json({ error: 'Pick a closing time within a year.' });
    }
    try {
      const id = await inTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO polls (question, mode, secret, closes_at, created_by, created_by_name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [question, mode, body.secret === true, closesAt, req.user.id, req.user.username, req.now]
        );
        for (const label of labels) {
          await client.query(
            `INSERT INTO poll_options (poll_id, label, added_by, added_by_name, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [rows[0].id, label, req.user.id, req.user.username, req.now]
          );
        }
        return rows[0].id;
      });
      res.status(201).json({ id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Anyone adds an option while the poll is open; the same one twice is
  // refused, whatever its case or spacing.
  app.post('/api/polls/:id/options', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That poll is not here any more.' });
    const label = cleanText(req.body && req.body.label, OPTION_MAX);
    if (!label) return res.status(400).json({ error: 'Say what the option is.' });
    try {
      const { rows: found } = await pool.query(
        `SELECT p.closes_at, p.closed_at, (SELECT COUNT(*)::int FROM poll_options o WHERE o.poll_id = p.id) AS options
           FROM polls p WHERE p.id = $1`,
        [id]
      );
      if (!found.length) return res.status(404).json({ error: 'That poll is not here any more.' });
      if (isClosed(found[0], req.now)) return res.status(409).json({ error: 'This poll has closed.' });
      if (found[0].options >= OPTIONS_MAX) return res.status(409).json({ error: `This poll has room for ${OPTIONS_MAX} options.` });
      const { rows } = await pool.query(
        `INSERT INTO poll_options (poll_id, label, added_by, added_by_name, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [id, label, req.user.id, req.user.username, req.now]
      );
      if (!rows.length) return res.status(409).json({ error: `"${label}" is already an option.` });
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever added an option can take it off while the poll is open, as long
  // as two are left.
  app.delete('/api/options/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That option is not on the poll any more.' });
    try {
      const { rows } = await pool.query(
        `SELECT o.added_by, p.closes_at, p.closed_at,
                (SELECT COUNT(*)::int FROM poll_options x WHERE x.poll_id = o.poll_id) AS options
           FROM poll_options o JOIN polls p ON p.id = o.poll_id WHERE o.id = $1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'That option is not on the poll any more.' });
      const o = rows[0];
      if (o.added_by !== req.user.id) return res.status(403).json({ error: 'Only whoever added an option can take it off.' });
      if (isClosed(o, req.now)) return res.status(409).json({ error: 'This poll has closed.' });
      if (o.options <= 2) return res.status(409).json({ error: 'A poll needs at least two options.' });
      await pool.query('DELETE FROM poll_options WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Vote for an option (on: true) or take the vote back (on: false). On a
  // pick-one poll, a vote moves: it takes back your vote for any other
  // option. The poll's row is locked meanwhile, so two quick taps never
  // leave two picks, and a vote never lands after the poll closed.
  app.put('/api/options/:id/vote', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That option is not on the poll any more.' });
    const on = !!(req.body && req.body.on);
    try {
      const out = await inTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `SELECT o.poll_id, p.mode, p.closes_at, p.closed_at
             FROM poll_options o JOIN polls p ON p.id = o.poll_id WHERE o.id = $1 FOR UPDATE OF p`,
          [id]
        );
        if (!rows.length) return { status: 404, body: { error: 'That option is not on the poll any more.' } };
        const o = rows[0];
        if (isClosed(o, req.now)) return { status: 409, body: { error: 'This poll has closed.' } };
        if (!on) {
          await client.query('DELETE FROM poll_votes WHERE option_id = $1 AND user_id = $2', [id, req.user.id]);
          return { status: 200, body: { on: false } };
        }
        if (o.mode === 'single') {
          await client.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_id <> $3', [o.poll_id, req.user.id, id]);
        }
        await client.query(
          `INSERT INTO poll_votes (option_id, poll_id, user_id, username, voted_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (option_id, user_id) DO NOTHING`,
          [id, o.poll_id, req.user.id, req.user.username, req.now]
        );
        return { status: 200, body: { on: true } };
      });
      res.status(out.status).json(out.body);
    } catch (err) {
      fail(res, err);
    }
  });

  // Its starter closes a poll: the only way one with no closing time ends,
  // and a way to end any other early.
  app.post('/api/polls/:id/close', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That poll is not here any more.' });
    try {
      const { rows } = await pool.query('SELECT created_by, closes_at, closed_at FROM polls WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'That poll is not here any more.' });
      if (rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'Only whoever started the poll can close it.' });
      if (isClosed(rows[0], req.now)) return res.status(409).json({ error: 'This poll has already closed.' });
      await pool.query('UPDATE polls SET closed_at = $2 WHERE id = $1 AND closed_at IS NULL', [id, req.now]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Its starter can delete a poll, open or decided, with its votes.
  app.delete('/api/polls/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That poll is not here any more.' });
    try {
      const { rows } = await pool.query('SELECT created_by FROM polls WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'That poll is not here any more.' });
      if (rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'Only whoever started the poll can delete it.' });
      await pool.query('DELETE FROM polls WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
