'use strict';

// Social productivity starter: a shared task board. Add a task, tick it
// done, and see who added it. A private list of the group's own tasks, not
// a content feed: it shows task titles and nothing else.

const base = require('./base');

const ROUTES = `// The group's task board: list, add, tick done.
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, title, done, created_at FROM tasks ORDER BY created_at DESC, id DESC LIMIT 100'
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 200) {
      return res.status(400).json({ error: 'A task needs a title of 1 to 200 characters.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO tasks (user_id, username, title) VALUES ($1, $2, $3) RETURNING id, username, title, done, created_at',
      [req.user.id, req.user.username, title]
    );
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown task' });
    const { rows } = await pool.query(
      'UPDATE tasks SET done = NOT done WHERE id = $1 RETURNING id, username, title, done, created_at',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Unknown task' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

const EXAMPLE = `      <div class="flex gap-2">
        <input id="task-title" maxlength="200" placeholder="Add a task" class="flex-1 rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500">
        <button id="task-add" class="rounded-full bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Add</button>
      </div>
      <div id="task-list" class="flex flex-col"></div>`;

const SCRIPT = `    const titleInput = document.getElementById('task-title');
    const addButton = document.getElementById('task-add');
    const list = document.getElementById('task-list');

    function render(tasks) {
      if (!tasks.length) {
        list.innerHTML = '<p class="text-center text-zinc-600 text-sm py-2">No tasks yet. Add the first one above.</p>';
        return;
      }
      list.innerHTML = tasks.map(function (t) {
        return '<div class="flex items-center gap-3 py-2 border-t border-zinc-800">' +
          '<button type="button" data-toggle="' + t.id + '" aria-label="' + (t.done ? 'Mark not done' : 'Mark done') + '" class="w-4 h-4 rounded-full border text-[11px] leading-4 text-center ' + (t.done ? 'bg-violet-600 border-violet-600 text-white' : 'border-zinc-600') + '">' + (t.done ? '\\u2713' : '') + '</button>' +
          '<span class="flex-1 text-sm ' + (t.done ? 'text-zinc-500 line-through' : '') + '">' + esc(t.title) + '</span>' +
          '<span class="text-xs text-zinc-500">@' + esc(t.username) + '</span>' +
          '</div>';
      }).join('');
    }

    async function load() {
      try {
        const res = await fetch('/api/tasks', { headers: headers });
        if (!res.ok) return;
        const data = await res.json();
        render(data.tasks || []);
      } catch (e) {}
    }

    async function add() {
      const title = (titleInput.value || '').trim();
      if (!title) return;
      addButton.disabled = true;
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ title: title }),
        });
        if (res.ok) {
          titleInput.value = '';
          await load();
        }
      } finally {
        addButton.disabled = false;
      }
    }

    addButton.addEventListener('click', add);
    titleInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    list.addEventListener('click', async function (e) {
      const button = e.target.closest('[data-toggle]');
      if (!button) return;
      await fetch('/api/tasks/' + button.getAttribute('data-toggle') + '/toggle', { method: 'POST', headers: headers });
      load();
    });

    load();`;

module.exports = {
  key: 'social',
  name: 'Social productivity',
  caption: 'A shared task board for your group.',
  index({ appName }) {
    return base.page({
      appName,
      intro: 'A shared task board for your group. Add the first thing you want to do together.',
      working: [
        { title: 'Sign-in through Homeroom', text: 'Nobody makes an account; Homeroom already knows who is here.' },
        { title: 'Your own database, storing the tasks', text: 'The board below is read and written through it.' },
        { title: 'A live API behind the board', text: 'Add a task or tick one done and the server answers.' },
      ],
      example: EXAMPLE,
      script: SCRIPT,
    });
  },
  server({ slug }) {
    return base.server({
      slug,
      bootstrap: `    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(200) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
      routes: ROUTES,
    });
  },
  claudeStarter: `## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the task board example (the demo markup in
\`public/index.html\`, the \`/api/tasks\` routes, and the \`tasks\` table
bootstrap in \`server.js\`) — is a starter from Homeroom's Social
productivity template, not product intent.

When the user asks for their first real feature, REPLACE the starter
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the \`tasks\` table as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.`,
  readmeDemo: `- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores the group's tasks in a \`tasks\` table.
- **Live API** — three example routes (\`GET /api/tasks\`, \`POST /api/tasks\`,
  \`POST /api/tasks/:id/toggle\`) read and write through a real Express
  server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};
