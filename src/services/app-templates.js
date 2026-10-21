'use strict';

/**
 * The starters a new project can begin from (#3521).
 *
 * "Start from a template" in the create dialog offers four ready-made apps
 * beside Start from scratch: Social productivity (a shared to-do list),
 * Multimedia social (a photo wall), 2D game (Star catcher) and 3D game (Gate
 * flight). The chosen key travels `POST /api/apps` → `apps.template_key` →
 * `createApp` → `getTemplateFiles`, which swaps only `public/index.html` and
 * `server.js` for the starter's own screen and API and names the starter in
 * the README and CLAUDE.md. Every other scaffold file (package.json, the
 * Dockerfile, the connector scaffold, the canonical-repo pointer) is the
 * same one every project gets.
 *
 * `empty` is Start from scratch: it has no entry here, and its files stay
 * exactly where they are, in services/template.js. `starterFor` returns null
 * for it.
 *
 * ── What the starters keep from the empty one ────────────────────────
 *
 * The server generator below keeps the empty starter's auth block (RS256
 * only, issuer `usernode`, audience `usernode:app:<id>`), the hosted-asset
 * proxy for the three relative platform paths, the static handler and the
 * open-in-Homeroom fallback. It requires only express, path, pg and
 * jsonwebtoken — the sandbox the scaffold tests run a starter in.
 *
 * Each screen carries the `usernode-starter-notice@1` block, the
 * `usernode-dev-console@1` forwarder (passed in by template.js, which owns
 * it), `<link rel="stylesheet" href="/tailwind.css">` and the relative
 * bridge script, and loads nothing from another origin.
 *
 * ── Content ──────────────────────────────────────────────────────────
 *
 * No weapons, enemies, combat, wagers or loot: the 2D game collects stars
 * against a clock and the 3D game steers through gates, and both keep a
 * plain best-score list. The photo wall has a Report button that hides a
 * post at once for everyone.
 */

const TEMPLATE_KEYS = ['empty', 'social', 'multimedia', 'game2d', 'game3d'];

