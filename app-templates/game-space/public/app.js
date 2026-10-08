// The space game's screen: the asteroid field, drawn on a canvas, and the
// lobby and leaderboard around it. The game room (public/game/room.js)
// sends a frame of everything that moves 20 times a second; this draws each
// thing a tenth of a second behind, smoothly between frames, except your
// own ship, which flies on this screen as you steer it and tells the server
// where it is. The server's rules (game/rules.js) decide everything else:
// rocks, beams, crystals, shields.
//
// Controls: arrow keys or WASD to fly (the ship turns to where it goes),
// hold Space to mine. On a touch screen, drag on the left half of the
// field to steer, and hold Beam.
//
// The field is a scene of its own, dark in both looks (CLAUDE.md "##
// Design" says so); the page around it is the design kit. Rendering builds
// elements and sets textContent, never innerHTML with people's words in it.

(function () {
  var el = {
    connection: document.getElementById('connection'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    game: document.getElementById('game'),
    score: document.getElementById('score'),
    wave: document.getElementById('wave'),
    shields: document.getElementById('shields'),
    field: document.getElementById('field'),
    canvas: document.getElementById('field-canvas'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlayText: document.getElementById('overlay-text'),
    overlayAction: document.getElementById('overlay-action'),
    beam: document.getElementById('beam'),
    over: document.getElementById('over'),
    overLine: document.getElementById('over-line'),
    overNote: document.getElementById('over-note'),
    again: document.getElementById('again'),
    players: document.getElementById('players'),
    empty: document.getElementById('empty'),
    lobbyNote: document.getElementById('lobby-note'),
    lobbyActions: document.getElementById('lobby-actions'),
    join: document.getElementById('join'),
    start: document.getElementById('start'),
    leave: document.getElementById('leave'),
    leadersSection: document.getElementById('leaders-section'),
    leaders: document.getElementById('leaders'),
    toast: document.getElementById('toast'),
    toastText: document.getElementById('toast-text'),
  };

  // The field's own colours: a night sky, whatever the page's look.
  var SKY = '#0b1020';
  var STAR = '#cbd5f5';
  var ROCK = '#8b7d6b';
  var ROCK_EDGE = '#b8a98f';
  var CRYSTAL = '#5eead4';
  var SHIP_COLOURS = ['#60a5fa', '#f472b6', '#4ade80', '#fb923c', '#a78bfa', '#22d3ee', '#facc15', '#f87171'];
  var ROCK_R = { 3: 42, 2: 26, 1: 15 };
  var SHIP_R = 14;
  var BEAM_LEN = 210;
  var ACCEL = 900;
  var DRAG = 2.2;
  var MAX_SPEED = 300; // a little under the server's limit
  var BEHIND_MS = 70; // how far behind the newest frame others are drawn

  var view = null;
  var frames = []; // the last few frames, with when they came
  var me = null; // your ship, flown here: { x, y, vx, vy, a }
  var keys = {};
  var stick = null; // a touch steering: { id, x0, y0, dx, dy }
  var beamHeld = false;
  var hidden = false;
  var stars = [];
  for (var i = 0; i < 90; i++) stars.push([Math.random(), Math.random(), Math.random() * 1.4 + 0.3]);

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var toastTimer = null;
  function toast(message) {
    el.toastText.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function isMe(id) { return !!(view && view.you && view.you.id === id); }
  function who(id, username) { return isMe(id) ? 'You' : '@' + username; }

  // ── Frames ────────────────────────────────────────────────────────────

  function newest() { return frames.length ? frames[frames.length - 1].f : null; }

  function myShip(f) {
    if (!f || !view || !view.you) return null;
    for (var i = 0; i < f.ships.length; i++) if (f.ships[i][0] === view.you.id) return f.ships[i];
    return null;
  }

  function onFrame(f) {
    frames.push({ f: f, at: performance.now() });
    if (frames.length > 6) frames.shift();
    var mine = myShip(f);
    // Launched (or joined a run): start flying from where the server put you.
    if (mine && !mine[6] && !me) me = { x: mine[1], y: mine[2], vx: 0, vy: 0, a: mine[3] };
    if ((!mine || mine[6]) && me) me = null;
    drawNumbers(f);
  }

  // The two frames either side of a moment, for drawing between them.
  function around(t) {
    var last = frames[frames.length - 1];
    if (frames.length < 2 || t >= last.at) return [last, last];
    for (var i = frames.length - 2; i >= 0; i--) if (frames[i].at <= t) return [frames[i], frames[i + 1]];
    return [frames[0], frames[0]];
  }

  // Where something was at moment t, between the two frames around then.
  function lerpAt(kind, id, idx, t) {
    var pair = around(t);
    var a = pair[0];
    var b = pair[1];
    var find = function (fr) {
      var list = fr.f[kind];
      for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i];
      return null;
    };
    var nb = find(b);
    if (!nb) return null;
    var na = a === b ? null : find(a);
    if (!na) return [nb[idx], nb[idx + 1]];
    var span = Math.max(1, b.at - a.at);
    var k = Math.max(0, Math.min(1, (t - a.at) / span));
    var w = b.f.w;
    var hh = b.f.h;
    var dx = nb[idx] - na[idx];
    var dy = nb[idx + 1] - na[idx + 1];
    if (dx > w / 2) dx -= w; else if (dx < -w / 2) dx += w;
    if (dy > hh / 2) dy -= hh; else if (dy < -hh / 2) dy += hh;
    return [(na[idx] + dx * k + w) % w, (na[idx + 1] + dy * k + hh) % hh];
  }

  // ── Flying your own ship ──────────────────────────────────────────────

  function steering() {
    var x = 0;
    var y = 0;
    if (keys.ArrowLeft || keys.KeyA) x -= 1;
    if (keys.ArrowRight || keys.KeyD) x += 1;
    if (keys.ArrowUp || keys.KeyW) y -= 1;
    if (keys.ArrowDown || keys.KeyS) y += 1;
    if (stick) {
      x = Math.max(-1, Math.min(1, stick.dx / 60));
      y = Math.max(-1, Math.min(1, stick.dy / 60));
    }
    var len = Math.hypot(x, y);
    return len > 1 ? [x / len, y / len] : [x, y];
  }

  function fly(dt) {
    var f = newest();
    if (!me || !f) return;
    var dir = steering();
    me.vx += dir[0] * ACCEL * dt;
    me.vy += dir[1] * ACCEL * dt;
    me.vx -= me.vx * DRAG * dt;
    me.vy -= me.vy * DRAG * dt;
    var speed = Math.hypot(me.vx, me.vy);
    if (speed > MAX_SPEED) { me.vx *= MAX_SPEED / speed; me.vy *= MAX_SPEED / speed; }
    me.x = (me.x + me.vx * dt + f.w) % f.w;
    me.y = (me.y + me.vy * dt + f.h) % f.h;
    if (Math.hypot(dir[0], dir[1]) > 0.2) me.a = Math.atan2(dir[1], dir[0]);
    var beam = beamHeld || !!keys.Space;
    room.input({ x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 100) / 100, beam: beam });
  }

  // ── Drawing the field ─────────────────────────────────────────────────

  var ctx = el.canvas.getContext('2d');
  var lastPaint = performance.now();

  function size() {
    var rect = el.canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width * dpr));
    var hh = Math.max(1, Math.round(rect.height * dpr));
    if (el.canvas.width !== w || el.canvas.height !== hh) {
      el.canvas.width = w;
      el.canvas.height = hh;
    }
  }

  function drawShip(x, y, a, colour, beam, cover, docked) {
    if (docked) return;
    if (beam) {
      var grad = ctx.createLinearGradient(x, y, x + Math.cos(a) * BEAM_LEN, y + Math.sin(a) * BEAM_LEN);
      grad.addColorStop(0, colour);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * SHIP_R, y + Math.sin(a) * SHIP_R);
      ctx.lineTo(x + Math.cos(a) * BEAM_LEN, y + Math.sin(a) * BEAM_LEN);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(SHIP_R + 4, 0);
    ctx.lineTo(-SHIP_R, SHIP_R * 0.8);
    ctx.lineTo(-SHIP_R * 0.5, 0);
    ctx.lineTo(-SHIP_R, -SHIP_R * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (cover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, SHIP_R + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function paint(now) {
    requestAnimationFrame(paint);
    var dt = Math.min(0.05, (now - lastPaint) / 1000);
    lastPaint = now;
    if (hidden) return;
    fly(dt);
    size();
    var f = newest();
    var W = f ? f.w : 960;
    var H = f ? f.h : 600;
    var scale = el.canvas.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = STAR;
    stars.forEach(function (s) { ctx.globalAlpha = 0.35 + s[2] / 3; ctx.fillRect(s[0] * W, s[1] * H, s[2], s[2]); });
    ctx.globalAlpha = 1;
    if (!f) return;
    var t = now - BEHIND_MS;
    var serverNow = view ? view.now + (Date.now() - view.receivedAt) : Date.now();
    f.crystals.forEach(function (c) {
      var p = lerpAt('crystals', c[0], 1, t);
      if (!p) return;
      ctx.fillStyle = CRYSTAL;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] - 8);
      ctx.lineTo(p[0] + 6, p[1]);
      ctx.lineTo(p[0], p[1] + 8);
      ctx.lineTo(p[0] - 6, p[1]);
      ctx.closePath();
      ctx.fill();
    });
    f.rocks.forEach(function (r) {
      var p = lerpAt('rocks', r[0], 1, t);
      if (!p) return;
      var rad = ROCK_R[r[3]];
      ctx.fillStyle = ROCK;
      ctx.strokeStyle = ROCK_EDGE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var k = 0; k < 9; k++) {
        var ang = (k / 9) * Math.PI * 2;
        var wob = 0.82 + 0.18 * Math.sin(r[0] * 7.1 + k * 2.3);
        var px = p[0] + Math.cos(ang) * rad * wob;
        var py = p[1] + Math.sin(ang) * rad * wob;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
    f.ships.forEach(function (s) {
      var colour = SHIP_COLOURS[s[8] % SHIP_COLOURS.length];
      var cover = s[7] > serverNow;
      if (isMe(s[0]) && me) {
        drawShip(me.x, me.y, me.a, colour, beamHeld || !!keys.Space, cover, false);
        return;
      }
      var p = lerpAt('ships', s[0], 1, t);
      if (!p) return;
      drawShip(p[0], p[1], s[3], colour, !!s[4], cover, !!s[6]);
      if (!s[6]) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('@' + s[9], p[0], p[1] - SHIP_R - 8);
      }
    });
    if (stick) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var dpr = window.devicePixelRatio || 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(stick.x0 * dpr, stick.y0 * dpr, 60 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc((stick.x0 + Math.max(-60, Math.min(60, stick.dx))) * dpr, (stick.y0 + Math.max(-60, Math.min(60, stick.dy))) * dpr, 22 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Numbers and panels ────────────────────────────────────────────────

  function drawNumbers(f) {
    el.score.textContent = String(f ? f.score : 0);
    el.wave.textContent = String(f ? f.wave : 0);
    var mine = myShip(f);
    el.shields.textContent = mine ? (mine[6] ? 'Docked' : '●●●'.slice(0, mine[5]) + '○○○'.slice(0, 3 - mine[5])) : '-';
  }

  function drawOverlay() {
    var playing = view.phase === 'playing';
    var mine = myShip(newest());
    var joined = view.you && view.you.joined;
    var title = '';
    var text = '';
    var action = null;
    if (view.phase === 'lobby') {
      title = 'Ready to launch';
      text = joined ? 'Launch when your crew is in. Others can join while you fly.' : 'Join, then launch.';
    } else if (playing && (!mine || mine[6])) {
      if (mine && mine[6]) {
        title = 'Docked';
        text = 'Out of shields. Watch the others, and fly again next run.';
      } else {
        title = 'A run is on';
        text = view.you ? 'Jump in and fly with them.' : 'Make an account to fly.';
        if (view.you) action = 'Jump in';
      }
    } else if (view.phase === 'over') {
      title = 'Run over';
      text = 'Every ship is back at the dock.';
    }
    el.overlay.hidden = !title;
    el.overlayTitle.textContent = title;
    el.overlayText.textContent = text;
    el.overlayAction.hidden = !action;
    el.overlayAction.textContent = action || '';
  }

  function drawOver() {
    var done = view.phase === 'over' && view.results;
    el.over.hidden = !done;
    if (!done) return;
    var score = view.results.length ? view.results[0].score : 0;
    el.overLine.textContent = score + ' crystals';
    var best = view.leaders.length ? view.leaders[0].best : 0;
    el.overNote.textContent = 'Flown by ' + view.results.map(function (r) { return who(r.id, r.username); }).join(', ') +
      (score && score >= best ? '. The best run yet!' : '.');
  }

  function drawPlayers() {
    el.players.textContent = '';
    var f = newest();
    view.players.forEach(function (p) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-player', String(p.id));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(p.id, p.username)));
      var ship = null;
      if (f && view.phase === 'playing') f.ships.forEach(function (s) { if (s[0] === p.id) ship = s; });
      var note = ship ? (ship[6] ? 'docked' : ship[10] + (ship[10] === 1 ? ' crystal' : ' crystals')) : '';
      if (!p.here) note = note ? note + ' · away' : 'away';
      li.appendChild(h('span', 'text-small text-muted', note));
      el.players.appendChild(li);
    });
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;
    var you = view.you;
    var joined = you && you.joined;
    var lobby = view.phase === 'lobby';
    el.lobbyActions.hidden = !lobby;
    el.join.hidden = !!joined;
    el.leave.hidden = !joined;
    el.start.hidden = !joined;
    if (!you) el.lobbyNote.textContent = 'Make an account to fly.';
    else if (lobby) el.lobbyNote.textContent = joined ? 'Anyone who joined can launch.' : 'Join to fly in the next run.';
    else el.lobbyNote.textContent = '';
    el.lobbyNote.hidden = !el.lobbyNote.textContent;
  }

  function drawLeaders() {
    el.leadersSection.hidden = !view.leaders.length;
    el.leaders.textContent = '';
    view.leaders.forEach(function (l) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-leader', '');
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', '@' + l.username));
      li.appendChild(h('span', 'text-small text-muted', 'best ' + l.best + ' · ' + l.played + (l.played === 1 ? ' run' : ' runs')));
      el.leaders.appendChild(li);
    });
  }

  function render(next) {
    view = next;
    view.receivedAt = Date.now();
    el.loading.hidden = true;
    el.error.hidden = true;
    el.game.hidden = false;
    // A view carries the whole game; it is a frame too.
    if (view.game) onFrame(view.game);
    else { frames = []; me = null; drawNumbers(null); }
    drawOverlay();
    drawOver();
    drawPlayers();
    drawLeaders();
  }

  var room = window.GameRoom.connect({
    onView: render,
    onFrame: function (f) {
      onFrame(f);
      if (view) { drawOverlay(); }
    },
    onError: toast,
    onStatus: function (status) {
      el.connection.hidden = status !== 'offline';
      el.connection.textContent = 'Reconnecting…';
    },
    onHidden: function (isHidden) { hidden = isHidden; },
    onFailed: function () {
      if (view) return;
      el.loading.hidden = true;
      el.error.hidden = false;
    },
    // Without a live connection, ask often enough to see the rocks move.
    pollMs: 200,
  });

  // ── Controls ──────────────────────────────────────────────────────────

  var FLY_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'];
  window.addEventListener('keydown', function (e) {
    if (FLY_KEYS.indexOf(e.code) === -1) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!me) return;
    keys[e.code] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { keys = {}; beamHeld = false; });

  // The left half of the field steers, wherever the finger lands.
  el.field.addEventListener('pointerdown', function (e) {
    el.canvas.focus();
    if (e.pointerType === 'mouse' || !me || e.target === el.beam) return;
    var rect = el.field.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width / 2) return;
    stick = { id: e.pointerId, x0: e.clientX - rect.left, y0: e.clientY - rect.top, dx: 0, dy: 0 };
    el.field.setPointerCapture(e.pointerId);
  });
  el.field.addEventListener('pointermove', function (e) {
    if (!stick || e.pointerId !== stick.id) return;
    var rect = el.field.getBoundingClientRect();
    stick.dx = e.clientX - rect.left - stick.x0;
    stick.dy = e.clientY - rect.top - stick.y0;
  });
  function endStick(e) { if (stick && e.pointerId === stick.id) stick = null; }
  el.field.addEventListener('pointerup', endStick);
  el.field.addEventListener('pointercancel', endStick);

  el.beam.hidden = !window.matchMedia('(hover: none)').matches;
  el.beam.addEventListener('pointerdown', function (e) { e.preventDefault(); beamHeld = true; });
  el.beam.addEventListener('pointerup', function () { beamHeld = false; });
  el.beam.addEventListener('pointercancel', function () { beamHeld = false; });
  el.beam.addEventListener('pointerleave', function () { beamHeld = false; });

  el.join.addEventListener('click', function () { room.join(); });
  el.leave.addEventListener('click', function () { room.leave(); });
  el.start.addEventListener('click', function () { room.start(); el.canvas.focus(); });
  el.again.addEventListener('click', function () { room.again(); });
  el.overlayAction.addEventListener('click', function () { room.join(); el.canvas.focus(); });
  document.getElementById('retry').addEventListener('click', function () { window.location.reload(); });
  requestAnimationFrame(paint);
})();
