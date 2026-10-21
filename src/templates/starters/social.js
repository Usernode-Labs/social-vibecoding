'use strict';

/**
 * The Social productivity starter: a shared task board. Anyone in the
 * project adds a task, anyone ticks one off, and the board says how many are
 * done and who added each one.
 */

const { escapeHtml, starterDocument, starterServer } = require('./scaffold');

const TITLE = 'Social productivity';

function document(appName) {
  const body = `    <header>
      <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
      <p class="text-sm text-zinc-400">Shared tasks</p>
    </header>

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <form id="add-form" class="flex gap-2">
        <input id="task-title" type="text" maxlength="140" autocomplete="off"
               placeholder="What needs doing?"
               aria-label="What needs doing?"
               class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none">
        <button type="submit"
                class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500">Add</button>
      </form>
      <p id="progress" class="mt-4 text-xs text-zinc-400">No tasks yet</p>
      <p id="error" class="mt-2 hidden text-sm text-red-400" role="alert"></p>
      <ul id="tasks" class="mt-1 divide-y divide-zinc-800"></ul>
    </section>`;

  const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const list = document.getElementById('tasks');
    const progress = document.getElementById('progress');
    const errorLine = document.getElementById('error');
    const form = document.getElementById('add-form');
    const input = document.getElementById('task-title');

    function say(text) {
      errorLine.textContent = text || '';
      errorLine.classList.toggle('hidden', !text);
    }

    function taskRow(task) {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-3 py-3';
      li.dataset.taskId = String(task.id);

      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = task.done
        ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-xs text-white'
        : 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-zinc-600 text-xs text-transparent hover:border-violet-500';
      tick.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
      tick.setAttribute('aria-pressed', task.done ? 'true' : 'false');
      tick.textContent = '\\u2713';
      tick.addEventListener('click', function () { toggle(task.id); });

      const title = document.createElement('span');
      title.className = task.done
        ? 'min-w-0 flex-1 text-sm font-medium text-zinc-500 line-through'
        : 'min-w-0 flex-1 text-sm font-medium text-zinc-100';
      // A person's own words: textContent, never innerHTML.
      title.textContent = task.title;

      const by = document.createElement('span');
      by.className = 'shrink-0 text-xs text-zinc-500';
      by.textContent = 'Added by @' + task.username;

      li.append(tick, title, by);
      return li;
    }

    function render(tasks) {
      list.replaceChildren();
      for (const task of tasks) list.append(taskRow(task));
      const done = tasks.filter(function (t) { return t.done; }).length;
      progress.textContent = tasks.length
        ? done + ' of ' + tasks.length + ' done'
        : 'No tasks yet';
    }

    async function load() {
      try {
        const res = await fetch('/api/tasks', { headers });
        if (!res.ok) throw new Error('Could not load the tasks.');
        const data = await res.json();
        render(data.tasks || []);
        say('');
      } catch (err) {
        say(err.message || 'Could not load the tasks.');
      }
    }

    async function add(title) {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ title }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Could not add the task.');
      await load();
    }

    async function toggle(id) {
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(id) + '/toggle', {
          method: 'POST',
          headers,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Could not update the task.');
        await load();
      } catch (err) {
        say(err.message || 'Could not update the task.');
      }
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      try {
        await add(title);
        input.value = '';
        say('');
      } catch (err) {
        say(err.message || 'Could not add the task.');
      }
    });

    load();`;

  return starterDocument({ appName, starter: TITLE, body, script });
}

function server(slug) {
  const api = `// The shared task board
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, title, done, done_by, created_at FROM tasks ORDER BY id ASC'
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'Give the task a title.' });
  if (title.length > 140) return res.status(400).json({ error: 'Keep a task to 140 characters.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO tasks (user_id, username, title) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.user.username, title]
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anyone in the project may tick any task off; done_by records who did.
app.post('/api/tasks/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown task.' });
  try {
    const { rows } = await pool.query(
      'UPDATE tasks SET done = NOT done, done_by = CASE WHEN done THEN NULL ELSE $2 END WHERE id = $1 RETURNING *',
      [id, req.user.username]
    );
    if (!rows.length) return res.status(404).json({ error: 'That task is no longer here.' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;
  const schema = `    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(140) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_by VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`;
  return starterServer({ api, schema, slug });
}

module.exports = { key: 'social', title: TITLE, document, server };
