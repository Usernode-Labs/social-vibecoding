'use strict';

/**
 * Starter: Multimedia social — a picture feed the group posts to, newest
 * first (request #3521). Pictures ride the POST body as data URLs (at most
 * 2 MB decoded) and are stored as bytes in the project's own database;
 * they are served back only through the authed image route, which the
 * page's own token already satisfies. DELETE removes only the caller's
 * own post.
 *
 * The only chassis line this starter replaces is the JSON body parser: a
 * picture at the platform's 100 kb default limit would never arrive.
 */

module.exports = {
  id: 'multimedia-social',
  title: 'Multimedia social',
  caption: 'A picture feed your group posts to, newest first.',
  exampleNote: 'the picture-feed example (the demo markup in `public/index.html`, the `/api/posts` routes, and the `posts` table bootstrap in `server.js`)',
  demoTable: 'posts',
  readmeExample: `- **Database** — the app has its own private Postgres database; the
  demo stores posts and their pictures in a \`posts\` table.
- **Live API** — the feed routes (\`/api/posts\` and friends) read and
  write through a real Express server.`,

  /** The demo route block, the demo table's DDL, and the body-limit line. */
  demoServer() {
    return {
      // The scaffold's own line, widened for a picture in the body.
      expressJson: `app.use(express.json({ limit: '3mb' }));`,
      ddl: `CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption VARCHAR(280) NOT NULL DEFAULT '',
      image BYTEA NOT NULL,
      mime VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
      routes: `// The picture feed. Pictures arrive as data URLs, are decoded and
// bounded here (PNG, JPEG or WebP, at most 2 MB decoded), and are stored
// in the app's own database — never served from anywhere but the authed
// route below, which the page's own token already satisfies.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

app.get('/api/posts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, caption, mime, created_at FROM posts ORDER BY id DESC'
    );
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim().slice(0, 280) : '';
  const dataUrl = typeof req.body.image === 'string' ? req.body.image : '';
  const match = /^data:(image\\/(?:png|jpeg|webp));base64,([A-Za-z0-9+\\/=]+)$/.exec(dataUrl);
  if (!match || !IMAGE_TYPES.has(match[1])) {
    return res.status(400).json({ error: 'Pick a picture (PNG, JPEG or WebP) first.' });
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) {
    return res.status(400).json({ error: 'That picture is empty.' });
  }
  if (bytes.length > IMAGE_MAX_BYTES) {
    return res.status(400).json({ error: 'Pictures are at most 2 MB.' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO posts (user_id, username, caption, image, mime) VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, username, caption, mime, created_at',
      [req.user.id, req.user.username, caption, bytes, match[1]]
    );
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/:id/image', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT image, mime FROM posts WHERE id = $1',
      [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such post' });
    res.type(rows[0].mime || 'image/png').send(rows[0].image);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id',
      [Number(req.params.id), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such post of yours' });
    res.json({ ok: true });
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

      <div class="w-full max-w-sm space-y-2">
        <input id="post-file" type="file" accept="image/png,image/jpeg,image/webp"
          class="w-full text-sm text-zinc-400 file:mr-3 file:rounded-full file:border-0 file:bg-violet-600/20 file:px-4 file:py-1.5 file:text-violet-300 file:text-sm file:font-semibold hover:file:bg-violet-600/30" />
        <input id="post-caption" type="text" maxlength="280" placeholder="Say something about it"
          class="w-full rounded-full bg-zinc-800 border border-zinc-700 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-violet-500" />
        <button id="post-submit" class="w-full rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-sm font-semibold px-4 py-2 shadow-lg shadow-violet-600/30">
          Post
        </button>
      </div>

      <div id="post-feed" class="w-full max-w-sm space-y-3"></div>
    </section>`,
      script: `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    // Who is posting, for the Remove affordance only — the server is what
    // actually enforces "your own post". Unverified decode of the page's
    // own token; nothing here decides access.
    let myId = null;
    try {
      const payloadB64 = (token.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
      myId = JSON.parse(decodeURIComponent(escape(atob(payloadB64)))).id || null;
    } catch (e) { myId = null; }

    function postCard(p) {
      const card = document.createElement('div');
      card.className = 'rounded-xl bg-zinc-800/60 overflow-hidden';
      const img = document.createElement('img');
      img.src = '/api/posts/' + p.id + '/image';
      img.alt = p.caption ? p.username + ': ' + p.caption : 'A picture ' + p.username + ' posted';
      img.className = 'block w-full max-h-72 object-cover';
      card.appendChild(img);
      const bar = document.createElement('div');
      bar.className = 'flex items-center gap-2 px-3 py-2';
      const who = document.createElement('span');
      who.className = 'flex-1 min-w-0 truncate text-xs text-zinc-400';
      who.textContent = p.username + (p.caption ? ' · ' + p.caption : '');
      bar.appendChild(who);
      if (myId != null && p.user_id === myId) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'shrink-0 text-xs font-semibold text-zinc-400 hover:text-red-400';
        rm.setAttribute('aria-label', 'Remove your post');
        rm.textContent = 'Remove';
        rm.addEventListener('click', async function () {
          try {
            const res = await fetch('/api/posts/' + p.id, { method: 'DELETE', headers: headers });
            if (res.ok) loadFeed();
          } catch (e) {}
        });
        bar.appendChild(rm);
      }
      card.appendChild(bar);
      return card;
    }

    async function loadFeed() {
      const res = await fetch('/api/posts', { headers });
      if (!res.ok) return;
      const data = await res.json();
      const feed = document.getElementById('post-feed');
      const posts = data.posts || [];
      feed.innerHTML = '';
      if (!posts.length) {
        feed.innerHTML = '<p class="text-center text-zinc-600 text-sm">No pictures yet — post the first one</p>';
        return;
      }
      for (const p of posts) feed.appendChild(postCard(p));
    }

    async function post() {
      const fileInput = document.getElementById('post-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const caption = (document.getElementById('post-caption').value || '').trim();
      const reader = new FileReader();
      reader.onload = async function () {
        try {
          const res = await fetch('/api/posts', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ caption: caption, image: reader.result })
          });
          if (res.ok) {
            fileInput.value = '';
            document.getElementById('post-caption').value = '';
            loadFeed();
          }
        } catch (e) {}
      };
      reader.readAsDataURL(file);
    }

    document.getElementById('post-submit').addEventListener('click', post);
    loadFeed();`,
    };
  },
};
