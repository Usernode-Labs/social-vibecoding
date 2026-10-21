'use strict';

/**
 * The 3D game starter: a gem trail drawn with the browser's own 3D CSS.
 * Steer a cube around a board with the arrow keys or the on-screen buttons,
 * collect gems before the 60 second timer runs out, and post the score to
 * the shared top ten. No new library comes with it.
 */

const { escapeHtml, starterDocument, starterServer } = require('./scaffold');

const TITLE = '3D game';

function document(appName) {
  const tiles = Array.from(
    { length: 25 },
    (_, i) => `<div class="gem-tile" data-tile="${i}"></div>`,
  ).join('\n        ');

  const body = `    <style>
      /* The board is drawn with CSS 3D: one perspective scene, one tilted
         grid, and the cube standing up off its tile. */
      .gem-scene { perspective: 800px; height: 330px; overflow: hidden; margin-top: 12px; }
      .gem-board {
        width: 250px; height: 250px; margin: 40px auto 0;
        display: grid;
        grid-template-columns: repeat(5, 50px);
        grid-template-rows: repeat(5, 50px);
        transform: rotateX(56deg) rotateZ(-24deg);
        transform-style: preserve-3d;
      }
      .gem-tile {
        position: relative; box-sizing: border-box;
        border: 1px solid rgba(139, 92, 246, 0.35);
        background: rgba(139, 92, 246, 0.08);
      }
      .gem {
        position: absolute; left: 17px; top: 17px; width: 16px; height: 16px;
        background: #a78bfa; transform: translateZ(16px) rotate(45deg);
        box-shadow: 0 0 12px #a78bfa;
      }
      .gem-cube {
        position: absolute; left: 10px; top: 10px; width: 30px; height: 30px;
        border-radius: 5px; background: #f4f4f5;
        box-shadow: inset 0 0 0 3px #7c3aed;
        transform: translateZ(22px) rotateX(-56deg) rotateZ(24deg);
      }
      .gem-key {
        display: flex; align-items: center; justify-content: center;
        width: 44px; height: 40px; border-radius: 10px;
        border: 1px solid #3f3f46; background: #18181b;
        color: #d4d4d8; font-size: 16px;
      }
      .gem-key:active { background: #27272a; }
    </style>

    <header class="flex items-baseline justify-between gap-2">
      <div>
        <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
        <p class="text-sm text-zinc-400">Gem trail</p>
      </div>
      <p class="text-sm text-zinc-300">Score <strong id="score" class="text-violet-300">0</strong></p>
    </header>

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="flex items-center justify-between gap-2">
        <p id="timer" class="text-xs text-zinc-400">60 seconds left</p>
        <button id="play" type="button"
                class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500">Play</button>
      </div>
      <div class="gem-scene" aria-hidden="true">
        <div id="board" class="gem-board">
        ${tiles}
        </div>
      </div>
      <div class="mt-2 flex justify-center gap-2">
        <button type="button" data-move="left" class="gem-key" aria-label="Move left">←</button>
        <button type="button" data-move="up" class="gem-key" aria-label="Move up">↑</button>
        <button type="button" data-move="down" class="gem-key" aria-label="Move down">↓</button>
        <button type="button" data-move="right" class="gem-key" aria-label="Move right">→</button>
      </div>
      <p class="mt-3 text-center text-xs leading-relaxed text-zinc-400">Collect the gems before the timer runs out. Move with the arrow keys or the buttons.</p>
      <p id="error" class="mt-2 hidden text-sm text-red-400" role="alert"></p>
    </section>

    <section>
      <h2 class="mb-2 px-1 text-sm font-medium text-zinc-500">Best scores</h2>
      <ol id="scores" class="space-y-1 text-sm text-zinc-400"></ol>
    </section>`;

  const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const tiles = Array.from(document.querySelectorAll('.gem-tile'));
    const scoreEl = document.getElementById('score');
    const timerEl = document.getElementById('timer');
    const playBtn = document.getElementById('play');
    const scoresEl = document.getElementById('scores');
    const errorLine = document.getElementById('error');

    const ROUND_SECONDS = 60;

    let pos = 12;
    let gem = 0;
    let score = 0;
    let timeLeft = ROUND_SECONDS;
    let playing = false;
    let clock = 0;

    function say(text) {
      errorLine.textContent = text || '';
      errorLine.classList.toggle('hidden', !text);
    }

    function render() {
      for (const tile of tiles) tile.replaceChildren();
      const cube = document.createElement('span');
      cube.className = 'gem-cube';
      tiles[pos].append(cube);
      if (gem !== pos) {
        const stone = document.createElement('span');
        stone.className = 'gem';
        tiles[gem].append(stone);
      }
    }

    function spawnGem() {
      let next = gem;
      while (next === pos) next = Math.floor(Math.random() * tiles.length);
      gem = next;
    }

    function move(dx, dy) {
      if (!playing) return;
      const row = Math.floor(pos / 5) + dy;
      const col = (pos % 5) + dx;
      if (row < 0 || row > 4 || col < 0 || col > 4) return;
      pos = row * 5 + col;
      if (pos === gem) {
        score += 1;
        scoreEl.textContent = String(score);
        spawnGem();
      }
      render();
    }

    function start() {
      pos = 12;
      score = 0;
      timeLeft = ROUND_SECONDS;
      playing = true;
      scoreEl.textContent = '0';
      timerEl.textContent = ROUND_SECONDS + ' seconds left';
      spawnGem();
      render();
      playBtn.classList.add('hidden');
      say('');
      clearInterval(clock);
      clock = setInterval(tick, 1000);
    }

    function tick() {
      timeLeft -= 1;
      if (timeLeft <= 0) {
        end();
        return;
      }
      timerEl.textContent = timeLeft + ' seconds left';
    }

    async function end() {
      playing = false;
      clearInterval(clock);
      timerEl.textContent = 'Time is up';
      playBtn.textContent = 'Play again';
      playBtn.classList.remove('hidden');
      if (score > 0) await submit(score);
    }

    async function submit(value) {
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ score: value }),
        });
        if (!res.ok) throw new Error('Could not save the score.');
        await loadScores();
      } catch (err) {
        say(err.message || 'Could not save the score.');
      }
    }

    async function loadScores() {
      try {
        const res = await fetch('/api/scores', { headers });
        if (!res.ok) throw new Error('Could not load the best scores.');
        const data = await res.json();
        const scores = data.scores || [];
        scoresEl.replaceChildren();
        if (!scores.length) {
          const none = document.createElement('li');
          none.className = 'px-1 text-zinc-600';
          none.textContent = 'No scores yet';
          scoresEl.append(none);
          return;
        }
        scores.forEach(function (row, i) {
          const li = document.createElement('li');
          li.className = i === 0
            ? 'flex justify-between rounded px-2 py-1 text-violet-300'
            : 'flex justify-between px-2 py-1';
          const who = document.createElement('span');
          who.textContent = (i + 1) + '. @' + row.username;
          const points = document.createElement('span');
          points.className = 'font-mono';
          points.textContent = String(row.score);
          li.append(who, points);
          scoresEl.append(li);
        });
      } catch (err) {
        say(err.message || 'Could not load the best scores.');
      }
    }

    const DIRECTIONS = {
      left: [-1, 0],
      right: [1, 0],
      up: [0, -1],
      down: [0, 1],
    };
    for (const button of document.querySelectorAll('[data-move]')) {
      button.addEventListener('click', function () {
        const d = DIRECTIONS[button.dataset.move];
        if (d) move(d[0], d[1]);
      });
    }

    window.addEventListener('keydown', function (event) {
      const key = {
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      }[event.key];
      if (!key) return;
      if (playing) event.preventDefault();
      const d = DIRECTIONS[key];
      move(d[0], d[1]);
    });

    playBtn.addEventListener('click', start);
    // A board to look at before the first round: the cube in the middle and
    // five gems around it, none of which counts until Play is pressed.
    pos = 12;
    gem = 0;
    render();
    loadScores();`;

  return starterDocument({ appName, starter: TITLE, body, script });
}

function server(slug) {
  const api = `// Shared best-scores board
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, MAX(score) AS score FROM scores ' +
      'GROUP BY user_id, username ORDER BY score DESC, username ASC LIMIT 10'
    );
    res.json({ scores: rows.map((row) => ({ username: row.username, score: Number(row.score) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  const n = Math.trunc(Number(req.body.score));
  if (!Number.isFinite(n)) return res.status(400).json({ error: 'Score must be a number.' });
  const score = Math.max(0, Math.min(9999, n));
  try {
    await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
      [req.user.id, req.user.username, score]
    );
    res.status(201).json({ ok: true, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;
  const schema = `    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`;
  return starterServer({ api, schema, slug });
}

module.exports = { key: 'game3d', title: TITLE, document, server };