const NAMED_TEMPLATES = {
  social: {
    key: 'social',
    title: 'Social productivity',
    caption: 'A shared to-do list your group keeps together.',
    summary: 'Your group’s to-do list',
    tables: `CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(200) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    routes: `// The shared to-do list, newest first.
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, done, username, created_at FROM tasks ORDER BY id DESC LIMIT 100'
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title || title.length > 200) {
    return res.status(400).json({ error: 'A task needs a title of 1 to 200 characters.' });
  }
  try {
    const { rows } = await pool.query(
      \`INSERT INTO tasks (user_id, username, title) VALUES ($1, $2, $3)
       RETURNING id, title, done, username, created_at\`,
      [req.user.id, req.user.username, title]
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      \`UPDATE tasks SET done = NOT done WHERE id = $1
       RETURNING id, title, done, username, created_at\`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'There is no such task.' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`,
  },
  multimedia: {
    key: 'multimedia',
    title: 'Multimedia social',
    caption: 'A photo wall: post a picture and a caption.',
    summary: 'The wall',
    tables: `CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption VARCHAR(280) NOT NULL,
      image_url TEXT,
      image_id TEXT,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  CREATE TABLE IF NOT EXISTS post_reports (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    routes: `// The wall: posts nobody has reported, newest first.
app.get('/api/posts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      \`SELECT id, username, caption, image_url, created_at FROM posts
       WHERE hidden = FALSE ORDER BY id DESC LIMIT 50\`
    );
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : '';
  if (!caption || caption.length > 280) {
    return res.status(400).json({ error: 'A post needs a caption of 1 to 280 characters.' });
  }
  // A photo has to be one Homeroom stored for this app: the wall never
  // loads an image from another origin. No origin configured means no
  // photo, and a caption on its own still posts.
  const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl.trim() : '';
  if (imageUrl) {
    const prefix = (PLATFORM_ORIGIN || '') + '/app-files/';
    if (!PLATFORM_ORIGIN || !imageUrl.startsWith(prefix)) {
      return res.status(400).json({ error: 'Photos have to be uploaded through Homeroom.' });
    }
  }
  try {
    const { rows } = await pool.query(
      \`INSERT INTO posts (user_id, username, caption, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, caption, image_url, created_at\`,
      [req.user.id, req.user.username, caption, imageUrl || null]
    );
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One report hides the post for everyone, at once.
app.post('/api/posts/:id/report', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE posts SET hidden = TRUE WHERE id = $1 AND hidden = FALSE RETURNING id',
      [req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'There is no such post.' });
    }
    await client.query(
      'INSERT INTO post_reports (post_id, user_id) VALUES ($1, $2)',
      [rows[0].id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});`,
  },
  game2d: {
    key: 'game2d',
    title: '2D game',
    caption: 'A canvas game: collect as many stars as you can in 30 seconds.',
    summary: 'Star catcher',
    tables: `CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    routes: SCORE_ROUTES(),
  },
  game3d: {
    key: 'game3d',
    title: '3D game',
    caption: 'A first-person game: steer through gates drawn in 3D.',
    summary: 'Gate flight',
    tables: `CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    routes: SCORE_ROUTES(),
  },
};

// Both games keep the same plain best-score list: a ranking, nothing wagered.
function SCORE_ROUTES() {
  return `// The best scores, highest first.
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, score FROM scores ORDER BY score DESC, created_at ASC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  const score = req.body.score;
  if (!Number.isInteger(score) || score < 0 || score > 500) {
    return res.status(400).json({ error: 'A score is a whole number from 0 to 500.' });
  }
  try {
    await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
      [req.user.id, req.user.username, score]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;
}

/** Whether a key names one of the five templates (services/create-options.js). */
function isTemplateKey(key) {
  return typeof key === 'string' && TEMPLATE_KEYS.includes(key);
}

/**
 * The starter for a key, or null for `empty` (and for anything unknown, so
 * an old row or a hand-written value can never fail a Retry). `index` is
 * the starter's `public/index.html`, `server` its `server.js`.
 */
function starterFor(key, { appName, slug, forwarder } = {}) {
  const t = NAMED_TEMPLATES[key];
  if (!t) return null;
  return {
    key: t.key,
    title: t.title,
    caption: t.caption,
    summary: t.summary,
    index: renderScreen(t.key, appName, forwarder),
    server: renderServer({ slug, tables: t.tables, routes: t.routes }),
  };
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The notice every starter screen opens with, in the empty starter's words. */
function starterNotice(appName) {
  return `    <!-- usernode-starter-notice@1 — starter-template messaging. When building
         the user's real app, replace this whole screen and delete this block,
         both sentinel comments included. -->
    <section class="rounded-2xl border border-violet-500/30 bg-gradient-to-b from-violet-600/20 to-transparent p-5 text-center flex flex-col items-center gap-2">
      <span class="inline-block rounded-full bg-violet-600/20 text-violet-300 text-xs font-semibold uppercase tracking-wide px-3 py-1">Starter template</span>
      <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
      <p class="text-sm text-zinc-300 leading-relaxed">Tap the <strong class="text-violet-300 font-semibold">Homeroom icon</strong> in the header, choose <strong class="text-violet-300 font-semibold">Start a new change</strong>, and make it yours.</p>
    </section>
    <!-- /usernode-starter-notice@1 -->`;
}

const CARD = 'rounded-xl border border-zinc-800 bg-zinc-900/60 p-4';
const FIELD = 'w-full rounded-lg border-0 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500';
const BUTTON = 'rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 active:scale-95 transition-all';

function pageHead(appName, forwarder) {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${forwarder || ''}
  <title>${escapeHtml(appName)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">
  <link rel="stylesheet" href="/tailwind.css">
  <script src="/usernode-bridge/v1/bridge.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen">
  <main class="max-w-md mx-auto px-4 py-8 flex flex-col gap-4">

${starterNotice(appName)}
`;
}

function pageFoot(script) {
  return `  </main>

  <script>
${script}
  </script>
</body>
</html>
`;
}

const API_HELPERS = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    async function api(path, options) {
      const opts = options || {};
      opts.headers = Object.assign({}, opts.body ? { 'Content-Type': 'application/json' } : {}, headers, opts.headers || {});
      return fetch(path, opts);
    }`;

function renderScreen(key, appName, forwarder) {
  const head = pageHead(appName, forwarder);
  if (key === 'social') {
    return head + `    <section class="${CARD}">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Your group’s to-do list</h2>
        <span id="done-count" class="text-xs text-zinc-500"></span>
      </div>
      <form id="task-form" class="mt-3 flex gap-2">
        <input id="task-title" class="${FIELD}" type="text" maxlength="200" placeholder="Add a task" autocomplete="off" aria-label="Add a task">
        <button id="add-task" class="${BUTTON}" type="submit">Add task</button>
      </form>
      <div id="task-list" class="mt-3 flex flex-col"></div>
      <p id="empty" class="mt-3 text-center text-sm text-zinc-500 hidden">Nothing on the list yet. Add the first task.</p>
    </section>
` + pageFoot(`    const list = document.getElementById('task-list');
    const empty = document.getElementById('empty');
    const count = document.getElementById('done-count');
    let tasks = [];

${API_HELPERS}

    function paint() {
      const done = tasks.filter(function (t) { return t.done; }).length;
      count.textContent = tasks.length ? done + ' of ' + tasks.length + ' done' : '';
      empty.classList.toggle('hidden', tasks.length > 0);
      list.textContent = '';
      tasks.forEach(function (task) {
        const row = el('div', 'flex items-center gap-3 border-t border-zinc-800 py-2 first:border-t-0');
        const box = el('button', 'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border ' +
          (task.done ? 'border-violet-600 bg-violet-600 text-white' : 'border-zinc-600'), task.done ? '✓' : '');
        box.type = 'button';
        box.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
        box.addEventListener('click', function () { toggle(task.id); });
        const text = el('span', 'min-w-0 flex-1');
        const title = el('span', task.done ? 'block text-sm text-zinc-500 line-through' : 'block text-sm', task.title);
        const who = el('span', 'block text-[11px] text-zinc-500', 'Added by @' + task.username);
        text.appendChild(title);
        text.appendChild(who);
        row.appendChild(box);
        row.appendChild(text);
        list.appendChild(row);
      });
    }

    async function load() {
      const res = await api('/api/tasks');
      if (!res.ok) return;
      const data = await res.json();
      tasks = data.tasks || [];
      paint();
    }

    async function toggle(id) {
      const res = await api('/api/tasks/' + encodeURIComponent(id) + '/toggle', { method: 'POST' });
      if (res.ok) load();
    }

    document.getElementById('task-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      const input = document.getElementById('task-title');
      const title = input.value.trim();
      if (!title) return;
      const res = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: title }) });
      if (res.ok) { input.value = ''; load(); }
    });

    load();
