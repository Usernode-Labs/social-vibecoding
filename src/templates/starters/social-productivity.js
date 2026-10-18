'use strict';

/**
 * Starter: Social productivity — a shared checklist the group adds to and
 * ticks off together (request #3521). The demo routes below and the example
 * card they feed replace the generic Press! starter's demo blocks when a
 * project is created from this template (services/template.js).
 *
 * Everything else the scaffold ships — the auth chassis, the hosted-asset
 * handler, the welcome card — is unchanged; only this demo differs.
 */

module.exports = {
  id: 'social-productivity',
  title: 'Social productivity',
  caption: 'A shared checklist the group adds to and ticks off together.',
  exampleNote: 'the shared-checklist example (the demo markup in `public/index.html`, the `/api/tasks` routes, and the `tasks` table bootstrap in `server.js`)',
  demoTable: 'tasks',
  readmeExample: `- **Database** — the app has its own private Postgres database; the
  demo stores tasks in a \`tasks\` table.
- **Live API** — the checklist routes (\`/api/tasks\` and friends) read
  and write through a real Express server.`,

  /** The demo route block and the demo table's DDL for server.js. */
  demoServer() {
    return {
      ddl: `CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      text VARCHAR(500) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
      routes: `// The shared checklist. A task is at most 500 characters of text —
// checked here, and bounded in the table itself.
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, text, done, created_at FROM tasks ORDER BY id ASC'
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 500) {
    return res.status(400).json({ error: 'A task is 1-500 characters of text.' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO tasks (user_id, username, text) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.user.username, text]
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE tasks SET done = NOT done WHERE id = $1 RETURNING *',
      [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such task' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`,
    };
  },

  /** The example card's markup and its inline script for public/index.html. */
  demoScreen() {
    return {
      markup: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <div class="w-full max-w-sm flex gap-2">
        <input id="task-input" type="text" maxlength="500" placeholder="Add a task, e.g. Buy snacks"
          class="flex-1 min-w-0 rounded-full bg-zinc-800 border border-zinc-700 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-violet-500" />
        <button id="task-add" class="rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-sm font-semibold px-4 py-2 shadow-lg shadow-violet-600/30">
          Add
        </button>
      </div>

      <div id="task-count" class="text-sm text-zinc-400">0 open tasks</div>

      <div id="task-list" class="w-full max-w-sm space-y-1"></div>
    </section>`,
      script: `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function taskRow(t) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-800/60';
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.setAttribute('aria-label', t.done ? 'Mark not done' : 'Mark done');
      tick.className = 'w-6 h-6 shrink-0 rounded-full border text-xs ' + (t.done
        ? 'bg-violet-600 border-violet-600 text-white'
        : 'border-zinc-600 text-transparent hover:border-violet-500');
      tick.textContent = '✓';
      const label = document.createElement('span');
      label.className = 'flex-1 min-w-0 text-sm ' + (t.done ? 'text-zinc-500 line-through' : 'text-zinc-100');
      label.textContent = t.text;
      const who = document.createElement('span');
      who.className = 'shrink-0 text-xs text-zinc-500';
      who.textContent = t.username;
      row.append(tick, label, who);
      tick.addEventListener('click', async function () {
        try {
          const res = await fetch('/api/tasks/' + t.id + '/toggle', { method: 'POST', headers: headers });
          if (res.ok) loadTasks();
        } catch (e) {}
      });
      return row;
    }

    async function loadTasks() {
      const res = await fetch('/api/tasks', { headers });
      if (!res.ok) return;
      const data = await res.json();
      const list = document.getElementById('task-list');
      const tasks = data.tasks || [];
      list.innerHTML = '';
      if (!tasks.length) {
        list.innerHTML = '<p class="text-center text-zinc-600 text-sm">No tasks yet — add the first one</p>';
      }
      for (const t of tasks) list.appendChild(taskRow(t));
      const open = tasks.filter(function (t) { return !t.done; }).length;
      document.getElementById('task-count').textContent =
        open === 1 ? '1 open task' : open + ' open tasks';
    }

    async function addTask() {
      const input = document.getElementById('task-input');
      const text = (input.value || '').trim();
      if (!text) return;
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ text: text })
        });
        if (res.ok) { input.value = ''; loadTasks(); }
      } catch (e) {}
    }

    document.getElementById('task-add').addEventListener('click', addTask);
    document.getElementById('task-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addTask();
    });

    loadTasks();`,
    };
  },
};
