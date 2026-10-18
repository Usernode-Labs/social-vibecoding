'use strict';

// Multimedia social starting point: a wall of posts about films, music and
// books. A post has a title, a kind, an optional note and one of five
// built-in covers (never an upload or an outside image). People can react,
// every post has a Report link, and posts marked hidden do not appear.
//
// User text is always rendered with textContent, never innerHTML. The report
// route records a row; hiding is the platform's moderation hook, not
// something this demo does on its own.

module.exports = {
  key: 'multimedia',
  title: 'Multimedia social',
  caption: 'A wall of posts about films, music and books, with reactions.',

  welcome: `      <p class="text-sm text-zinc-300 leading-relaxed">This starter is a wall of posts about films, music and books. Share what you are into, react to a post, and report anything that does not belong.</p>`,

  exampleCard: `
      <div class="w-full flex flex-col gap-3">
        <div class="rounded-xl border border-zinc-800 bg-zinc-950 p-3 flex flex-col gap-2">
          <input id="post-title" maxlength="200" placeholder="Title" class="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none">
          <div class="flex gap-2">
            <select id="post-kind" aria-label="Kind" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none">
              <option value="film">Film</option>
              <option value="music">Music</option>
              <option value="book">Book</option>
            </select>
            <select id="post-cover" aria-label="Cover" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none">
              <option value="amber">Amber cover</option>
              <option value="rose">Rose cover</option>
              <option value="sky">Sky cover</option>
              <option value="emerald">Emerald cover</option>
              <option value="violet">Violet cover</option>
            </select>
          </div>
          <input id="post-note" maxlength="500" placeholder="A note (optional)" class="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none">
          <button id="post-add" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Post</button>
        </div>
        <p id="post-status" class="hidden text-xs text-zinc-500" role="status"></p>
        <div id="post-wall" class="w-full flex flex-col gap-3"></div>
      </div>
`,

  script: `
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};
    const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

    const COVER_CLASSES = {
      amber: 'bg-gradient-to-br from-amber-500 to-orange-700',
      rose: 'bg-gradient-to-br from-rose-500 to-pink-700',
      sky: 'bg-gradient-to-br from-sky-500 to-blue-700',
      emerald: 'bg-gradient-to-br from-emerald-500 to-teal-700',
      violet: 'bg-gradient-to-br from-violet-500 to-violet-700',
    };

    const KIND_WORDS = { film: 'Film', music: 'Music', book: 'Book' };

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    async function react(post) {
      await fetch('/api/posts/' + post.id + '/react', { method: 'POST', headers: jsonHeaders });
      loadPosts();
    }

    async function report(post) {
      const status = document.getElementById('post-status');
      await fetch('/api/posts/' + post.id + '/report', { method: 'POST', headers: jsonHeaders });
      status.textContent = 'Thanks. The post was reported.';
      status.classList.remove('hidden');
    }

    async function loadPosts() {
      const wall = document.getElementById('post-wall');
      try {
        const res = await fetch('/api/posts', { headers });
        if (!res.ok) throw new Error('Could not load the wall');
        const { posts } = await res.json();
        wall.textContent = '';
        if (!posts.length) {
          wall.appendChild(el('p', 'rounded-lg border border-zinc-800 px-3 py-4 text-center text-sm text-zinc-500',
            'Nothing here yet. Share the first thing you are into.'));
          return;
        }
        for (const post of posts) {
          const card = el('div', 'overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950');
          card.appendChild(el('div', 'h-20 ' + (COVER_CLASSES[post.cover] || COVER_CLASSES.amber)));
          const body = el('div', 'flex flex-col gap-1 p-3');
          const head = el('div', 'flex items-baseline justify-between gap-2');
          head.appendChild(el('div', 'min-w-0 truncate text-sm font-semibold text-zinc-100', post.title));
          head.appendChild(el('span', 'shrink-0 text-xs text-zinc-500', KIND_WORDS[post.kind] || 'Post'));
          body.appendChild(head);
          if (post.note) body.appendChild(el('p', 'text-sm text-zinc-400', post.note));
          body.appendChild(el('p', 'text-xs text-zinc-500', 'Posted by ' + post.username));
          const actions = el('div', 'flex items-center gap-3 pt-1');
          const like = el('button',
            'rounded-full border border-zinc-600 px-3 py-1 text-xs font-semibold text-zinc-100 hover:border-violet-500',
            (post.reacted ? 'Reacted' : 'React') + ' · ' + post.reactions);
          like.type = 'button';
          like.addEventListener('click', () => react(post));
          actions.appendChild(like);
          const flag = el('button', 'text-xs text-zinc-500 underline hover:text-zinc-300', 'Report');
          flag.type = 'button';
          flag.addEventListener('click', () => report(post));
          actions.appendChild(flag);
          body.appendChild(actions);
          card.appendChild(body);
          wall.appendChild(card);
        }
      } catch {
        wall.textContent = '';
        wall.appendChild(el('p', 'rounded-lg border border-red-900 px-3 py-4 text-center text-sm text-red-300',
          'The wall could not load. Try again in a moment.'));
      }
    }

    async function addPost() {
      const status = document.getElementById('post-status');
      const title = document.getElementById('post-title').value.trim();
      const body = {
        title,
        kind: document.getElementById('post-kind').value,
        cover: document.getElementById('post-cover').value,
        note: document.getElementById('post-note').value.trim(),
      };
      if (!title) {
        status.textContent = 'Give the post a title first.';
        status.classList.remove('hidden');
        return;
      }
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error || 'Could not post that. Try again.';
        status.classList.remove('hidden');
        return;
      }
      status.classList.add('hidden');
      document.getElementById('post-title').value = '';
      document.getElementById('post-note').value = '';
      loadPosts();
    }

    document.getElementById('post-add').addEventListener('click', addPost);

    loadPosts();
  `,

  routes: `// The wall: every post that is not hidden, with its reactions
app.get('/api/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT p.id, p.title, p.kind, p.note, p.cover, p.username, p.created_at,
             COUNT(r.id)::int AS reactions,
             COALESCE(BOOL_OR(r.user_id = $1), FALSE) AS reacted
      FROM media_posts p
      LEFT JOIN media_reactions r ON r.post_id = p.id
      WHERE p.hidden = FALSE
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 100
    \`, [req.user.id]);
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share a post. Kind and cover are the fixed sets the screen offers; no
// uploads and no outside links are accepted.
app.post('/api/posts', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const kinds = ['film', 'music', 'book'];
  const covers = ['amber', 'rose', 'sky', 'emerald', 'violet'];
  if (!title || title.length > 200) {
    return res.status(400).json({ error: 'Give the post a title of 200 characters or fewer.' });
  }
  if (!kinds.includes(req.body.kind)) {
    return res.status(400).json({ error: 'Kind must be film, music or book.' });
  }
  if (!covers.includes(req.body.cover)) {
    return res.status(400).json({ error: 'Cover must be one of the five built-in covers.' });
  }
  if (note.length > 500) {
    return res.status(400).json({ error: 'Keep the note to 500 characters or fewer.' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO media_posts (title, kind, note, cover, user_id, username)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    \`, [title, req.body.kind, note || null, req.body.cover, req.user.id, req.user.username]);
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// React to a post, once per person
app.post('/api/posts/:id/react', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown post.' });
  try {
    await pool.query(\`
      INSERT INTO media_reactions (post_id, user_id, username)
      SELECT id, $1, $2 FROM media_posts WHERE id = $3
      ON CONFLICT (post_id, user_id) DO NOTHING
    \`, [req.user.id, req.user.username, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report a post. This records the report; hiding is a moderation decision.
app.post('/api/posts/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown post.' });
  try {
    await pool.query(\`
      INSERT INTO media_reports (post_id, user_id)
      SELECT id, $1 FROM media_posts WHERE id = $2
      ON CONFLICT (post_id, user_id) DO NOTHING
    \`, [req.user.id, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`,

  bootstrapSql: `    CREATE TABLE IF NOT EXISTS media_posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      note VARCHAR(500),
      cover VARCHAR(20) NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS media_reactions (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES media_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS media_reports (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES media_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );
    INSERT INTO media_posts (title, kind, note, cover, user_id, username)
    SELECT 'Friday film night', 'film', 'A classic everyone can watch together.', 'amber', 0, 'Starter'
    WHERE NOT EXISTS (SELECT 1 FROM media_posts)`,

  readmeDatabase: 'the\n  demo keeps posts in a `media_posts` table, with `media_reactions` and\n  `media_reports` beside it.',
  readmeApi: 'the example routes (`/api/posts`,\n  `/api/posts/:id/react`, `/api/posts/:id/report`) run a media wall through a\n  real Express server.',
  claudeDemo: 'the media wall (the demo markup in\n`public/index.html`, the `/api/posts` routes and the `media_posts`,\n`media_reactions` and `media_reports` table bootstrap in `server.js`)',
  claudeRemove: '- remove or repurpose the "Try the example" card, its demo endpoints and\n  the `media_posts`, `media_reactions` and `media_reports` tables as\n  appropriate,',
};
