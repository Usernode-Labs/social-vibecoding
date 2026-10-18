'use strict';

/**
 * Starter: 2D game — a small canvas game with a leaderboard (request
 * #3521). Star catch: steer a basket with the arrow keys or a touch and
 * catch falling stars for 45 seconds; the round posts its score once, when
 * it ends, and the top-10 board shows the result. It runs entirely on the
 * app's own origin (a canvas, no libraries, no cross-origin assets), so
 * offline launch keeps working.
 *
 * A ranking on a board is all it is: no combat, no weapons, nothing to
 * bet, and the round ends by itself.
 */

const SCORES_DDL = `CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;

const SCORES_ROUTES = `// Star-catch scores: the round posts ONCE, when it ends. A score is an
// integer clamped server-side to 0..100000 — a client's claim, not a
// truth, but never a route anyone can bet on.
app.post('/api/scores', async (req, res) => {
  const raw = Number(req.body.score);
  if (!Number.isFinite(raw)) {
    return res.status(400).json({ error: 'A score is a number.' });
  }
  const score = Math.max(0, Math.min(100000, Math.round(raw)));
  try {
    const { rows } = await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3) RETURNING id, score',
      [req.user.id, req.user.username, score]
    );
    res.status(201).json({ score: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, score FROM scores ORDER BY score DESC, id ASC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

module.exports = {
  id: 'game-2d',
  title: '2D game',
  caption: 'A small canvas game with a leaderboard.',
  exampleNote: 'the star-catch example (the demo markup in `public/index.html`, the `/api/scores` routes, and the `scores` table bootstrap in `server.js`)',
  demoTable: 'scores',
  readmeExample: `- **Database** — the app has its own private Postgres database; the
  demo stores game scores in a \`scores\` table.
- **Live API** — the score routes (\`/api/scores\`) read and write
  through a real Express server.`,

  demoServer() {
    return { ddl: SCORES_DDL, routes: SCORES_ROUTES };
  },

  demoScreen() {
    return {
      markup: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <canvas id="star-canvas" width="320" height="220"
        class="block w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-950 touch-none cursor-pointer"></canvas>

      <div id="game-status" class="text-sm text-zinc-400">Tap the game to start — steer the basket and catch the falling stars</div>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h3>
        <div id="board" class="space-y-1"></div>
      </div>
    </section>`,
      script: `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const canvas = document.getElementById('star-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const ROUND_MS = 45000;

    let basketX = W / 2;
    let stars = [];
    let score = 0;
    let running = false;
    let endedAt = 0;
    let lastSpawn = 0;
    let lastFrame = 0;
    let pointerX = null;
    let keys = { left: false, right: false };

    function draw() {
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#a78bfa';
      for (const s of stars) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(basketX - 32, H - 14, 64, 8);
      if (running) {
        ctx.fillStyle = '#a1a1aa';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(Math.ceil((endedAt - Date.now()) / 1000) + 's', W - 8, 16);
      }
    }

    function loop(now) {
      if (running) {
        const dt = Math.min(50, now - lastFrame) / 1000;
        lastFrame = now;
        if (keys.left) basketX -= 160 * dt;
        if (keys.right) basketX += 160 * dt;
        if (pointerX != null) basketX = pointerX;
        basketX = Math.max(32, Math.min(W - 32, basketX));
        if (now - lastSpawn > 700) {
          stars.push({ x: 20 + Math.random() * (W - 40), y: -10, v: 90 + Math.random() * 90 });
          lastSpawn = now;
        }
        for (const s of stars) {
          s.y += s.v * dt;
          if (!s.gone && s.y >= H - 22 && s.y <= H - 4 && Math.abs(s.x - basketX) <= 36) {
            s.gone = true;
            score += 1;
          }
        }
        stars = stars.filter(function (s) { return !s.gone && s.y < H + 10; });
        document.getElementById('game-status').textContent = 'Score ' + score;
        if (Date.now() >= endedAt) endRound();
      }
      draw();
      requestAnimationFrame(loop);
    }

    // A round starts inside a tap or click (the canvas), never from a
    // timer: that is what keeps it working on a phone.
    function startRound() {
      if (running) return;
      stars = [];
      score = 0;
      running = true;
      endedAt = Date.now() + ROUND_MS;
      lastSpawn = 0;
      lastFrame = performance.now();
      document.getElementById('game-status').textContent = 'Score 0';
    }

    function endRound() {
      running = false;
      stars = [];
      document.getElementById('game-status').textContent =
        'Round over — you caught ' + score + (score === 1 ? ' star' : ' stars') + '. Tap the game to go again.';
      // The score is posted once, automatically, when the round ends.
      if (score > 0) {
        fetch('/api/scores', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ score: score })
        }).then(loadBoard).catch(function () {});
      }
    }

    canvas.addEventListener('click', startRound);
    canvas.addEventListener('touchstart', function (e) {
      startRound();
      if (e.touches[0]) pointerX = ((e.touches[0].clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width) * W;
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches[0]) pointerX = ((e.touches[0].clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width) * W;
    }, { passive: true });
    canvas.addEventListener('touchend', function () { pointerX = null; });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') keys.left = true;
      if (e.key === 'ArrowRight') keys.right = true;
    });
    window.addEventListener('keyup', function (e) {
      if (e.key === 'ArrowLeft') keys.left = false;
      if (e.key === 'ArrowRight') keys.right = false;
    });

    async function loadBoard() {
      const res = await fetch('/api/scores', { headers });
      if (!res.ok) return;
      const data = await res.json();
      const el = document.getElementById('board');
      const scores = data.scores || [];
      if (!scores.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
        return;
      }
      el.innerHTML = scores.map(function (r, i) {
        return '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
          '<span>' + (i + 1) + '. ' + r.username + '</span>' +
          '<span class="font-mono">' + r.score + '</span></div>';
      }).join('');
    }

    loadBoard();
    requestAnimationFrame(loop);`,
    };
  },
};
