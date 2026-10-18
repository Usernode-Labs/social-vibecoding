'use strict';

// The "Social productivity app" starter: a shared task list. See index.js for
// the shape every starter module shares.

const id = 'social-productivity';
const label = 'Social productivity app';
const caption = 'A shared task list for your community.';

const docs = {
  claude: `The screen this app currently ships is a **Shared tasks** example (the
demo markup in \`public/index.html\`, the \`/api/tasks\` routes, and the
\`tasks\` table bootstrap in \`server.js\`) — placeholder content from the
Homeroom starter template, not product intent.`,
  readme: `The scaffold is a small working demo that proves the plumbing works:

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores shared tasks in a \`tasks\` table.
- **Live API** — three example routes (\`GET /api/tasks\`,
  \`POST /api/tasks\`, \`PATCH /api/tasks/:id\`) read and write through a
  real Express server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};

const routes = `// Shared tasks — everyone in this project sees and edits one list
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT id, title, done, username, created_at
      FROM tasks
      ORDER BY created_at DESC, id DESC
    \`);
    const done = rows.filter((row) => row.done).length;
    res.json({ tasks: rows, done, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'Give the task a title' });
  if (title.length > 200) {
    return res.status(400).json({ error: 'Keep the title to 200 characters or fewer' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO tasks (title, user_id, username) VALUES ($1, $2, $3)
      RETURNING id, title, done, username, created_at
    \`, [title, req.user.id, req.user.username]);
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The list belongs to everyone, so any member may tick any task off.
app.patch('/api/tasks/:id', async (req, res) => {
  if (typeof req.body.done !== 'boolean') {
    return res.status(400).json({ error: 'done must be true or false' });
  }
  try {
    const { rows } = await pool.query(\`
      UPDATE tasks SET done = $1 WHERE id = $2
      RETURNING id, title, done, username, created_at
    \`, [req.body.done, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;

const bootstrap = `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);
`;

function body() {
  return `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>
      <h3 class="text-base font-semibold mt-4">Shared tasks</h3>
      <p class="text-[13px] text-zinc-400 m-0">Everyone in this project sees the same list.</p>
      <p id="task-count" class="text-[13px] text-zinc-400 mt-3 mb-3">0 of 0 done</p>
      <form id="task-form" class="flex gap-2">
        <input id="task-title" maxlength="200" placeholder="Add a task"
               class="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500">
        <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-4 py-2 text-sm font-semibold">Add</button>
      </form>
      <p id="task-empty" class="text-[13px] text-zinc-500 mt-3.5">No tasks yet. Add the first one.</p>
      <ul id="task-list" class="mt-2 space-y-1"></ul>
    </section>`;
}

const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const listEl = document.getElementById('task-list');
    const countEl = document.getElementById('task-count');
    const emptyEl = document.getElementById('task-empty');

    function render(payload) {
      const tasks = payload.tasks || [];
      const total = payload.total || 0;
      const done = payload.done || 0;
      countEl.textContent = done + ' of ' + total + ' done';
      emptyEl.style.display = total ? 'none' : '';
      listEl.textContent = '';
      tasks.forEach(function (task) {
        const row = document.createElement('li');
        row.className = 'flex items-center gap-2 px-1 py-1.5';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!task.done;
        box.className = 'accent-violet-600';
        box.addEventListener('change', function () { toggle(task.id, box.checked); });
        const title = document.createElement('span');
        title.textContent = task.title;
        title.className = 'flex-1 min-w-0 text-sm ' + (task.done ? 'text-zinc-500 line-through' : 'text-zinc-100');
        const who = document.createElement('span');
        who.textContent = task.username;
        who.className = 'text-xs text-zinc-600 shrink-0';
        row.append(box, title, who);
        listEl.appendChild(row);
      });
    }

    async function load() {
      try {
        const res = await fetch('/api/tasks', { headers: headers });
        if (!res.ok) return;
        render(await res.json());
      } catch (err) {}
    }

    async function toggle(id, done) {
      try {
        const res = await fetch('/api/tasks/' + id, {
          method: 'PATCH',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ done: done }),
        });
        if (res.ok) load();
      } catch (err) {}
    }

    document.getElementById('task-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      const input = document.getElementById('task-title');
      const title = input.value.trim();
      if (!title) return;
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ title: title }),
        });
        if (res.ok) {
          input.value = '';
          load();
        }
      } catch (err) {}
    });

    load();`;

module.exports = { id, label, caption, docs, routes, bootstrap, body, script };
