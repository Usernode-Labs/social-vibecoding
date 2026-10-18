'use strict';

// The "3D game" starter: Cube collector. The scene is a CSS 3D floor and nine
// cubes, drawn with the browser's own transforms — no library, no WebGL and
// no downloaded assets. See index.js for the shape every starter module
// shares.

const id = 'game-3d';
const label = '3D game';
const caption = 'A cube-collecting game drawn in 3D.';

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
  claude: `The screen this app currently ships is a **Cube collector** example (the demo
markup in \`public/index.html\`, the \`/api/scores\` routes, and the
\`game_scores\` table bootstrap in \`server.js\`) — placeholder content from
the Homeroom starter template, not product intent. The scene is a CSS 3D
floor and nine cubes: no library, no WebGL and no downloaded assets. A round
lasts 45 seconds and ends early once all nine cubes are collected.`,
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
      <h3 class="text-base font-semibold mt-4">Cube collector</h3>
      <p id="game-status" class="text-[13px] text-zinc-400 m-0 mt-0.5 mb-3">Score 0 · Best 0</p>
      <div id="game-stage" class="relative h-56 rounded-xl bg-zinc-900 border border-zinc-700 overflow-hidden touch-none">
        <div id="game-floor"></div>
      </div>
      <button id="game-start" type="button" class="mt-3.5 bg-violet-600 hover:bg-violet-500 text-white rounded-full px-6 py-2 text-sm font-semibold">Start</button>
      <p class="text-[13px] text-zinc-500 mt-4 mb-1.5 text-center">Leaderboard</p>
      <div id="game-scores" class="space-y-1"></div>
    </section>
    <style>
      #game-stage { perspective: 700px; }
      #game-floor {
        position: absolute;
        left: 50%;
        top: 52%;
        width: 240px;
        height: 240px;
        margin: -120px 0 0 -120px;
        transform: rotateX(56deg);
        transform-style: preserve-3d;
      }
      .game-cell {
        position: absolute;
        width: 80px;
        height: 80px;
        box-sizing: border-box;
        border: 1px solid #3f3f46;
      }
      .game-cube {
        position: absolute;
        width: 56px;
        height: 56px;
        margin: 12px;
        background: #7c3aed;
        border-radius: 8px;
        transform: translateZ(16px);
        box-shadow: 0 0 0 1px #a78bfa inset;
      }
      .game-player {
        position: absolute;
        width: 56px;
        height: 56px;
        margin: 12px;
        background: #c4b5fd;
        border-radius: 8px;
        transform: translateZ(28px);
        transition: left 0.12s, top 0.12s;
      }
    </style>`;
}

const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const stage = document.getElementById('game-stage');
    const floor = document.getElementById('game-floor');
    const statusEl = document.getElementById('game-status');
    const startBtn = document.getElementById('game-start');
    const scoresEl = document.getElementById('game-scores');

    const SIZE = 3;
    const CELL = 80;
    const ROUND_MS = 45000;
    let best = 0;
    let running = false;
    let score = 0;
    let endsAt = 0;
    let player = { row: 1, col: 1 };
    let cubes = [];

    function place(el, row, col) {
      el.style.left = (col * CELL) + 'px';
      el.style.top = (row * CELL) + 'px';
    }

    // Build the floor: nine grid cells, nine cubes and the player.
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const cell = document.createElement('div');
        cell.className = 'game-cell';
        place(cell, row, col);
        floor.appendChild(cell);
      }
    }
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const cube = document.createElement('div');
        cube.className = 'game-cube';
        place(cube, row, col);
        floor.appendChild(cube);
        cubes.push({ row: row, col: col, el: cube });
      }
    }
    const playerEl = document.createElement('div');
    playerEl.className = 'game-player';
    place(playerEl, player.row, player.col);
    floor.appendChild(playerEl);

    function reset() {
      cubes.forEach(function (cube) { cube.el.style.display = ''; });
    }

    function status() {
      const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
      statusEl.textContent = 'Score ' + score + ' · Best ' + best + (running ? ' · ' + left + 's' : '');
    }

    function move(drow, dcol) {
      if (!running) return;
      player.row = Math.min(SIZE - 1, Math.max(0, player.row + drow));
      player.col = Math.min(SIZE - 1, Math.max(0, player.col + dcol));
      place(playerEl, player.row, player.col);
      cubes.forEach(function (cube) {
        if (cube.el.style.display !== 'none' && cube.row === player.row && cube.col === player.col) {
          cube.el.style.display = 'none';
          score += 1;
        }
      });
      status();
      if (score >= cubes.length) end();
    }

    function start() {
      running = true;
      score = 0;
      player = { row: 1, col: 1 };
      place(playerEl, player.row, player.col);
      reset();
      endsAt = performance.now() + ROUND_MS;
      startBtn.disabled = true;
      startBtn.textContent = 'Playing…';
      status();
    }

    function end() {
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Play again';
      status();
      postScore(score);
    }

    startBtn.addEventListener('click', start);

    window.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') move(0, -1);
      if (event.key === 'ArrowRight') move(0, 1);
      if (event.key === 'ArrowUp') move(-1, 0);
      if (event.key === 'ArrowDown') move(1, 0);
    });

    let swipe = null;
    stage.addEventListener('pointerdown', function (event) {
      swipe = { x: event.clientX, y: event.clientY };
    });
    stage.addEventListener('pointerup', function (event) {
      if (!swipe) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) move(0, dx > 0 ? 1 : -1);
      else move(dy > 0 ? 1 : -1, 0);
    });

    setInterval(function () {
      if (running) {
        status();
        if (performance.now() >= endsAt) end();
      }
    }, 250);

${scorePageHelpers}

    loadScores();`;

module.exports = { id, label, caption, docs, routes: scoreRoutes, bootstrap: scoreBootstrap, body, script };
