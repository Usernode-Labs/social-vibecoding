'use strict';

// The "2D game" starter: Star catcher. A canvas 2D scene, no libraries and no
// downloaded assets. See index.js for the shape every starter module shares.

const id = 'game-2d';
const label = '2D game';
const caption = 'A catch-the-stars game with a high-score board.';

// Both games keep their scores in the same table and use the same routes.
const scoreRoutes = `// High scores — the top ten, best first; each player keeps their best
app.get('/api/scores', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, best_score, updated_at
      FROM game_scores
      ORDER BY best_score DESC, updated_at ASC
      LIMIT 10
    \`);
    res.json({ scores: rows, you: req.user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  const score = req.body.score;
  if (!Number.isInteger(score) || score < 0 || score > 500) {
    return res.status(400).json({ error: 'score must be a whole number from 0 to 500' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO game_scores (user_id, username, best_score)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
        SET best_score = GREATEST(game_scores.best_score, EXCLUDED.best_score),
            username = EXCLUDED.username,
            updated_at = NOW()
      RETURNING best_score
    \`, [req.user.id, req.user.username, score]);
    res.json({ best: rows[0].best_score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;

const scoreBootstrap = `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS game_scores (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      best_score INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);
`;

// The page-side pieces both games share: the token, the leaderboard and
// posting a score.
const scorePageHelpers = `    async function loadScores() {
      try {
        const res = await fetch('/api/scores', { headers: headers });
        if (!res.ok) return;
        const payload = await res.json();
        const scores = payload.scores || [];
        const mine = scores.find(function (row) { return row.username === payload.you; });
        if (mine) best = Math.max(best, mine.best_score);
        scoresEl.textContent = '';
        if (!scores.length) {
          const empty = document.createElement('p');
          empty.textContent = 'No scores yet. Be the first.';
          empty.className = 'text-center text-[13px] text-zinc-500 m-0';
          scoresEl.appendChild(empty);
          return;
        }
        scores.forEach(function (row, index) {
          const line = document.createElement('div');
          line.className = 'flex justify-between px-3 py-1 rounded ' +
            (index === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400');
          const name = document.createElement('span');
          name.textContent = (index + 1) + '. ' + row.username;
          const value = document.createElement('span');
          value.textContent = row.best_score;
          value.className = 'font-mono';
          line.append(name, value);
          scoresEl.appendChild(line);
        });
      } catch (err) {}
    }

    async function postScore(value) {
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ score: value }),
        });
        if (res.ok) {
          const payload = await res.json();
          best = payload.best;
        }
        loadScores();
      } catch (err) {}
    }`;

const docs = {
  claude: `The screen this app currently ships is a **Star catcher** example (the demo
markup in \`public/index.html\`, the \`/api/scores\` routes, and the
\`game_scores\` table bootstrap in \`server.js\`) — placeholder content from
the Homeroom starter template, not product intent. The game runs in the
browser's canvas with no libraries and no downloaded assets; a round lasts
60 seconds.`,
  readme: `The scaffold is a small working demo that proves the plumbing works:

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo keeps each player's best score in a \`game_scores\` table.
- **Live API** — two example routes (\`GET /api/scores\`,
  \`POST /api/scores\`) read and write through a real Express server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};

function body() {
  return `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>
      <h3 class="text-base font-semibold mt-4">Star catcher</h3>
      <p id="game-status" class="text-[13px] text-zinc-400 m-0 mt-0.5 mb-3">Score 0 · Best 0</p>
      <div class="relative h-52 rounded-xl bg-zinc-900 border border-zinc-700 overflow-hidden">
        <canvas id="game-canvas" class="block w-full h-full touch-none"></canvas>
      </div>
      <button id="game-start" type="button" class="mt-3.5 bg-violet-600 hover:bg-violet-500 text-white rounded-full px-6 py-2 text-sm font-semibold">Start</button>
      <p class="text-[13px] text-zinc-500 mt-4 mb-1.5 text-center">Leaderboard</p>
      <div id="game-scores" class="space-y-1"></div>
    </section>`;
}

const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('game-status');
    const startBtn = document.getElementById('game-start');
    const scoresEl = document.getElementById('game-scores');

    const ROUND_MS = 60000;
    let best = 0;
    let running = false;
    let score = 0;
    let basket = 0.5;
    let stars = [];
    let nextStar = 0;
    let endsAt = 0;
    let lastFrame = 0;

    function fit() {
      const ratio = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 208;
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { w: w, h: h };
    }

    function draw(now) {
      const size = fit();
      const w = size.w;
      const h = size.h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#c4b5fd';
      stars.forEach(function (star) {
        ctx.beginPath();
        ctx.arc(star.x * w, star.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      const bw = 72;
      const bx = Math.min(Math.max(basket * w - bw / 2, 0), Math.max(0, w - bw));
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(bx, h - 22, bw, 12);
      if (running) {
        ctx.fillStyle = '#a1a1aa';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(Math.ceil(Math.max(0, endsAt - now) / 1000) + 's', 10, 20);
      }
    }

    function frame(now) {
      if (!lastFrame) lastFrame = now;
      const dt = Math.min(64, now - lastFrame);
      lastFrame = now;
      if (running) {
        if (now - nextStar > 520) {
          nextStar = now;
          stars.push({ x: 0.08 + Math.random() * 0.84, y: -0.05, speed: 0.00015 + Math.random() * 0.00012 });
        }
        stars.forEach(function (star) { star.y += star.speed * dt; });
        stars = stars.filter(function (star) {
          if (star.y > 0.93 && Math.abs(star.x - basket) < 0.1) {
            score += 1;
            return false;
          }
          return star.y < 1.05;
        });
        statusEl.textContent = 'Score ' + score + ' · Best ' + best;
        if (now >= endsAt) end();
      }
      draw(now);
      requestAnimationFrame(frame);
    }

    function start() {
      running = true;
      score = 0;
      stars = [];
      nextStar = 0;
      lastFrame = 0;
      endsAt = performance.now() + ROUND_MS;
      startBtn.disabled = true;
      startBtn.textContent = 'Playing…';
      statusEl.textContent = 'Score 0 · Best ' + best;
    }

    function end() {
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Play again';
      statusEl.textContent = 'Score ' + score + ' · Best ' + best;
      postScore(score);
    }

    startBtn.addEventListener('click', start);

    canvas.addEventListener('pointermove', function (event) {
      const rect = canvas.getBoundingClientRect();
      basket = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') basket = Math.max(0, basket - 0.06);
      if (event.key === 'ArrowRight') basket = Math.min(1, basket + 0.06);
    });

${scorePageHelpers}

    requestAnimationFrame(frame);
    loadScores();`;

module.exports = { id, label, caption, docs, routes: scoreRoutes, bootstrap: scoreBootstrap, body, script };
