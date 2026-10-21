'use strict';

/**
 * The Multimedia social starter: a photo board. People share a photo with a
 * caption through the platform bridge, see everyone's photos newest first,
 * and can report a photo that should not be there. A photo the platform has
 * taken down renders as "This image is no longer available." rather than a
 * broken image.
 */

const { escapeHtml, starterDocument, starterServer } = require('./scaffold');

const TITLE = 'Multimedia social';

function document(appName) {
  const body = `    <header>
      <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
      <p class="text-sm text-zinc-400">Photos</p>
    </header>

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 class="text-sm font-semibold text-zinc-100">Share a photo</h2>
      <input id="photo" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
             aria-label="Photo"
             class="mt-3 block w-full text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-zinc-100">
      <input id="caption" type="text" maxlength="200" autocomplete="off"
             placeholder="Caption"
             aria-label="Caption"
             class="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none">
      <button id="post" type="button"
              class="mt-2 w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60">Post</button>
      <p id="error" class="mt-2 hidden text-sm text-red-400" role="alert"></p>
    </section>

    <section>
      <h2 class="mb-2 px-1 text-sm font-medium text-zinc-500">Everyone's photos</h2>
      <p id="empty" class="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">No photos yet</p>
      <ul id="posts" class="space-y-4"></ul>
    </section>`;

  const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const fileInput = document.getElementById('photo');
    const captionInput = document.getElementById('caption');
    const postBtn = document.getElementById('post');
    const errorLine = document.getElementById('error');
    const empty = document.getElementById('empty');
    const list = document.getElementById('posts');

    function say(text) {
      errorLine.textContent = text || '';
      errorLine.classList.toggle('hidden', !text);
    }

    function photoCard(post) {
      const card = document.createElement('li');
      card.className = 'overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60';
      card.dataset.postId = String(post.id);

      const image = document.createElement('img');
      image.src = post.image_url;
      image.alt = post.caption || 'Shared photo';
      image.loading = 'lazy';
      image.className = 'block max-h-96 w-full bg-zinc-950 object-contain';
      // A platform-hidden photo stops serving, so the app says so plainly
      // instead of showing a broken image.
      image.addEventListener('error', function () {
        const gone = document.createElement('p');
        gone.className = 'px-4 py-10 text-center text-sm text-zinc-500';
        gone.textContent = 'This image is no longer available.';
        image.replaceWith(gone);
      });
      card.append(image);

      const foot = document.createElement('div');
      foot.className = 'flex items-start gap-3 px-4 py-3';

      const words = document.createElement('div');
      words.className = 'min-w-0 flex-1';
      if (post.caption) {
        const caption = document.createElement('p');
        caption.className = 'text-sm text-zinc-100';
        caption.textContent = post.caption;
        words.append(caption);
      }
      const by = document.createElement('p');
      by.className = 'text-xs text-zinc-500';
      by.textContent = '@' + post.username;
      words.append(by);

      const report = document.createElement('button');
      report.type = 'button';
      report.className = post.reported
        ? 'shrink-0 text-xs font-medium text-zinc-500'
        : 'shrink-0 text-xs font-medium text-zinc-400 hover:text-zinc-100';
      report.textContent = post.reported ? 'Reported' : 'Report';
      report.disabled = !!post.reported;
      report.setAttribute('aria-label',
        post.reported ? 'Photo reported' : 'Report this photo');
      report.addEventListener('click', function () { reportPost(post.id, report); });

      foot.append(words, report);
      card.append(foot);
      return card;
    }

    async function load() {
      try {
        const res = await fetch('/api/posts', { headers });
        if (!res.ok) throw new Error('Could not load the photos.');
        const data = await res.json();
        const posts = data.posts || [];
        list.replaceChildren();
        for (const post of posts) list.append(photoCard(post));
        empty.classList.toggle('hidden', posts.length > 0);
        say('');
      } catch (err) {
        say(err.message || 'Could not load the photos.');
      }
    }

    async function post() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return say('Choose a photo first.');
      if (!window.usernode || typeof window.usernode.uploadFile !== 'function') {
        return say('Sharing photos needs the Homeroom app. Open this project inside Homeroom.');
      }
      postBtn.disabled = true;
      postBtn.textContent = 'Posting\\u2026';
      try {
        const stored = await window.usernode.uploadFile(file, { visibility: 'public' });
        const res = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            caption: captionInput.value,
            imageUrl: stored.url,
            imageId: stored.id,
          }),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Could not share the photo.');
        fileInput.value = '';
        captionInput.value = '';
        say('');
        await load();
      } catch (err) {
        say(err.message || 'Could not share the photo.');
      } finally {
        postBtn.disabled = false;
        postBtn.textContent = 'Post';
      }
    }

    async function reportPost(id, button) {
      try {
        const res = await fetch('/api/posts/' + encodeURIComponent(id) + '/report', {
          method: 'POST',
          headers,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Could not report the photo.');
        button.textContent = 'Reported';
        button.disabled = true;
        button.className = 'shrink-0 text-xs font-medium text-zinc-500';
        say('');
      } catch (err) {
        say(err.message || 'Could not report the photo.');
      }
    }

    postBtn.addEventListener('click', post);
    load();`;

  return starterDocument({ appName, starter: TITLE, body, script });
}

function server(slug) {
  const api = `// Photos live in platform storage; this app stores only the returned URL.
const IMAGE_ID_RE = /^[a-f0-9]{32}$/;
function isAppFileUrl(value, id) {
  if (!IMAGE_ID_RE.test(id)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.pathname === '/app-files/' + id
      && (!PLATFORM_ORIGIN || url.origin === PLATFORM_ORIGIN);
  } catch {
    return false;
  }
}

app.get('/api/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT p.id, p.username, p.caption, p.image_url, p.created_at, ' +
      'EXISTS (SELECT 1 FROM post_reports r WHERE r.post_id = p.id AND r.user_id = $1) AS reported ' +
      'FROM posts p ORDER BY p.id DESC LIMIT 100',
      [req.user.id]
    );
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const caption = typeof req.body.caption === 'string'
    ? req.body.caption.replace(/\\s+/g, ' ').trim() : '';
  if (caption.length > 200) return res.status(400).json({ error: 'Keep the caption to 200 characters.' });
  const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '';
  const imageId = typeof req.body.imageId === 'string' ? req.body.imageId : '';
  if (!isAppFileUrl(imageUrl, imageId)) {
    return res.status(400).json({ error: 'The photo must be uploaded through Homeroom.' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO posts (user_id, username, caption, image_url, image_id) ' +
      'VALUES ($1, $2, $3, $4, $5) RETURNING id, username, caption, image_url, created_at',
      [req.user.id, req.user.username, caption, imageUrl, imageId]
    );
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A second report from the same person is a no-op; the screen reads Reported.
app.post('/api/posts/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown photo.' });
  try {
    const found = await pool.query('SELECT 1 FROM posts WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ error: 'That photo is no longer here.' });
    await pool.query(
      'INSERT INTO post_reports (post_id, user_id, username) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (post_id, user_id) DO NOTHING',
      [id, req.user.id, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;
  const schema = `    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption VARCHAR(200) NOT NULL DEFAULT '',
      image_url TEXT NOT NULL,
      image_id VARCHAR(32) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS post_reports (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );`;
  return starterServer({ api, schema, slug });
}

module.exports = { key: 'media', title: TITLE, document, server };
