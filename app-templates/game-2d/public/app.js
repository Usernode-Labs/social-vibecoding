/* Star catch: catch falling stars in a basket. Three misses end the round. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var headers = token ? { 'x-usernode-token': token } : {};
  var canvas = document.getElementById('game-canvas');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('game-score');
  var missesEl = document.getElementById('game-misses');
  var overlay = document.getElementById('game-overlay');
  var overlayTitle = document.getElementById('game-overlay-title');
  var overlayNote = document.getElementById('game-overlay-note');
  var startButton = document.getElementById('game-start');
  var errorEl = document.getElementById('game-error');
  var listEl = document.getElementById('leaderboard-list');
  var emptyEl = document.getElementById('leaderboard-empty');
  var bestEl = document.getElementById('your-best');

  var W = 360;
  var H = 320;
  var basket = { x: W / 2, w: 92, h: 18 };
  var stars = [];
  var score = 0;
  var misses = 0;
  var playing = false;
  var last = 0;
  var spawnIn = 0;
  var keyLeft = false;
  var keyRight = false;
  var dragging = false;
  var reported = false;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var ratio = window.devicePixelRatio || 1;
    W = Math.max(240, Math.round(rect.width));
    H = Math.max(240, Math.round(rect.height));
    canvas.width = Math.round(W * ratio);
    canvas.height = Math.round(H * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    basket.x = Math.min(Math.max(basket.x, basket.w / 2), W - basket.w / 2);
    draw();
  }

  function reset() {
    score = 0;
    misses = 0;
    stars = [];
    spawnIn = 0;
    reported = false;
    basket.x = W / 2;
    updateStats();
  }

  function updateStats() {
    scoreEl.textContent = 'Score ' + score;
    missesEl.textContent = (3 - misses) + (3 - misses === 1 ? ' miss left' : ' misses left');
  }

  function spawn() {
    var size = 12 + Math.random() * 8;
    stars.push({ x: 16 + Math.random() * (W - 32), y: -size, r: size / 2, vy: 90 + Math.random() * 90 });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0f172a');
    sky.addColorStop(1, '#1e293b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    stars.forEach(function (star) {
      ctx.beginPath();
      ctx.fillStyle = star.r > 8 ? '#fbbf24' : '#fde68a';
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(basket.x - basket.w / 2, H - 28);
    ctx.lineTo(basket.x + basket.w / 2, H - 28);
    ctx.lineTo(basket.x + basket.w / 2 - 14, H - 8);
    ctx.lineTo(basket.x - basket.w / 2 + 14, H - 8);
    ctx.closePath();
    ctx.fill();
  }

  function tick(now) {
    if (!playing) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    if (keyLeft) basket.x -= 320 * dt;
    if (keyRight) basket.x += 320 * dt;
    basket.x = Math.min(Math.max(basket.x, basket.w / 2), W - basket.w / 2);

    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = Math.max(0.35, 0.95 - score * 0.02);
    }

    for (var i = stars.length - 1; i >= 0; i -= 1) {
      var star = stars[i];
      star.y += star.vy * dt;
      var caught = star.y + star.r >= H - 30 && star.y - star.r <= H - 8
        && Math.abs(star.x - basket.x) <= basket.w / 2;
      if (caught) {
        stars.splice(i, 1);
        score += 1;
        updateStats();
      } else if (star.y - star.r > H) {
        stars.splice(i, 1);
        misses += 1;
        updateStats();
        if (misses >= 3) {
          finish();
          return;
        }
      }
    }

    draw();
    window.requestAnimationFrame(tick);
  }

  function start() {
    reset();
    playing = true;
    last = performance.now();
    overlay.classList.add('hidden');
    errorEl.classList.add('hidden');
    window.requestAnimationFrame(tick);
  }

  function finish() {
    playing = false;
    draw();
    overlayTitle.textContent = 'Round over: ' + score + (score === 1 ? ' star' : ' stars');
    overlayNote.textContent = 'Saved. Can you beat it?';
    startButton.textContent = 'Play again';
    overlay.classList.remove('hidden');
    saveScore(score);
  }

  function saveScore(value) {
    if (reported) return;
    reported = true;
    fetch('/api/scores', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({ score: value }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'The score could not be saved.');
        renderBoard(data);
      });
    }).catch(function (err) {
      errorEl.textContent = err.message + ' The leaderboard may be out of date.';
      errorEl.classList.remove('hidden');
      loadBoard();
    });
  }

  function renderBoard(data) {
    var scores = (data && data.scores) || [];
    bestEl.textContent = 'Your best: ' + ((data && data.yourBest) || 0);
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', scores.length > 0);
    scores.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'flex items-center justify-between px-4 py-3 text-sm';
      var name = document.createElement('span');
      name.textContent = '@' + row.username;
      var best = document.createElement('span');
      best.className = 'font-semibold';
      best.textContent = String(row.best);
      li.appendChild(name);
      li.appendChild(best);
      listEl.appendChild(li);
    });
  }

  function loadBoard() {
    fetch('/api/scores', { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error('The leaderboard could not be loaded.');
      return res.json();
    }).then(renderBoard).catch(function (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  }

  function moveTo(clientX) {
    var rect = canvas.getBoundingClientRect();
    basket.x = Math.min(Math.max(clientX - rect.left, basket.w / 2), W - basket.w / 2);
    if (!playing) draw();
  }

  canvas.addEventListener('pointerdown', function (event) {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (dragging) moveTo(event.clientX);
  });
  canvas.addEventListener('pointerup', function () { dragging = false; });
  canvas.addEventListener('pointercancel', function () { dragging = false; });

  window.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') keyLeft = true;
    if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') keyRight = true;
    if (playing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) event.preventDefault();
  });
  window.addEventListener('keyup', function (event) {
    if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') keyLeft = false;
    if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') keyRight = false;
  });

  startButton.addEventListener('click', start);
  window.addEventListener('resize', resize);

  resize();
  updateStats();
  loadBoard();
})();