`);
  }

  if (key === 'multimedia') {
    return head + `    <section class="${CARD}">
      <h2 class="text-sm font-medium text-zinc-500">The wall</h2>
      <form id="post-form" class="mt-3 flex flex-col gap-2">
        <input id="post-photo" class="text-sm text-zinc-400" type="file" accept="image/*" aria-label="Photo">
        <p id="photo-note" class="text-xs text-zinc-500 hidden">Photos upload through Homeroom, inside the app. A caption on its own still posts.</p>
        <input id="post-caption" class="${FIELD}" type="text" maxlength="280" placeholder="Say something about it" autocomplete="off" aria-label="Caption">
        <button id="post-send" class="${BUTTON} self-end" type="submit">Post</button>
      </form>
      <div id="post-list" class="mt-4 flex flex-col gap-3"></div>
      <p id="empty" class="mt-3 text-center text-sm text-zinc-500 hidden">Nothing here yet. Post the first photo.</p>
      <p id="status" class="mt-2 text-center text-xs text-zinc-500"></p>
    </section>
` + pageFoot(`    const list = document.getElementById('post-list');
    const empty = document.getElementById('empty');
    const status = document.getElementById('status');
    const photo = document.getElementById('post-photo');
    const bridge = window.usernode;
    const canUpload = !!(bridge && typeof bridge.uploadFile === 'function');
    if (!canUpload) {
      photo.classList.add('hidden');
      document.getElementById('photo-note').classList.remove('hidden');
    }

