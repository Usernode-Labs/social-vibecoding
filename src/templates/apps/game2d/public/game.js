// Star catch — the starter 2D game's canvas loop.
//
// A paddle at the bottom follows the pointer or a finger; stars fall from
// the top. Catching one scores a point; letting one past costs a miss, and
// three misses end the run. A finished run goes to the shared scoreboard
// (GET/POST /api/scores in server.js), which the list below the canvas
// shows. The game is a template placeholder: the group's first real change
// replaces it.

(function () {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('game-status');
  const overEl = document.getElementById('game-over');
  const boardEl = document.getElementById('scoreboard');

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const headers = token ? { 'x-usernode-token': token } : {};

  const W = canvas.width;
  const H = canvas.height;
  const PADDLE_W = 70;
  const PADDLE_H = 10;
  const MISSES_ALLOWED = 3;

  let paddleX, stars, score, misses, running, lastSpawn, rafId;

  function reset() {
    paddleX = W / 2;
    stars = [];
    score = 0;
    misses = 0;
    running = true;
    lastSpawn = 0;
    overEl.textContent = '';
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function spawnStar() {
    stars.push({ x: 20 + Math.random() * (W - 40), y: -10, vy: 1.6 + Math.random() * 1.4 });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // Stars: small five-point sparks.
    ctx.fillStyle = '#e4e4e7';
    for (const s of stars) {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const b = a + Math.PI / 5;
        ctx.lineTo(s.x + 6 * Math.cos(a), s.y + 6 * Math.sin(a));
        ctx.lineTo(s.x + 2.6 * Math.cos(b), s.y + 2.6 * Math.sin(b));
      }
      ctx.closePath();
      ctx.fill();
    }
    // Paddle.
    ctx.fillStyle = '#0a6ee0';
    ctx.fillRect(paddleX - PADDLE_W / 2, H - PADDLE_H - 4, PADDLE_W, PADDLE_H);
    // Counters, drawn on the canvas so the play area carries them.
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Caught: ' + score, 8, 16);
    ctx.fillText('Misses: ' + misses + '/' + MISSES_ALLOWED, W - 92, 16);
  }

  function step(now) {
    if (now - lastSpawn > 900) { spawnStar(); lastSpawn = now; }
    for (const s of stars) s.y += s.vy;
    const paddleY = H - PADDLE_H - 4;
    stars = stars.filter((s) => {
      if (s.y >= paddleY - 6 && s.y <= paddleY + PADDLE_H && Math.abs(s.x - paddleX) <= PADDLE_W / 2 + 6) {
        score++;
        return false;
      }
      if (s.y > H) {
        misses++;
        return false;
      }
      return true;
    });
    if (misses >= MISSES_ALLOWED) {
      running = false;
      overEl.textContent = 'Run over — ' + score + ' caught. Well tried!';
      submitScore(score);
    }
    statusEl.textContent = 'Caught: ' + score + ' · Misses: ' + misses + '/' + MISSES_ALLOWED;
  }

  let lastNow = 0;
  function tick(now) {
    if (running) step(now);
    draw();
    if (running || now - lastNow < 50) rafId = requestAnimationFrame(tick);
    lastNow = now;
  }

  // Pointer and touch input: the paddle follows the pointer's x.
  function follow(clientX) {
    const rect = canvas.getBoundingClientRect();
    paddleX = Math.min(W - PADDLE_W / 2, Math.max(PADDLE_W / 2, ((clientX - rect.left) / rect.width) * W));
  }
  canvas.addEventListener('pointermove', (e) => follow(e.clientX));

  async function submitScore(final) {
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ score: final }),
      });
      if (res.ok || res.status === 401) loadScores(res.status === 401);
    } catch {}
  }

  async function loadScores(signedOut) {
    try {
      const res = await fetch('/api/scores', { headers });
      if (!res.ok) return;
      const { scores } = await res.json();
      if (signedOut) {
        boardEl.innerHTML = '<p class="text-center text-zinc-600 text-sm">Sign in to appear on the scoreboard</p>';
        return;
      }
      if (!scores.length) {
        boardEl.innerHTML = '<p class="text-center text-zinc-600 text-sm">No runs yet — set the first best</p>';
        return;
      }
      boardEl.innerHTML = scores.map((r, i) =>
        '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
        '<span>' + (i + 1) + '. ' + r.username.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' +
        '<span class="font-mono">' + r.score + '</span></div>'
      ).join('');
    } catch {}
  }

  document.getElementById('game-restart').addEventListener('click', reset);

  reset();
  loadScores(false);
})();