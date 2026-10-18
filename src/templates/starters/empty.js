'use strict';

// The starter every new app shipped before templates existed, moved here
// verbatim: the Press! example, its two routes and the `presses` table. It
// is the `empty` starting point ("Start from scratch") and the fallback for
// any unknown key (services/app-templates.js).
//
// Every piece below is inserted into the shared shell in
// src/services/template.js. The output must stay byte-for-byte what that
// file emitted before templates (tests/app-templates.test.js pins the ids,
// tests/template-*.test.js the rest).

module.exports = {
  key: 'empty',
  title: 'Start from scratch',
  caption: 'An empty app. Describe what you want and build it with the group.',

  // The hero's welcome line, under the app's name.
  welcome: `      <p class="text-sm text-zinc-300 leading-relaxed">Welcome to your new app! Everything on this screen is placeholder content that came with it.</p>`,

  // The inner markup of the "Try the example" card, after its heading row.
  exampleCard: `
      <button id="press-btn" class="w-32 h-32 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-xl font-bold shadow-lg shadow-violet-600/30">
        Press!
      </button>

      <div id="count" class="text-lg text-zinc-400">0 total presses</div>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h3>
        <div id="leaderboard" class="space-y-1"></div>
      </div>
`,

  // The page's own script, between <script> and </script>.
  script: `
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    async function loadLeaderboard() {
      const res = await fetch('/api/leaderboard', { headers });
      if (!res.ok) return;
      const { leaderboard } = await res.json();
      const el = document.getElementById('leaderboard');
      if (!leaderboard.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No presses yet</p>';
        return;
      }
      el.innerHTML = leaderboard.map((r, i) =>
        '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
        '<span>' + (i + 1) + '. ' + r.username + '</span>' +
        '<span class="font-mono">' + r.presses + '</span></div>'
      ).join('');
      const total = leaderboard.reduce((s, r) => s + parseInt(r.presses), 0);
      document.getElementById('count').textContent = total + ' total presses';
    }

    document.getElementById('press-btn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/press', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        });
        if (res.ok) loadLeaderboard();
        else if (res.status === 401) document.getElementById('count').textContent = 'Sign in to press!';
      } catch {}
    });

    loadLeaderboard();
  `,

  // The demo's routes, inserted into server.js after /favicon.ico.
  routes: `// Button press
app.post('/api/press', async (req, res) => {
  try {
    await pool.query(\`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    \`, [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, COUNT(*) as presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    \`);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`,

  // The demo's tables, created in start() before the server listens.
  bootstrapSql: `    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

  // README.md's demo description.
  readmeDatabase: 'the\n  demo stores button presses in a `presses` table.',
  readmeApi: 'two example routes (`/api/press`,\n  `/api/leaderboard`) read and write through a real Express server.',

  // CLAUDE.md's starter section.
  claudeDemo: 'the Press! example (the demo markup in\n`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and\nthe `presses` table bootstrap in `server.js`)',
  claudeRemove: '- remove or repurpose the "Try the example" card, its demo endpoints and\n  the `presses` table as appropriate,',
};