${API_HELPERS}

    function paint(posts) {
      empty.classList.toggle('hidden', posts.length > 0);
      list.textContent = '';
      posts.forEach(function (post) {
        const card = el('article', 'rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden');
        if (post.image_url) {
          const img = el('img', 'w-full max-h-72 object-cover');
          img.src = post.image_url;
          img.alt = 'Photo posted by @' + post.username;
          card.appendChild(img);
        }
        const body = el('div', 'p-3 flex flex-col gap-1');
        body.appendChild(el('p', 'text-sm text-zinc-200', post.caption));
        const foot = el('div', 'flex items-center justify-between gap-2');
        foot.appendChild(el('span', 'text-[11px] text-zinc-500', 'Posted by @' + post.username));
        const report = el('button', 'text-[11px] font-medium text-zinc-400 hover:text-zinc-200', 'Report');
        report.type = 'button';
        report.addEventListener('click', function () { reportPost(post.id, report); });
        foot.appendChild(report);
        body.appendChild(foot);
        card.appendChild(body);
        list.appendChild(card);
      });
    }

    async function load() {
      const res = await api('/api/posts');
      if (!res.ok) return;
      const data = await res.json();
      paint(data.posts || []);
    }

    async function reportPost(id, button) {
      button.disabled = true;
      const res = await api('/api/posts/' + encodeURIComponent(id) + '/report', { method: 'POST' });
      if (res.ok) { status.textContent = 'Reported. The post is off the wall.'; load(); }
      else { button.disabled = false; status.textContent = 'Couldn’t report that post. Try again.'; }
    }

    document.getElementById('post-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      const captionInput = document.getElementById('post-caption');
      const caption = captionInput.value.trim();
      if (!caption) { status.textContent = 'Add a caption to post.'; return; }
      let imageUrl = '';
      const file = photo.files && photo.files[0];
      try {
        if (file && canUpload) {
          const uploaded = await bridge.uploadFile(file, { visibility: 'public' });
          imageUrl = (uploaded && uploaded.url) || '';
        }
      } catch (err) {
        status.textContent = 'Couldn’t upload that photo. A caption alone still posts.';
      }
      const res = await api('/api/posts', { method: 'POST', body: JSON.stringify({ caption: caption, imageUrl: imageUrl }) });
      if (!res.ok) {
        const data = await res.json().catch(function () { return {}; });
        status.textContent = data.error || 'Couldn’t post that. Try again.';
        return;
      }
      captionInput.value = '';
      photo.value = '';
      status.textContent = '';
      load();
    });

    load();
`);
  }

  if (key === 'game2d') {
    return head + `    <section class="${CARD}">
      <h2 class="text-sm font-medium text-zinc-500">Star catcher</h2>
      <div class="mt-3 relative rounded-[10px] border border-zinc-800 bg-zinc-950 overflow-hidden">
        <canvas id="board" width="352" height="300" class="block w-full"></canvas>
        <span id="clock" class="absolute right-3 top-2 text-xs text-zinc-400"></span>
      </div>
      <p class="mt-3 text-sm text-zinc-300">Collect as many stars as you can in 30 seconds.</p>
      <p id="score" class="mt-1 text-sm text-zinc-400">Stars: 0</p>
      <button id="play" class="${BUTTON} mt-3 w-full" type="button">Play</button>
    </section>
    <section class="${CARD}">
      <h2 class="mb-2 text-sm font-medium text-zinc-500">Best scores</h2>
      <div id="scores" class="flex flex-col gap-1 text-sm text-zinc-400"></div>
      <p id="empty" class="mt-2 text-center text-sm text-zinc-500 hidden">No scores yet. Play the first round.</p>
    </section>
` + pageFoot(`    const canvas = document.getElementById('board');
    const g = canvas.getContext('2d');
    const clock = document.getElementById('clock');
    const playBtn = document.getElementById('play');
    const scoreList = document.getElementById('scores');
    const empty = document.getElementById('empty');
    const scoreLine = document.getElementById('score');
    const ROUND = 30;
    const W = canvas.width;
    const H = canvas.height;
    let player = W / 2;
    let stars = [];
    let score = 0;
    let left = ROUND;
    let playing = false;
    let last = 0;
    let until = 0;

