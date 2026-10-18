'use strict';

// Multimedia board starter: one group list of films, music, books and
// games, each with an optional link and a short note.
//
// Content rules: no uploads and no images. A link must be an https://
// address and opens with rel="noopener noreferrer". Every item can be
// reported once per person, and an item reported by three different people
// is hidden from the list. Homeroom's own moderation, which suspends the
// whole app, still sits outside this.

const base = require('./base');

const KINDS = ['film', 'music', 'book', 'game'];

const ROUTES = `const MEDIA_KINDS = ['film', 'music', 'book', 'game'];

// The shelf, newest first. Reported and hidden items are left out.
app.get('/api/media', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, kind, title, link, note, created_at FROM media WHERE hidden = FALSE ORDER BY created_at DESC, id DESC LIMIT 100'
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media', async (req, res) => {
  try {
    const kind = typeof req.body.kind === 'string' ? req.body.kind : '';
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const link = typeof req.body.link === 'string' ? req.body.link.trim() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (MEDIA_KINDS.indexOf(kind) === -1) {
      return res.status(400).json({ error: 'Pick a kind: film, music, book or game.' });
    }
    if (!title || title.length > 200) {
      return res.status(400).json({ error: 'An item needs a title of 1 to 200 characters.' });
    }
    if (link && !/^https:\\/\\//.test(link)) {
      return res.status(400).json({ error: 'A link must start with https:// or be left empty.' });
    }
    if (note.length > 280) {
      return res.status(400).json({ error: 'A note can be up to 280 characters.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO media (user_id, username, kind, title, link, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, kind, title, link, note, created_at',
      [req.user.id, req.user.username, kind, title, link || null, note || null]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One report per person. The third distinct report hides the item.
app.post('/api/media/:id/report', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown item' });
    await pool.query(
      'INSERT INTO media_reports (media_id, reporter_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM media_reports WHERE media_id = $1',
      [id]
    );
    if (rows[0].n >= 3) {
      await pool.query('UPDATE media SET hidden = TRUE WHERE id = $1', [id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

const EXAMPLE = `      <div class="flex flex-col gap-2">
        <div class="flex gap-2">
          <select id="media-kind" class="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100">
            <option value="film">Film</option>
            <option value="music">Music</option>
            <option value="book">Book</option>
            <option value="game">Game</option>
          </select>
          <input id="media-title" maxlength="200" placeholder="Title" class="flex-1 rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500">
        </div>
        <input id="media-link" placeholder="Link (optional, https://)" class="rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500">
        <input id="media-note" maxlength="280" placeholder="A short note (optional)" class="rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500">
        <button id="media-add" class="self-start rounded-full bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Add to shelf</button>
      </div>
      <div id="media-list" class="flex flex-col"></div>`;

const SCRIPT = `    const kindInput = document.getElementById('media-kind');
    const titleInput = document.getElementById('media-title');
    const linkInput = document.getElementById('media-link');
    const noteInput = document.getElementById('media-note');
    const addButton = document.getElementById('media-add');
    const list = document.getElementById('media-list');
    const KIND_NAMES = { film: 'Film', music: 'Music', book: 'Book', game: 'Game' };

    function render(items) {
      if (!items.length) {
        list.innerHTML = '<p class="text-center text-zinc-600 text-sm py-2">The shelf is empty. Add the first film, album, book or game.</p>';
        return;
      }
      list.innerHTML = items.map(function (m) {
        var link = m.link
          ? '<a class="text-xs text-violet-300 underline" href="' + esc(m.link) + '" target="_blank" rel="noopener noreferrer">Open link</a>'
          : '';
        var note = m.note ? '<p class="text-xs text-zinc-400">' + esc(m.note) + '</p>' : '';
        return '<div class="flex flex-col gap-1 py-2 border-t border-zinc-800">' +
          '<div class="flex items-center gap-2">' +
          '<span class="rounded-full bg-violet-600/20 text-violet-300 text-[11px] font-semibold px-2 py-0.5">' + esc(KIND_NAMES[m.kind] || m.kind) + '</span>' +
          '<span class="flex-1 text-sm">' + esc(m.title) + '</span>' +
          '<span class="text-xs text-zinc-500">@' + esc(m.username) + '</span>' +
          '</div>' + note +
          '<div class="flex items-center gap-3">' + link +
          '<button type="button" data-report="' + m.id + '" class="text-xs text-zinc-500 underline">Report</button>' +
          '</div></div>';
      }).join('');
    }

    async function load() {
      try {
        const res = await fetch('/api/media', { headers: headers });
        if (!res.ok) return;
        const data = await res.json();
        render(data.items || []);
      } catch (e) {}
    }

    async function add() {
      const title = (titleInput.value || '').trim();
      if (!title) return;
      addButton.disabled = true;
      try {
        const res = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            kind: kindInput.value,
            title: title,
            link: (linkInput.value || '').trim(),
            note: (noteInput.value || '').trim(),
          }),
        });
        if (res.ok) {
          titleInput.value = '';
          linkInput.value = '';
          noteInput.value = '';
          await load();
        }
      } finally {
        addButton.disabled = false;
      }
    }

    addButton.addEventListener('click', add);
    list.addEventListener('click', async function (e) {
      const button = e.target.closest('[data-report]');
      if (!button) return;
      await fetch('/api/media/' + button.getAttribute('data-report') + '/report', { method: 'POST', headers: headers });
      load();
    });

    load();`;

module.exports = {
  key: 'media',
  name: 'Multimedia board',
  caption: 'Films, music, books and games, kept in one list.',
  index({ appName }) {
    return base.page({
      appName,
      intro: 'Films, music, books and games, kept in one list for your group.',
      working: [
        { title: 'Sign-in through Homeroom', text: 'Nobody makes an account; Homeroom already knows who is here.' },
        { title: 'Your own database, storing the shelf', text: 'Every item is one row, with who added it.' },
        { title: 'A live API behind the shelf', text: 'Add an item or report one and the server answers.' },
      ],
      example: EXAMPLE,
      script: SCRIPT,
    });
  },
  server({ slug }) {
    return base.server({
      slug,
      bootstrap: `    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      title VARCHAR(200) NOT NULL,
      link TEXT,
      note VARCHAR(280),
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS media_reports (
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      reporter_user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (media_id, reporter_user_id)
    )`,
      routes: ROUTES,
    });
  },
  claudeStarter: `## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the shelf example (the demo markup in
\`public/index.html\`, the \`/api/media\` routes, and the \`media\` and
\`media_reports\` tables in \`server.js\`) — is a starter from Homeroom's
Multimedia board template, not product intent.

When the user asks for their first real feature, REPLACE the starter
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the \`media\` tables as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.

The shelf accepts no uploads and renders no images, and a link must be an
https:// address. Keep the Report action and the rule that three different
reports hide an item if you keep user-posted rows.`,
  readmeDemo: `- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores the shelf in \`media\` and its reports in \`media_reports\`.
- **Live API** — three example routes (\`GET /api/media\`, \`POST /api/media\`,
  \`POST /api/media/:id/report\`) read and write through a real Express
  server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};
