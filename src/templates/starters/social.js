'use strict';

// Social productivity starting point: a shared plan board. Anyone in the
// project can add something to do, and everyone can mark themselves in.
//
// The starter is demo code, not a finished product: its screen says so and
// tells the coding agent how to replace it (src/services/template.js's
// shared shell supplies that copy). No LLM call, no new dependency.

module.exports = {
  key: 'social',
  title: 'Social productivity',
  caption: 'A shared board of plans and tasks, where people can join in.',

  welcome: `      <p class="text-sm text-zinc-300 leading-relaxed">This starter is a shared plan board. Add something the group could do, and everyone can say they are in.</p>`,

  exampleCard: `
      <div class="w-full flex flex-col gap-3">
        <div class="flex gap-2">
          <input id="plan-title" maxlength="200" placeholder="Add something to do" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none">
          <button id="plan-add" class="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Add</button>
        </div>
        <p id="plan-status" class="hidden text-xs text-zinc-500" role="status"></p>
        <div id="plan-items" class="w-full flex flex-col gap-2"></div>
      </div>
`,

  script: `
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};
    const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    async function loadItems() {
      const list = document.getElementById('plan-items');
      try {
        const res = await fetch('/api/items', { headers });
        if (!res.ok) throw new Error('Could not load the board');
        const { items } = await res.json();
        list.textContent = '';
        if (!items.length) {
          list.appendChild(el('p', 'rounded-lg border border-zinc-800 px-3 py-4 text-center text-sm text-zinc-500',
            'Nothing on the board yet. Add the first thing to do.'));
          return;
        }
        for (const item of items) {
          const row = el('div', 'flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2');
          const info = el('div', 'min-w-0 flex-1');
          info.appendChild(el('div', 'truncate text-sm font-semibold text-zinc-100', item.title));
          info.appendChild(el('div', 'text-xs text-zinc-500', 'Started by ' + item.username));
          row.appendChild(info);
          row.appendChild(el('span', 'shrink-0 text-xs text-zinc-500', item.joins + ' in'));
          const join = el('button',
            'shrink-0 rounded-full border border-zinc-600 px-3 py-1 text-xs font-semibold text-zinc-100 hover:border-violet-500',
            item.joined ? "You're in" : "I'm in");
          join.type = 'button';
          join.addEventListener('click', async () => {
            await fetch('/api/items/' + item.id + '/join', { method: 'POST', headers: jsonHeaders });
            loadItems();
          });
          row.appendChild(join);
          list.appendChild(row);
        }
      } catch {
        list.textContent = '';
        list.appendChild(el('p', 'rounded-lg border border-red-900 px-3 py-4 text-center text-sm text-red-300',
          'The board could not load. Try again in a moment.'));
      }
    }

    async function addItem() {
      const input = document.getElementById('plan-title');
      const status = document.getElementById('plan-status');
      const title = input.value.trim();
      if (!title) {
        status.textContent = 'Give it a title first.';
        status.classList.remove('hidden');
        input.focus();
        return;
      }
      const res = await fetch('/api/items', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ title }),
      });
      status.classList.add('hidden');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error || 'Could not add that. Try again.';
        status.classList.remove('hidden');
        return;
      }
      input.value = '';
      loadItems();
    }

    document.getElementById('plan-add').addEventListener('click', addItem);
    document.getElementById('plan-title').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addItem(); }
    });

    loadItems();
  `,

  routes: `// The plan board: everything anyone added, and who is in
app.get('/api/items', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT i.id, i.title, i.username, i.created_at,
             COUNT(j.id)::int AS joins,
             COALESCE(BOOL_OR(j.user_id = $1), FALSE) AS joined
      FROM plan_items i
      LEFT JOIN plan_joins j ON j.item_id = i.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
      LIMIT 200
    \`, [req.user.id]);
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add something to do
app.post('/api/items', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'Give it a title first.' });
  if (title.length > 200) return res.status(400).json({ error: 'Keep the title to 200 characters or fewer.' });
  try {
    const { rows } = await pool.query(\`
      INSERT INTO plan_items (title, user_id, username) VALUES ($1, $2, $3) RETURNING *
    \`, [title, req.user.id, req.user.username]);
    res.status(201).json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// I'm in
app.post('/api/items/:id/join', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown item.' });
  try {
    await pool.query(\`
      INSERT INTO plan_joins (item_id, user_id, username)
      SELECT id, $1, $2 FROM plan_items WHERE id = $3
      ON CONFLICT (item_id, user_id) DO NOTHING
    \`, [req.user.id, req.user.username, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`,

  bootstrapSql: `    CREATE TABLE IF NOT EXISTS plan_items (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plan_joins (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (item_id, user_id)
    );
    INSERT INTO plan_items (title, user_id, username)
    SELECT v.title, 0, 'Starter'
    FROM (VALUES ('Plant the spring bulbs'), ('Pick a book for the group')) AS v(title)
    WHERE NOT EXISTS (SELECT 1 FROM plan_items)`,

  readmeDatabase: 'the\n  demo keeps plan items in a `plan_items` table and who joined them in\n  `plan_joins`.',
  readmeApi: 'the example routes (`/api/items`,\n  `/api/items/:id/join`) read and write a shared plan board through a real\n  Express server.',
  claudeDemo: 'the shared plan board (the demo markup in\n`public/index.html`, the `/api/items` and `/api/items/:id/join` routes, and\nthe `plan_items` and `plan_joins` table bootstrap in `server.js`)',
  claudeRemove: '- remove or repurpose the "Try the example" card, its demo endpoints and\n  the `plan_items` and `plan_joins` tables as appropriate,',
};