${API_HELPERS}

    function draw() {
      g.fillStyle = '#09090b';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#fbbf24';
      stars.forEach(function (s) {
        g.beginPath();
        g.arc(s.x, s.y, 5, 0, Math.PI * 2);
        g.fill();
      });
      g.fillStyle = '#a78bfa';
      g.beginPath();
      g.arc(player, H - 32, 12, 0, Math.PI * 2);
      g.fill();
    }

    function tick(now) {
      if (!playing) return;
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      stars.forEach(function (s) { s.y += s.speed * dt; });
      stars = stars.filter(function (s) {
        if (s.y > H - 32 - 12 && s.y < H - 32 + 12 && Math.abs(s.x - player) < 18) { score += 1; return false; }
        return s.y < H + 10;
      });
      if (now > until) {
        stars.push({ x: 20 + Math.random() * (W - 40), y: -10, speed: 90 + Math.random() * 60 });
      }
      left = Math.max(0, (until - now) / 1000);
      clock.textContent = '0:' + (left < 10 ? '0' : '') + Math.ceil(left);
      scoreLine.textContent = 'Stars: ' + score;
      draw();
      if (left <= 0) return finish();
      requestAnimationFrame(tick);
    }

    function steer(x) {
      player = Math.max(16, Math.min(W - 16, x));
      if (!playing) draw();
    }

    canvas.addEventListener('pointermove', function (event) {
      const rect = canvas.getBoundingClientRect();
      steer((event.clientX - rect.left) * (W / rect.width));
    });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') steer(player - 24);
      if (event.key === 'ArrowRight') steer(player + 24);
    });

    async function finish() {
      playing = false;
      clock.textContent = '0:00';
      playBtn.textContent = 'Play again';
      if (score > 0) {
        await api('/api/scores', { method: 'POST', body: JSON.stringify({ score: score }) });
      }
      loadScores();
    }

    playBtn.addEventListener('click', function () {
      playing = true;
      score = 0;
      left = ROUND;
      stars = [];
      last = 0;
      scoreLine.textContent = 'Stars: 0';
      until = performance.now() + ROUND * 1000;
      playBtn.textContent = 'Playing…';
      requestAnimationFrame(tick);
    });

    async function loadScores() {
      const res = await api('/api/scores');
      if (!res.ok) return;
      const data = await res.json();
      const scores = data.scores || [];
      empty.classList.toggle('hidden', scores.length > 0);
      scoreList.textContent = '';
      scores.forEach(function (row, i) {
        const line = el('div', 'flex justify-between gap-2');
        line.appendChild(el('span', null, (i + 1) + '. @' + row.username));
        line.appendChild(el('span', 'tabular-nums', String(row.score)));
        scoreList.appendChild(line);
      });
    }

    draw();
    clock.textContent = '0:30';
    loadScores();
`);
  }

  // game3d
  return head + `    <section class="${CARD}">
      <h2 class="text-sm font-medium text-zinc-500">Gate flight</h2>
      <div class="mt-3 rounded-[10px] border border-zinc-800 bg-zinc-950 overflow-hidden">
        <canvas id="view" width="352" height="300" class="block w-full"></canvas>
      </div>
      <p class="mt-3 text-sm text-zinc-300">Steer through each gate. One miss ends the run.</p>
      <p id="gates" class="mt-1 text-sm text-zinc-400">Gates passed: 0</p>
      <button id="play" class="${BUTTON} mt-3 w-full" type="button">Play</button>
    </section>
    <section class="${CARD}">
      <h2 class="mb-2 text-sm font-medium text-zinc-500">Best runs</h2>
      <div id="scores" class="flex flex-col gap-1 text-sm text-zinc-400"></div>
      <p id="empty" class="mt-2 text-center text-sm text-zinc-500 hidden">No runs yet. Fly the first one.</p>
    </section>
` + pageFoot(`    const canvas = document.getElementById('view');
    const g = canvas.getContext('2d');
    const playBtn = document.getElementById('play');
    const scoreList = document.getElementById('scores');
    const empty = document.getElementById('empty');
    const gateLine = document.getElementById('gates');
    const W = canvas.width;
    const H = canvas.height;
    const FOCAL = 240;
    const GATE_EVERY = 900;
    let player = 0;      // -1 (left edge) to 1 (right edge)
    let gates = 0;
    let passed = 0;
    let nextGateAt = 0;
    let playing = false;
    let last = 0;

