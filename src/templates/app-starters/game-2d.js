'use strict';

// 2D game starter: a quick game of collecting stars, with a group high
// score. Non-violent by design: there are stars to collect and nothing to
// fight, and the score is a plain number. The canvas is the browser's own,
// so the starter adds no dependency.

const base = require('./base');

const ROUTES = `// The group board, best first.
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, MAX(score)::int AS score FROM scores GROUP BY username ORDER BY score DESC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  try {
    const score = Number(req.body.score);
    if (!Number.isInteger(score) || score < 0 || score > 999) {
      return res.status(400).json({ error: 'A score is a whole number from 0 to 999.' });
    }
    await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
      [req.user.id, req.user.username, score]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

const EXAMPLE = `      <canvas id="game-canvas" width="320" height="320" class="mx-auto rounded-lg bg-zinc-950 border border-zinc-800" aria-label="Star game"></canvas>
      <div class="flex items-center justify-between gap-2">
        <span id="game-status" class="text-sm text-zinc-400">Collect the stars</span>
        <button id="game-start" class="rounded-full bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Start game</button>
      </div>
      <div>
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Group scores</h3>
        <div id="game-scores" class="space-y-1"></div>
      </div>`;

const SCRIPT = `    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('game-status');
    const startButton = document.getElementById('game-start');
    const scoresEl = document.getElementById('game-scores');
    const SIZE = 320;
    const ROUND_MS = 30000;
    const state = { running: false, score: 0, endsAt: 0, player: { x: 160, y: 160 }, star: { x: 240, y: 80 }, target: null };
    const keys = {};

    function placeStar() {
      state.star.x = 30 + Math.random() * (SIZE - 60);
      state.star.y = 30 + Math.random() * (SIZE - 60);
    }

    function star(cx, cy) {
      ctx.beginPath();
      for (var i = 0; i < 10; i++) {
        var radius = i % 2 === 0 ? 11 : 5;
        var angle = (Math.PI / 5) * i - Math.PI / 2;
        var x = cx + Math.cos(angle) * radius;
        var y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
    }

    function draw() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      star(state.star.x, state.star.y);
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(state.player.x - 10, state.player.y - 10, 20, 20);
    }

    function tick(now) {
      if (!state.running) return;
      var speed = 3.2;
      if (keys.ArrowLeft || keys.a || keys.A) state.player.x -= speed;
      if (keys.ArrowRight || keys.d || keys.D) state.player.x += speed;
      if (keys.ArrowUp || keys.w || keys.W) state.player.y -= speed;
      if (keys.ArrowDown || keys.s || keys.S) state.player.y += speed;
      if (state.target) {
        var dx = state.target.x - state.player.x;
        var dy = state.target.y - state.player.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 2) {
          state.player.x += (dx / dist) * speed;
          state.player.y += (dy / dist) * speed;
        } else {
          state.target = null;
        }
      }
      state.player.x = Math.max(12, Math.min(SIZE - 12, state.player.x));
      state.player.y = Math.max(12, Math.min(SIZE - 12, state.player.y));
      var sx = state.player.x - state.star.x;
      var sy = state.player.y - state.star.y;
      if (Math.sqrt(sx * sx + sy * sy) < 22) {
        state.score += 1;
        placeStar();
      }
      var left = Math.max(0, Math.ceil((state.endsAt - now) / 1000));
      statusEl.textContent = 'Score ' + state.score + ' \\u00b7 ' + left + 's left';
      draw();
      if (now >= state.endsAt) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    }

    async function finish() {
      state.running = false;
      startButton.disabled = false;
      statusEl.textContent = 'Time! You collected ' + state.score + '.';
      try {
        await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ score: state.score }),
        });
      } catch (e) {}
      loadScores();
    }

    function start() {
      state.running = true;
      state.score = 0;
      state.player = { x: 160, y: 160 };
      state.target = null;
      placeStar();
      state.endsAt = performance.now() + ROUND_MS;
      startButton.disabled = true;
      requestAnimationFrame(tick);
    }

    async function loadScores() {
      try {
        const res = await fetch('/api/scores', { headers: headers });
        if (!res.ok) return;
        const data = await res.json();
        const rows = data.scores || [];
        if (!rows.length) {
          scoresEl.innerHTML = '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
          return;
        }
        scoresEl.innerHTML = rows.map(function (r, i) {
          return '<div class="flex justify-between px-3 py-1 rounded text-sm ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
            '<span>' + (i + 1) + '. ' + esc(r.username) + '</span><span class="font-mono">' + r.score + '</span></div>';
        }).join('');
      } catch (e) {}
    }

    document.addEventListener('keydown', function (e) {
      keys[e.key] = true;
      if (e.key.indexOf('Arrow') === 0 && state.running) e.preventDefault();
    });
    document.addEventListener('keyup', function (e) { keys[e.key] = false; });
    canvas.addEventListener('click', function (e) {
      if (!state.running) return;
      var rect = canvas.getBoundingClientRect();
      state.target = {
        x: (e.clientX - rect.left) * (SIZE / rect.width),
        y: (e.clientY - rect.top) * (SIZE / rect.height),
      };
    });
    startButton.addEventListener('click', start);

    draw();
    loadScores();`;

module.exports = {
  key: 'game-2d',
  name: '2D game',
  caption: 'Collect the stars, and put your score on the group board.',
  index({ appName }) {
    return base.page({
      appName,
      intro: 'Collect the stars, and put your score on the group board. Arrow keys, WASD, or tap where you want to go.',
      working: [
        { title: 'Sign-in through Homeroom', text: 'Every score is saved under the player Homeroom knows.' },
        { title: 'Your own database, storing the scores', text: 'The group board is read from it.' },
        { title: 'A live API behind the board', text: 'Finishing a round posts your score to the server.' },
      ],
      example: EXAMPLE,
      script: SCRIPT,
    });
  },
  server({ slug }) {
    return base.server({
      slug,
      bootstrap: `    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
      routes: ROUTES,
    });
  },
  claudeStarter: `## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the star game (the demo markup in
\`public/index.html\`, the \`/api/scores\` routes, and the \`scores\` table
bootstrap in \`server.js\`) — is a starter from Homeroom's 2D game
template, not product intent.

When the user asks for their first real feature, REPLACE the starter
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the \`scores\` table as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.

The starter takes the browser's score as sent. If scores start to matter,
verify the round on the server instead. Keep the game non-violent: Homeroom
allows no weapons, combat, gambling or mature themes.`,
  readmeDemo: `- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores the group's scores in a \`scores\` table.
- **Live API** — two example routes (\`GET /api/scores\`, \`POST /api/scores\`)
  read and write through a real Express server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};
