// This app's API: the trivia game, played in the game room (game/room.js)
// by its rules (game/rules.js), with a live connection for every open page
// (game/live.js); and the question bank, the questions everyone writes
// about themselves (trivia_questions). It came from Homeroom's trivia
// starter; the first version turns it into the game its creator described.
//
// server.js mounts routes() after the sign-in check (a write always has
// req.user; a read may come from a guest, who can watch but not play), runs
// migrate() on boot and hands attach() the HTTP server for the live
// connection.

const { Room } = require('./game/room');
const live = require('./game/live');
const rules = require('./game/rules');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TEXT_MAX = 200;
const ANSWER_MAX = 80;
const PER_PERSON = 20;

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

// The whole bank, for a game about to start (the room's prepare).
async function loadBank(pool) {
  const { rows } = await pool.query('SELECT id, author_id, author, text, answer, wrong FROM trivia_questions ORDER BY id');
  return rows.map((r) => ({ id: r.id, authorId: r.author_id, author: r.author, text: r.text, answer: r.answer, wrong: r.wrong }));
}

const room = new Room({ ...rules, prepare: loadBank });

async function migrate(pool) {
  await room.migrate(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trivia_questions (
      id SERIAL PRIMARY KEY,
      author_id INTEGER NOT NULL,
      author VARCHAR(255) NOT NULL,
      text VARCHAR(${TEXT_MAX}) NOT NULL,
      answer VARCHAR(${ANSWER_MAX}) NOT NULL,
      wrong JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // A staging preview gets a few questions by obviously fake people, a
  // lobby with one of them in it and a few past games, so its checks and
  // its reviewers can start a game straight away. Never runs in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO trivia_questions (id, author_id, author, text, answer, wrong) VALUES
        (900001, 900001, 'staging-demo-ana', 'Staging demo: what do I eat for breakfast most days?', 'Porridge', '["Pancakes", "Toast", "Nothing at all"]'),
        (900002, 900001, 'staging-demo-ana', 'Staging demo: where did I grow up?', 'By the sea', '["In a big city", "On a farm", "In the mountains"]'),
        (900003, 900002, 'staging-demo-ben', 'Staging demo: what instrument did I learn first?', 'The recorder', '["The piano", "The drums", "The violin"]'),
        (900004, 900002, 'staging-demo-ben', 'Staging demo: which season do I like best?', 'Autumn', '["Winter", "Spring", "Summer"]'),
        (900005, 900002, 'staging-demo-ben', 'Staging demo: how many houseplants do I have?', 'Eleven', '["None", "Two", "Twenty"]')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`SELECT setval(pg_get_serial_sequence('trivia_questions', 'id'), GREATEST((SELECT MAX(id) FROM trivia_questions), 1))`);
    await room.seed(pool, {
      state: {
        phase: 'lobby',
        players: [{ id: 900001, username: 'staging-demo-ana' }],
        game: null,
        gameNo: 2,
        results: null,
      },
      results: [
        { id: 900001, gameNo: 1, userId: 900001, username: 'staging-demo-ana', score: 640, place: 1 },
        { id: 900002, gameNo: 1, userId: 900002, username: 'staging-demo-ben', score: 515, place: 2 },
        { id: 900003, gameNo: 2, userId: 900002, username: 'staging-demo-ben', score: 702, place: 1 },
        { id: 900004, gameNo: 2, userId: 900003, username: 'staging-demo-user', score: 388, place: 2 },
      ],
    });
  }
  await room.load(pool);
}

function routes(app, pool) {
  room.routes(app);

  // The bank: your own questions in full, and how many everyone else wrote
  // (their answers stay secret until a game asks them).
  app.get('/api/questions', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const [mine, counts] = await Promise.all([
        pool.query('SELECT id, text, answer, wrong FROM trivia_questions WHERE author_id = $1 ORDER BY id DESC', [me]),
        pool.query('SELECT MAX(author) AS author, COUNT(*)::int AS count FROM trivia_questions GROUP BY author_id ORDER BY count DESC'),
      ]);
      res.json({ mine: mine.rows, authors: counts.rows, perPerson: PER_PERSON });
    } catch (err) {
      fail(res, err);
    }
  });

  // A question about yourself: the right answer and one to three wrong ones.
  app.post('/api/questions', async (req, res) => {
    const body = req.body || {};
    const text = clean(body.text, TEXT_MAX);
    const answer = clean(body.answer, ANSWER_MAX);
    const wrong = (Array.isArray(body.wrong) ? body.wrong : []).map((w) => clean(w, ANSWER_MAX)).filter(Boolean);
    if (!text) return res.status(400).json({ error: 'Write the question.' });
    if (!answer) return res.status(400).json({ error: 'Give the right answer.' });
    if (!wrong.length) return res.status(400).json({ error: 'Give at least one wrong answer.' });
    if (wrong.length > 3) return res.status(400).json({ error: 'Three wrong answers at most.' });
    const all = [answer].concat(wrong).map((a) => a.toLowerCase());
    if (new Set(all).size !== all.length) return res.status(400).json({ error: 'Every answer needs to be different.' });
    try {
      const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM trivia_questions WHERE author_id = $1', [req.user.id]);
      if (count[0].n >= PER_PERSON) return res.status(400).json({ error: `${PER_PERSON} questions each at most. Delete one to write another.` });
      const { rows } = await pool.query(
        `INSERT INTO trivia_questions (author_id, author, text, answer, wrong, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.id, req.user.username, text, answer, JSON.stringify(wrong), req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Only its author deletes a question. A game already asking it keeps it.
  app.delete('/api/questions/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'That question is gone.' });
    try {
      const { rowCount } = await pool.query('DELETE FROM trivia_questions WHERE id = $1 AND author_id = $2', [id, req.user.id]);
      if (!rowCount) return res.status(404).json({ error: 'That question is gone.' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}

function attach(server) {
  return live.attach(server, room);
}

module.exports = { migrate, routes, attach };