${API_HELPERS}

    function project(x, y, z) {
      const scale = FOCAL / Math.max(z, 1);
      return { x: W / 2 + x * scale, y: H / 2 + y * scale, scale: scale };
    }

    function draw() {
      // Sky and ground, split at the horizon: the perspective is the drawing.
      g.fillStyle = '#0b0b16';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#18181b';
      g.beginPath();
      g.moveTo(0, H);
      g.lineTo(W, H);
      g.lineTo(W / 2, H / 2);
      g.lineTo(0, H / 2);
      g.closePath();
      g.fill();

      // Road edges, converging on the vanishing point.
      g.strokeStyle = '#3f3f46';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(W / 2 - 30, H / 2);
      g.lineTo(0, H);
      g.moveTo(W / 2 + 30, H / 2);
      g.lineTo(W, H);
      g.stroke();

      // The next gate, nearer as the run goes on.
      const z = Math.max(20, nextGateAt - passed * GATE_EVERY + GATE_EVERY);
      const half = 60;
      const top = project(-half, -70, z);
      const bottom = project(-half, 40, z);
      const right = project(half, -70, z);
      g.strokeStyle = '#a78bfa';
      g.lineWidth = Math.max(1, 6 * (bottom.scale / 6));
      g.strokeRect(top.x, top.y, right.x - top.x, bottom.y - top.y);

      // Your ship, at the vanishing point, steered left and right.
      const ship = project(player * 70, 20, 40);
      g.fillStyle = '#c4b5fd';
      g.beginPath();
      g.arc(ship.x, ship.y, 7, 0, Math.PI * 2);
      g.fill();
    }

    function tick(now) {
      if (!playing) return;
      const dt = last ? Math.min(now - last, 120) : 0;
      last = now;
      nextGateAt += dt * 0.35;
      if (nextGateAt - passed * GATE_EVERY >= GATE_EVERY) gate();
      draw();
      requestAnimationFrame(tick);
    }

    async function gate() {
      passed += 1;
      gateLine.textContent = 'Gates passed: ' + passed;
      // A gate is passed when you are on its side of the road.
      if (Math.abs(player) > 0.45) return finish();
    }

    function steer(x) {
      player = Math.max(-1, Math.min(1, x));
      if (!playing) draw();
    }

    canvas.addEventListener('pointermove', function (event) {
      const rect = canvas.getBoundingClientRect();
      steer(((event.clientX - rect.left) / rect.width) * 2 - 1);
    });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') steer(player - 0.25);
      if (event.key === 'ArrowRight') steer(player + 0.25);
    });

    async function finish() {
      playing = false;
      playBtn.textContent = 'Fly again';
      gateLine.textContent = 'Gates passed: ' + passed + '. Your run ended on a missed gate.';
      gates = passed;
      if (gates > 0) {
        await api('/api/scores', { method: 'POST', body: JSON.stringify({ score: Math.min(gates, 500) }) });
      }
      loadScores();
    }

    playBtn.addEventListener('click', function () {
      playing = true;
      passed = 0;
      nextGateAt = 0;
      last = 0;
      gateLine.textContent = 'Gates passed: 0';
      playBtn.textContent = 'Flying…';
      draw();
      requestAnimationFrame(tick);
    });

    async function loadScores() {
      const res = await api('/api/scores');
      if (!res.ok) return;
      const data = await res.json();
      const scores = data.scores || [];
      empty.classList.toggle('hidden', scores.length > 0);
      scoreList.textContent = '';
      scores.forEach(function (row, i) {
        const line = el('div', 'flex justify-between gap-2');
        line.appendChild(el('span', null, (i + 1) + '. @' + row.username));
        line.appendChild(el('span', 'tabular-nums', String(row.score)));
        scoreList.appendChild(line);
      });
    }

    draw();
    loadScores();
`);
}

/**
 * The starter's `server.js`. The same auth, hosted-asset proxy, static
 * handler and open-in-Homeroom fallback as the empty starter, with the
 * starter's own table bootstrap and API routes in place of the press demo.
 */
function renderServer({ slug, tables, routes }) {
  return `const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\\\n/g, '\\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\\/+$/, '');

// The platform's three centrally hosted files, answered by this process
// under a plain \`node server.js\` where no edge sits in front of the app.
app.get(/^\\/usernode-(?:bridge|native|tailwind)\\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify the platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly public.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without \`algorithms\` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/favicon.ico', (_req, res) => res.status(204).end());

${routes}

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits are sent to the platform's chromeless view of this app.
app.get('*', (req, res) => {
  if (!req.user) {
    const deepPath = /^\\/[A-Za-z0-9\\-._~!$&()*+,;=:@\\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/${slug}/full' + deepPath);
    }
    return res.status(401).send(\`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="\${PLATFORM_ORIGIN}/app/${slug}/full\${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>\`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(\`
    ${tables}
  \`);
  const server = app.listen(port, () => console.log(\`Listening on :\${port}\`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
`;
}

module.exports = {
  TEMPLATE_KEYS,
  NAMED_TEMPLATES,
  isTemplateKey,
  starterFor,
};
