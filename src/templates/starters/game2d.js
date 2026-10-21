'use strict';

/**
 * The 2D game starter: catch the stars. A canvas game with arrow-key and
 * drag controls, a score line, and a shared top ten on the same screen. A
 * missed star ends the round and posts the score.
 */

const { escapeHtml, starterDocument, starterServer } = require('./scaffold');

const TITLE = '2D game';

function document(appName) {
  const body = `    <header class="text-center">
      <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
      <p class="text-sm text-zinc-400">Catch the stars</p>
    </header>

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-zinc-300">Score <strong id="score" class="text-violet-300">0</strong></p>
        <button id="play" type="button"
                class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500">Play</button>
      </div>
      <canvas id="game" width="640" height="400" aria-label="Catch the stars"
              class="mt-3 w-full touch-none rounded-lg bg-zinc-950"></canvas>
      <p class="mt-2 text-center text-xs leading-relaxed text-zinc-500">Move with the arrow keys or by dragging. A missed star ends the round.</p>
      <p id="error" class="mt-2 hidden text-sm text-red-400" role="alert"></p>
    </section>

    <section>
      <h2 class="mb-2 px-1 text-sm font-medium text-zinc-500">Best scores</h2>
      <ol id="scores" class="space-y-1 text-sm text-zinc-400"></ol>
    </section>`;

  const script = `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const playBtn = document.getElementById('play');
    const scoresEl = document.getElementById('scores');
    const errorLine = document.getElementById('error');

    const W = canvas.width;
    const H = canvas.height;
    const CATCHER_W = 88;
    const CATCHER_Y = H - 26;

    let running = false;
    let score = 0;
    let catcherX = W / 2;
    let move = 0;
    let star = null;
    let frame = 0;
    let last = 0;

    function say(text) {
      errorLine.textContent = text || '';
      errorLine.classList.toggle('hidden', !text);
    }

    function spawn() {
      star = {
        x: 28 + Math.random() * (W - 56),
        y: -20,
        r: 11,
        vy: 2 + Math.min(score, 40) * 0.09,
      };
    }

    function draw() {
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#7c3aed';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(catcherX - CATCHER_W / 2, CATCHER_Y, CATCHER_W, 14, 7);
      } else {
        ctx.rect(catcherX - CATCHER_W / 2, CATCHER_Y, CATCHER_W, 14);
      }
      ctx.fill();

      if (star) {
        ctx.save();
        ctx.shadowColor = '#a78bfa';
        ctx.shadowBlur = 14;
        ctx.fillStyle = '#c4b5fd';
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    function loop(now) {
      if (!running) return;
      const dt = last ? Math.min(34, now - last) / 16.67 : 1;
      last = now;

      catcherX = Math.max(CATCHER_W / 2, Math.min(W - CATCHER_W / 2, catcherX + move * 7.5 * dt));
      star.y += star.vy * dt;

      const caught = star.y + star.r >= CATCHER_Y
        && star.y + star.r <= CATCHER_Y + 22
        && Math.abs(star.x - catcherX) <= CATCHER_W / 2 + star.r;
      if (caught) {
        score += 1;
        scoreEl.textContent = String(score);
        spawn();
      } else if (star.y - star.r > H) {
        draw();
        end();
        return;
      }
      draw();
      frame = requestAnimationFrame(loop);
    }

    function start() {
      cancelAnimationFrame(frame);
      running = true;
      score = 0;
      scoreEl.textContent = '0';
      catcherX = W / 2;
      move = 0;
      last = 0;
      spawn();
      playBtn.classList.add('hidden');
      say('');
      draw();
      frame = requestAnimationFrame(loop);
    }

    async function end() {
      running = false;
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

    window.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (running) event.preventDefault();
        move = event.key === 'ArrowLeft' ? -1 : 1;
      }
    });
    window.addEventListener('keyup', function (event) {
      if ((event.key === 'ArrowLeft' && move === -1) || (event.key === 'ArrowRight' && move === 1)) move = 0;
    });

    function aim(event) {
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (W / rect.width);
      catcherX = Math.max(CATCHER_W / 2, Math.min(W - CATCHER_W / 2, x));
    }
    canvas.addEventListener('pointerdown', function (event) {
      canvas.setPointerCapture(event.pointerId);
      aim(event);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (event.buttons) aim(event);
    });

    playBtn.addEventListener('click', start);
    draw();
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

module.exports = { key: 'game2d', title: TITLE, document, server };
