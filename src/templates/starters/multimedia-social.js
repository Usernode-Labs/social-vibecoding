'use strict';

// The "Multimedia social app" starter: a photo wall. Posts are image links a
// person pastes, with an optional caption. Every post can be liked and
// reported; a hidden post never reaches the feed. See index.js for the shape
// every starter module shares.

const id = 'multimedia-social';
const label = 'Multimedia social app';
const caption = 'A photo wall people post to, like and report.';

const docs = {
  claude: `The screen this app currently ships is a **Photo wall** example (the demo
markup in \`public/index.html\`, the \`/api/posts\` routes, and the \`posts\`,
\`post_likes\` and \`post_reports\` table bootstrap in \`server.js\`) —
placeholder content from the Homeroom starter template, not product intent.

Posts are user content. Keep the **Report** action on every post, and keep
\`GET /api/posts\` filtering \`hidden = FALSE\`: a moderator hides a post with
\`UPDATE posts SET hidden = TRUE WHERE id = $1\`, and the wall must never show
it again. Reporting records a report; it does not hide the post by itself.`,
  readme: `The scaffold is a small working demo that proves the plumbing works:

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores posts, likes and reports in \`posts\`, \`post_likes\` and
  \`post_reports\`.
- **Live API** — four example routes (\`GET /api/posts\`,
  \`POST /api/posts\`, \`POST /api/posts/:id/like\`,
  \`POST /api/posts/:id/report\`) read and write through a real Express
  server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};

const routes = `// Photo wall — a hidden post never leaves the server
app.get('/api/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT p.id, p.image_url, p.caption, p.username, p.created_at,
             COUNT(l.user_id)::int AS likes,
             COALESCE(BOOL_OR(l.user_id = $1), FALSE) AS liked
      FROM posts p
      LEFT JOIN post_likes l ON l.post_id = p.id
      WHERE p.hidden = FALSE
      GROUP BY p.id
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 50
    \`, [req.user.id]);
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl.trim() : '';
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : '';
  if (!/^https?:\\/\\//i.test(imageUrl) || imageUrl.length > 2000) {
    return res.status(400).json({ error: 'Paste an image link that starts with http:// or https://' });
  }
  if (caption.length > 280) {
    return res.status(400).json({ error: 'Keep the caption to 280 characters or fewer' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO posts (image_url, caption, user_id, username)
      VALUES ($1, $2, $3, $4)
      RETURNING id, image_url, caption, username, created_at
    \`, [imageUrl, caption || null, req.user.id, req.user.username]);
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One like per person: pressing again takes it back.
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM posts WHERE id = $1 AND hidden = FALSE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const removed = await pool.query(
      'DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!removed.rowCount) {
      await pool.query(
        'INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.params.id, req.user.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A report records why someone flagged the post. It does not hide it: a
// moderator reviews reports and sets posts.hidden.
app.post('/api/posts/:id/report', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM posts WHERE id = $1 AND hidden = FALSE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;
    await pool.query(\`
      INSERT INTO post_reports (post_id, user_id, reason) VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    \`, [req.params.id, req.user.id, reason || null]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;

const bootstrap = `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      caption VARCHAR(280),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id)
    )
  \`);
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS post_reports (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      reason VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  \`);
`;

function body() {
  return `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>
      <h3 class="text-base font-semibold mt-4">Photo wall</h3>
      <p class="text-[13px] text-zinc-400 m-0">Post a photo by pasting an image link.</p>
      <form id="post-form" class="mt-3 flex flex-col gap-2">
        <input id="post-image" type="url" maxlength="2000" placeholder="Image URL"
               class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500">
        <input id="post-caption" maxlength="280" placeholder="Caption (optional)"
               class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500">
        <button type="submit" class="self-start bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-4 py-2 text-sm font-semibold">Post</button>
      </form>
      <p id="post-empty" class="text-[13px] text-zinc-500 mt-3.5">Nothing here yet. Post the first photo.</p>
      <div id="post-list" class="mt-4 space-y-3"></div>
    </section>`;
}

const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const listEl = document.getElementById('post-list');
    const emptyEl = document.getElementById('post-empty');

    function render(payload) {
      const posts = payload.posts || [];
      emptyEl.style.display = posts.length ? 'none' : '';
      listEl.textContent = '';
      posts.forEach(function (post) {
        const card = document.createElement('article');
        card.className = 'rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden';

        const image = document.createElement('img');
        image.src = post.image_url;
        image.alt = post.caption || 'Photo';
        image.loading = 'lazy';
        image.className = 'block w-full h-40 object-cover bg-zinc-900';
        image.addEventListener('error', function () { image.style.display = 'none'; });

        const text = document.createElement('div');
        text.className = 'p-3';
        if (post.caption) {
          const caption = document.createElement('p');
          caption.textContent = post.caption;
          caption.className = 'text-sm text-zinc-100 m-0';
          text.appendChild(caption);
        }
        const who = document.createElement('p');
        who.textContent = post.username;
        who.className = 'text-xs text-zinc-500 mt-1 mb-2';
        text.appendChild(who);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-2';
        const like = document.createElement('button');
        like.type = 'button';
        like.textContent = (post.liked ? 'Liked' : 'Like') + ' · ' + post.likes;
        like.className = 'text-xs font-semibold rounded-full px-3 py-1 ' +
          (post.liked ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700');
        like.addEventListener('click', function () { act('/api/posts/' + post.id + '/like', {}); });
        const report = document.createElement('button');
        report.type = 'button';
        report.textContent = 'Report';
        report.className = 'text-xs font-medium rounded-full px-3 py-1 bg-zinc-800 text-zinc-400 hover:bg-zinc-700';
        report.addEventListener('click', async function () {
          const done = await act('/api/posts/' + post.id + '/report', {});
          if (done) {
            report.textContent = 'Reported';
            report.disabled = true;
          }
        });
        actions.append(like, report);
        text.appendChild(actions);

        card.append(image, text);
        listEl.appendChild(card);
      });
    }

    async function act(url, body) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify(body),
        });
        if (!res.ok) return false;
        load();
        return true;
      } catch (err) {
        return false;
      }
    }

    async function load() {
      try {
        const res = await fetch('/api/posts', { headers: headers });
        if (!res.ok) return;
        render(await res.json());
      } catch (err) {}
    }

    document.getElementById('post-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      const image = document.getElementById('post-image');
      const caption = document.getElementById('post-caption');
      try {
        const res = await fetch('/api/posts', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ imageUrl: image.value, caption: caption.value }),
        });
        if (res.ok) {
          image.value = '';
          caption.value = '';
          load();
        }
      } catch (err) {}
    });

    load();`;

module.exports = { id, label, caption, docs, routes, bootstrap, body, script };
