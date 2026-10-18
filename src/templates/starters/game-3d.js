'use strict';

// 3D game starting point: a cube on a 5 by 5 board, moved with the arrow
// keys or the on-screen buttons to collect glowing orbs. Built with CSS 3D
// transforms, so it adds no dependency. A round ends after ten orbs, and the
// score goes to a shared top-ten board. No combat, weapons, betting or
// randomized rewards.

module.exports = {
  key: '3d',
  title: '3D game',
  caption: 'A small 3D board you move around to collect orbs.',

  welcome: `      <p class="text-sm text-zinc-300 leading-relaxed">This starter is a small 3D board. Move the cube with the arrow keys or the buttons to collect the glowing orbs, and see how quickly you can clear ten.</p>`,

  exampleCard: `
      <div class="w-full flex flex-col items-center gap-3">
        <div class="flex w-full items-center justify-between gap-2">
          <span id="orb-score" class="text-sm text-zinc-400">Score: 0</span>
          <button id="orb-start" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-1.5 text-sm font-semibold text-white">Play</button>
        </div>
        <span id="orb-count" class="text-xs text-zinc-500">0 of 10 orbs</span>
        <div class="w-full max-w-xs overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 py-8">
          <div id="orb-board" style="position:relative;width:260px;height:260px;margin:0 auto;transform-style:preserve-3d;transform:rotateX(55deg);"></div>
        </div>
        <div class="grid grid-cols-3 gap-2" aria-label="Move the cube">
          <span></span>
          <button type="button" data-move="up" class="h-10 w-14 rounded-lg border border-zinc-700 text-sm font-semibold text-zinc-100 hover:border-violet-500">Up</button>
          <span></span>
          <button type="button" data-move="left" class="h-10 w-14 rounded-lg border border-zinc-700 text-sm font-semibold text-zinc-100 hover:border-violet-500">Left</button>
          <span></span>
          <button type="button" data-move="right" class="h-10 w-14 rounded-lg border border-zinc-700 text-sm font-semibold text-zinc-100 hover:border-violet-500">Right</button>
          <span></span>
          <button type="button" data-move="down" class="h-10 w-14 rounded-lg border border-zinc-700 text-sm font-semibold text-zinc-100 hover:border-violet-500">Down</button>
          <span></span>
        </div>
        <p id="orb-status" class="text-xs text-zinc-500" role="status">Move the cube with the arrow keys or the buttons.</p>
        <div class="w-full max-w-sm">
          <h3 class="mb-2 text-center text-sm font-medium text-zinc-500">Top ten</h3>
          <div id="orb-scores" class="space-y-1"></div>
        </div>
      </div>
`,

  script: `
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};
    const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

    const board = document.getElementById('orb-board');
    const scoreEl = document.getElementById('orb-score');
    const countEl = document.getElementById('orb-count');
    const statusEl = document.getElementById('orb-status');
    const startBtn = document.getElementById('orb-start');
    const TOTAL = 10;
    const SIZE = 52;

    let pos = { x: 2, y: 2 };
    let orbPos = { x: 0, y: 0 };
    let score = 0;
    let collected = 0;
    let playing = false;

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const cell = document.createElement('div');
        cell.className = 'absolute rounded border border-zinc-700 bg-zinc-900';
        cell.style.width = '44px';
        cell.style.height = '44px';
        cell.style.left = (x * SIZE) + 'px';
        cell.style.top = (y * SIZE) + 'px';
        board.appendChild(cell);
      }
    }

    const orb = document.createElement('div');
    orb.className = 'absolute rounded-full bg-emerald-400';
    orb.style.width = '18px';
    orb.style.height = '18px';
    orb.style.transform = 'translateZ(10px)';
    orb.style.boxShadow = '0 0 14px rgba(52, 211, 153, 0.8)';
    board.appendChild(orb);

    const cube = document.createElement('div');
    cube.className = 'absolute rounded bg-violet-500';
    cube.style.width = '36px';
    cube.style.height = '36px';
    cube.style.transform = 'translateZ(14px)';
    cube.style.transition = 'left 120ms ease, top 120ms ease';
    cube.style.boxShadow = '0 0 18px rgba(167, 139, 250, 0.65)';
    board.appendChild(cube);

    function place(node, x, y, inset) {
      node.style.left = (x * SIZE + inset) + 'px';
      node.style.top = (y * SIZE + inset) + 'px';
    }

    function newOrb() {
      do {
        orbPos = { x: Math.floor(Math.random() * 5), y: Math.floor(Math.random() * 5) };
      } while (orbPos.x === pos.x && orbPos.y === pos.y);
      place(orb, orbPos.x, orbPos.y, 15);
    }

    async function postScore() {
      await fetch('/api/scores', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ score }),
      });
    }

    async function loadScores() {
      const box = document.getElementById('orb-scores');
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

    function move(dx, dy) {
      if (!playing) return;
      pos.x = Math.max(0, Math.min(4, pos.x + dx));
      pos.y = Math.max(0, Math.min(4, pos.y + dy));
      place(cube, pos.x, pos.y, 8);
      if (pos.x === orbPos.x && pos.y === orbPos.y) {
        score += 10;
        collected += 1;
        scoreEl.textContent = 'Score: ' + score;
        countEl.textContent = collected + ' of ' + TOTAL + ' orbs';
        if (collected >= TOTAL) {
          playing = false;
          statusEl.textContent = 'Round over. Score: ' + score + '.';
          startBtn.textContent = 'Play again';
          postScore();
          loadScores();
        } else {
          newOrb();
        }
      }
    }

    function start() {
      pos = { x: 2, y: 2 };
      score = 0;
      collected = 0;
      playing = true;
      scoreEl.textContent = 'Score: 0';
      countEl.textContent = '0 of ' + TOTAL + ' orbs';
      statusEl.textContent = 'Collect the glowing orbs.';
      startBtn.textContent = 'Playing';
      place(cube, pos.x, pos.y, 8);
      newOrb();
    }

    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') { event.preventDefault(); move(0, -1); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); move(0, 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1, 0); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); move(1, 0); }
    });
    for (const button of document.querySelectorAll('[data-move]')) {
      button.addEventListener('click', () => {
        const dir = button.getAttribute('data-move');
        if (dir === 'up') move(0, -1);
        else if (dir === 'down') move(0, 1);
        else if (dir === 'left') move(-1, 0);
        else if (dir === 'right') move(1, 0);
      });
    }
    startBtn.addEventListener('click', start);

    place(cube, pos.x, pos.y, 8);
    place(orb, orbPos.x, orbPos.y, 15);
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
  claudeDemo: 'the orb-collecting 3D game (the demo markup in\n`public/index.html`, the `/api/scores` routes, and the `game_scores` table\nbootstrap in `server.js`)',
  claudeRemove: '- remove or repurpose the "Try the example" card, its demo endpoints and\n  the `game_scores` table as appropriate,',
};
