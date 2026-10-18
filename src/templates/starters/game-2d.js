'use strict';

// 2D game starting point: catch the falling stars in a basket on a canvas.
// A missed star ends the round, and the score goes to a shared top-ten
// board. No combat, weapons, betting or randomized rewards.

module.exports = {
  key: '2d',
  title: '2D game',
  caption: 'A small catch-the-stars game on a canvas.',

  welcome: `      <p class="text-sm text-zinc-300 leading-relaxed">This starter is a small catch-the-stars game. Move the basket with the pointer or the arrow keys, and see how long you can keep the stars from falling past it.</p>`,

  exampleCard: `
      <div class="w-full flex flex-col items-center gap-3">
        <div class="flex w-full items-center justify-between gap-2">
          <span id="game-score" class="text-sm text-zinc-400">Score: 0</span>
          <button id="game-start" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-1.5 text-sm font-semibold text-white">Play</button>
        </div>
        <canvas id="game-canvas" width="320" height="320" class="w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-950"></canvas>
        <p id="game-status" class="text-xs text-zinc-500" role="status">Catch the falling stars in the basket.</p>
        <div class="w-full max-w-sm">
          <h3 class="mb-2 text-center text-sm font-medium text-zinc-500">Top ten</h3>
          <div id="game-scores" class="space-y-1"></div>
        </div>
      </div>
`,

  script: `
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};
    const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('game-score');
    const statusEl = document.getElementById('game-status');
    const startBtn = document.getElementById('game-start');
    const basket = { x: 160, w: 56, h: 14 };
    let stars = [];
    let score = 0;
    let running = false;
    let lastSpawn = 0;
    let frame = null;

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#a78bfa';
      for (const star of stars) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#e4e4e7';
      ctx.fillRect(basket.x - basket.w / 2, canvas.height - 22, basket.w, basket.h);
    }

    async function postScore() {
      await fetch('/api/scores', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ score }),
      });
    }

    async function loadScores() {
      const box = document.getElementById('game-scores');
      try {
        const res = await fetch('/api/scores', { headers });
        if (!res.ok) throw new Error('Could not load scores');
        const { scores } = await res.json();
        box.textContent = '';
        if (!scores.length) {
          box.appendChild(el('p', 'text-center text-sm text-zinc-600', 'No scores yet'));
          return;
        }
        scores.forEach((row, i) => {
          const line = el('div', 'flex justify-between rounded px-3 py-1 ' +
            (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400'));
          line.appendChild(el('span', null, (i + 1) + '. ' + row.username));
          line.appendChild(el('span', 'font-mono', String(row.score)));
          box.appendChild(line);
        });
      } catch {
        box.textContent = '';
        box.appendChild(el('p', 'text-center text-sm text-red-300', 'Scores could not load.'));
      }
    }

    function endRound() {
      running = false;
      cancelAnimationFrame(frame);
      statusEl.textContent = 'Round over. Score: ' + score + '.';
      startBtn.textContent = 'Play again';
      postScore();
      loadScores();
    }

    function tick(now) {
      if (!running) return;
      if (now - lastSpawn > 900) {
        lastSpawn = now;
        stars.push({ x: 20 + Math.random() * (canvas.width - 40), y: -8 });
      }
      for (const star of stars) star.y += 2.4;
      const floor = canvas.height - 30;
      const caught = stars.filter((s) => s.y >= floor && s.y <= floor + 14 && Math.abs(s.x - basket.x) < basket.w / 2 + 6);
      const missed = stars.filter((s) => s.y > canvas.height + 8);
      if (caught.length) {
        score += caught.length;
        scoreEl.textContent = 'Score: ' + score;
      }
      stars = stars.filter((s) => !caught.includes(s) && !missed.includes(s));
      draw();
      if (missed.length) {
        endRound();
        return;
      }
      frame = requestAnimationFrame(tick);
    }

    function start() {
      stars = [];
      score = 0;
      scoreEl.textContent = 'Score: 0';
      statusEl.textContent = 'Catch the falling stars in the basket.';
      startBtn.textContent = 'Playing';
      running = true;
      lastSpawn = performance.now() - 900;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    }

    function moveTo(clientX) {
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      basket.x = Math.max(basket.w / 2, Math.min(canvas.width - basket.w / 2, (clientX - rect.left) * scale));
    }

    canvas.addEventListener('pointermove', (event) => moveTo(event.clientX));
    canvas.addEventListener('pointerdown', (event) => moveTo(event.clientX));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') basket.x = Math.max(basket.w / 2, basket.x - 18);
      else if (event.key === 'ArrowRight') basket.x = Math.min(canvas.width - basket.w / 2, basket.x + 18);
    });
    startBtn.addEventListener('click', start);

    draw();
    loadScores();
  `,

  routes: `// The top-ten board
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, score, created_at
      FROM game_scores
      ORDER BY score DESC, created_at ASC
      LIMIT 10
    \`);
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a finished round
app.post('/api/scores', async (req, res) => {
  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 0 || score > 9999) {
    return res.status(400).json({ error: 'Score must be a whole number from 0 to 9999.' });
  }
  try {
    await pool.query(\`
      INSERT INTO game_scores (user_id, username, score) VALUES ($1, $2, $3)
    \`, [req.user.id, req.user.username, score]);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`,

  bootstrapSql: `    CREATE TABLE IF NOT EXISTS game_scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

  readmeDatabase: 'the\n  demo keeps finished rounds in a `game_scores` table.',
  readmeApi: 'the example routes (`/api/scores`) read and\n  write the top-ten board through a real Express server.',
  claudeDemo: 'the catch-the-stars game (the demo markup in\n`public/index.html`, the `/api/scores` routes, and the `game_scores` table\nbootstrap in `server.js`)',
  claudeRemove: '- remove or repurpose the "Try the example" card, its demo endpoints and\n  the `game_scores` table as appropriate,',
};
