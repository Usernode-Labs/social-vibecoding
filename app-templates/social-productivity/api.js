// This app's API: shared lists of tasks that anyone in the project can add
// to, claim and tick off. server.js mounts it after the sign-in check: a
// write always has req.user ({ id, username }); a read may come from a guest
// with no account (req.guest, no req.user).
//
// It came from Homeroom's "Social productivity" template. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TITLE_MAX = 80;
const TASK_MAX = 200;
const LISTS_SHOWN = 100;

/** One line of text, whitespace tidied, cut to `max`. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      title VARCHAR(${TITLE_MAX}) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      text VARCHAR(${TASK_MAX}) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      claimed_by INTEGER,
      claimed_by_name VARCHAR(255),
      done_by_name VARCHAR(255),
      done_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tasks_list_id_idx ON tasks (list_id)');

  // A staging preview starts with no rows, so seed one obviously fake list
  // for the checks in dapp.json to find. Fixed ids and ON CONFLICT keep it
  // idempotent across rebuilds; the owner is a fake identity, never whoever
  // opens the preview. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO lists (id, title, created_by, created_by_name)
      VALUES (900001, 'Staging demo: weekend chores', 0, 'staging-demo-user')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO tasks (id, list_id, text, created_by, created_by_name, claimed_by, claimed_by_name, done_by_name, done_at)
      VALUES
        (900001, 900001, 'Staging demo: water the plants', 0, 'staging-demo-user', 0, 'staging-demo-user', 'staging-demo-user', NOW()),
        (900002, 900001, 'Staging demo: pick up groceries', 0, 'staging-demo-user', 0, 'staging-demo-user', NULL, NULL),
        (900003, 900001, 'Staging demo: book the community room', 0, 'staging-demo-user', NULL, NULL, NULL, NULL)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

function routes(app, pool) {
  // Every list with its tasks, newest list first. One request for the whole
  // board keeps the screen simple; page it if lists grow into the hundreds.
  app.get('/api/lists', async (req, res) => {
    try {
      const { rows: lists } = await pool.query(
        `SELECT id, title, created_by, created_by_name, created_at
           FROM lists ORDER BY created_at DESC, id DESC LIMIT $1`,
        [LISTS_SHOWN]
      );
      const ids = lists.map((l) => l.id);
      const { rows: tasks } = ids.length
        ? await pool.query(
          `SELECT id, list_id, text, created_by, created_by_name, claimed_by, claimed_by_name,
                  done_by_name, done_at
             FROM tasks WHERE list_id = ANY($1::int[])
            ORDER BY (done_at IS NOT NULL), created_at, id`,
          [ids]
        )
        : { rows: [] };
      // A guest (no account) owns and has claimed nothing.
      const me = req.user ? req.user.id : null;
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        lists: lists.map((l) => ({
          id: l.id,
          title: l.title,
          by: l.created_by_name,
          mine: l.created_by === me,
          tasks: tasks.filter((t) => t.list_id === l.id).map((t) => ({
            id: t.id,
            text: t.text,
            by: t.created_by_name,
            claimedBy: t.claimed_by_name,
            claimedByMe: t.claimed_by === me,
            done: !!t.done_at,
            doneBy: t.done_by_name,
            canRemove: t.created_by === me || l.created_by === me,
          })),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/lists', async (req, res) => {
    const title = cleanText(req.body && req.body.title, TITLE_MAX);
    if (!title) return res.status(400).json({ error: 'Give the list a name.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO lists (title, created_by, created_by_name) VALUES ($1, $2, $3) RETURNING id`,
        [title, req.user.id, req.user.username]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Only the person who started a list removes it, tasks and all.
  app.delete('/api/lists/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such list.' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM lists WHERE id = $1 AND created_by = $2', [id, req.user.id]);
      if (!rowCount) return res.status(403).json({ error: 'Only the person who started a list can remove it.' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/lists/:id/tasks', async (req, res) => {
    const id = idParam(req);
    const text = cleanText(req.body && req.body.text, TASK_MAX);
    if (!id) return res.status(404).json({ error: 'No such list.' });
    if (!text) return res.status(400).json({ error: 'Say what needs doing.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO tasks (list_id, text, created_by, created_by_name)
         SELECT id, $2, $3, $4 FROM lists WHERE id = $1
         RETURNING id`,
        [id, text, req.user.id, req.user.username]
      );
      if (!rows.length) return res.status(404).json({ error: 'No such list.' });
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "I'll do it" claims an unclaimed task; pressing it again lets it go.
  // A task someone else has claimed stays theirs.
  app.post('/api/tasks/:id/claim', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such task.' });
    try {
      const { rows } = await pool.query(
        `UPDATE tasks
            SET claimed_by = CASE WHEN claimed_by = $2 THEN NULL ELSE $2 END,
                claimed_by_name = CASE WHEN claimed_by = $2 THEN NULL ELSE $3 END
          WHERE id = $1 AND (claimed_by IS NULL OR claimed_by = $2)
          RETURNING claimed_by`,
        [id, req.user.id, req.user.username]
      );
      if (!rows.length) return res.status(409).json({ error: 'Someone else is already on it.' });
      res.json({ claimed: rows[0].claimed_by === req.user.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/done', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such task.' });
    const done = !!(req.body && req.body.done);
    try {
      const { rowCount } = await pool.query(
        `UPDATE tasks
            SET done_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                done_by_name = CASE WHEN $2 THEN $3 ELSE NULL END
          WHERE id = $1`,
        [id, done, req.user.username]
      );
      if (!rowCount) return res.status(404).json({ error: 'No such task.' });
      res.json({ done });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A task's author, or its list's author, can remove it.
  app.delete('/api/tasks/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such task.' });
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM tasks t USING lists l
          WHERE t.id = $1 AND l.id = t.list_id AND (t.created_by = $2 OR l.created_by = $2)`,
        [id, req.user.id]
      );
      if (!rowCount) return res.status(403).json({ error: 'Only the task\'s author or the list\'s author can remove it.' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { migrate, routes };
