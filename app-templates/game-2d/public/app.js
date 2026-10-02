// Star catcher: a small 2D canvas game. Move the basket with the arrow keys,
// A and D, or a finger, and catch the falling stars. Gold stars are worth
// three. Three missed stars end the round, and the score goes to the
// leaderboard (api.js).
//
// The shape of it, for whoever changes it next:
//   - the world is WORLD_W x WORLD_H units, scaled to whatever size the
//     canvas is drawn at, so the game plays the same on a phone and a desk;
//   - update(dt) moves everything by the time since the last frame, so speed
//     does not depend on the screen's refresh rate;
//   - draw() paints the current state, and runs every frame, playing or not.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var canvas = document.querySelector('#game canvas');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('score');
  var livesEl = document.getElementById('hud-right');
  var overlay = document.getElementById('overlay');
  var overlayTitle = document.getElementById('overlay-title');
  var overlayText = document.getElementById('overlay-text');
  var startBtn = document.getElementById('start-btn');

  var WORLD_W = 360;
  var WORLD_H = 480;
  var BASKET_W = 68;
  var BASKET_H = 16;
  var BASKET_Y = WORLD_H - 44;
  var BASKET_SPEED = 380; // units per second
  var LIVES = 3;

  // Fixed background twinkles, the same every load.
  var sky = [];
  for (var i = 0; i < 40; i++) {
    sky.push({ x: (i * 97) % WORLD_W, y: (i * 53) % (WORLD_H - 80), r: 0.6 + (i % 3) * 0.4 });
  }

  var state = {
    playing: false,
    score: 0,
    lives: LIVES,
    basketX: WORLD_W / 2,
    stars: [],
    spawnIn: 0,
    elapsed: 0,
  };
  var keys = { left: false, right: false };
  var pointerX = null;

  // ── Sizing: draw at the canvas's real pixel size, think in world units ──

  var scale = 1;
  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    scale = canvas.width / WORLD_W;
  }
  window.addEventListener('resize', resize);

  // ── Input ───────────────────────────────────────────────────────────

  function setKey(e, down) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = down;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = down;
    else return;
    if (state.playing) e.preventDefault();
  }
  window.addEventListener('keydown', function (e) { setKey(e, true); });
  window.addEventListener('keyup', function (e) { setKey(e, false); });

  function toWorldX(clientX) {
    var rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * WORLD_W;
  }
  canvas.addEventListener('pointerdown', function (e) { pointerX = toWorldX(e.clientX); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', function (e) { if (pointerX !== null) pointerX = toWorldX(e.clientX); });
  canvas.addEventListener('pointerup', function () { pointerX = null; });
  canvas.addEventListener('pointercancel', function () { pointerX = null; });

  // ── The rules ───────────────────────────────────────────────────────

  function start() {
    state.playing = true;
    state.score = 0;
    state.lives = LIVES;
    state.stars = [];
    state.spawnIn = 0.4;
    state.elapsed = 0;
    state.basketX = WORLD_W / 2;
    overlay.classList.add('hidden');
    hud();
  }

  function end() {
    state.playing = false;
    overlayTitle.textContent = 'Round over: ' + state.score + (state.score === 1 ? ' star' : ' stars');
    overlayText.textContent = 'Saving your score…';
    startBtn.textContent = 'Play again';
    overlay.classList.remove('hidden');
    submitScore(state.score);
  }

  function hud() {
    scoreEl.textContent = 'Score ' + state.score;
    livesEl.textContent = state.lives + (state.lives === 1 ? ' miss left' : ' misses left');
  }

  function update(dt) {
    state.elapsed += dt;
    // Speed and spawn rate creep up as the round goes on.
    var level = Math.min(1, state.elapsed / 90);
    var fall = 120 + level * 160;

    var dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (pointerX !== null) {
      var diff = pointerX - state.basketX;
      dir = Math.abs(diff) < 4 ? 0 : Math.sign(diff);
    }
    state.basketX += dir * BASKET_SPEED * dt;
    state.basketX = Math.max(BASKET_W / 2, Math.min(WORLD_W - BASKET_W / 2, state.basketX));

    state.spawnIn -= dt;
    if (state.spawnIn <= 0) {
      state.spawnIn = 0.95 - level * 0.55;
      var gold = Math.random() < 0.1;
      state.stars.push({ x: 16 + Math.random() * (WORLD_W - 32), y: -12, r: gold ? 11 : 9, gold: gold, spin: Math.random() * 6 });
    }

    var left = state.basketX - BASKET_W / 2;
    var right = state.basketX + BASKET_W / 2;
    for (var i = state.stars.length - 1; i >= 0; i--) {
      var s = state.stars[i];
      var before = s.y;
      s.y += fall * dt;
      s.spin += dt * 2;
      var crossed = before < BASKET_Y && s.y >= BASKET_Y;
      if (crossed && s.x >= left - s.r * 0.5 && s.x <= right + s.r * 0.5) {
        state.stars.splice(i, 1);
        state.score += s.gold ? 3 : 1;
        hud();
      } else if (s.y - s.r > WORLD_H) {
        state.stars.splice(i, 1);
        state.lives -= 1;
        hud();
        if (state.lives <= 0) { end(); return; }
      }
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  function starPath(x, y, r, spin) {
    ctx.beginPath();
    for (var p = 0; p < 10; p++) {
      var rad = p % 2 === 0 ? r : r * 0.45;
      var a = spin + (p * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
  }

  function draw() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    var g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
    g.addColorStop(0, '#0f172a');
    g.addColorStop(1, '#312e81');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    sky.forEach(function (s) { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); });

    ctx.fillStyle = '#14532d';
    ctx.fillRect(0, WORLD_H - 22, WORLD_W, 22);

    state.stars.forEach(function (s) {
      starPath(s.x, s.y, s.r, s.spin);
      ctx.fillStyle = s.gold ? '#fbbf24' : '#e0f2fe';
      ctx.fill();
    });

    var bx = state.basketX - BASKET_W / 2;
    ctx.fillStyle = '#a16207';
    ctx.beginPath();
    ctx.moveTo(bx, BASKET_Y);
    ctx.lineTo(bx + BASKET_W, BASKET_Y);
    ctx.lineTo(bx + BASKET_W - 8, BASKET_Y + BASKET_H);
    ctx.lineTo(bx + 8, BASKET_Y + BASKET_H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ca8a04';
    ctx.fillRect(bx - 2, BASKET_Y - 3, BASKET_W + 4, 4);
  }

  // ── The loop ────────────────────────────────────────────────────────

  var last = 0;
  function frame(now) {
    // At most a tenth of a second per step: a tab that was in the
    // background must not drop a second of stars all at once.
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (state.playing && !document.hidden) update(dt);
    draw();
    if (!canvas.hasAttribute('data-ready')) canvas.setAttribute('data-ready', 'true');
    requestAnimationFrame(frame);
  }

  startBtn.addEventListener('click', start);

  // ── The leaderboard ─────────────────────────────────────────────────

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
          return data;
        });
      });
  }

  function renderBoard(data) {
    var list = document.getElementById('leaderboard');
    list.textContent = '';
    if (!data.leaderboard.length) {
      var empty = document.createElement('li');
      empty.className = 'px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400';
      empty.textContent = 'No scores yet. Play a round to be first.';
      list.appendChild(empty);
    }
    data.leaderboard.forEach(function (row, i) {
      var li = document.createElement('li');
      li.className = 'flex items-center gap-3 px-4 py-2.5';
      li.setAttribute('data-score', String(row.best));
      var rank = document.createElement('span');
      rank.className = 'w-6 text-[13px] font-semibold text-zinc-500 dark:text-zinc-400 tabular-nums';
      rank.textContent = String(i + 1);
      var name = document.createElement('span');
      name.className = 'flex-1 min-w-0 truncate text-[15px]';
      name.textContent = '@' + row.username;
      var best = document.createElement('span');
      best.className = 'text-[15px] font-semibold tabular-nums';
      best.textContent = String(row.best);
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(best);
      list.appendChild(li);
    });
    document.getElementById('my-best').textContent = data.best == null ? '' : 'Your best: ' + data.best;
  }

  function submitScore(score) {
    api('POST', '/api/scores', { score: score })
      .then(function (data) { renderBoard(data); overlayText.textContent = 'Saved. Can you beat it?'; })
      .catch(function (err) { overlayText.textContent = err.message; });
  }

  resize();
  hud();
  requestAnimationFrame(frame);
  api('GET', '/api/leaderboard').then(renderBoard).catch(function (err) {
    document.getElementById('leaderboard').textContent = err.message;
  });
})();
