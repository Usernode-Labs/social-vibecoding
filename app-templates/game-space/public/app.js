// The space game's screen: the field, drawn on a canvas that fills the
// screen, with the title screen (the hangar and the best runs) over it, and
// in a run your score, the sector and your shields floating on top.
//
// The game room (public/game/room.js) sends a frame 20 times a second: the
// ships, and the storms, bursts and stardust as the few numbers they are
// made of (game/rules.js). This page works out where every spark is at any
// moment from those numbers (sparkAt), so the sparks move smoothly however
// many there are. Other ships are drawn a moment behind, between frames;
// your own ship flies on this screen as you steer it, tells the server where
// it is, and this page sees a spark touch it (and stardust reached) and
// tells the server that.
//
// Controls: arrow keys or WASD, Shift to slow down; on a touch screen (or
// with a mouse), drag anywhere and the ship follows.
//
// The field is a scene of its own, night in both looks (CLAUDE.md
// "## Design"). Rendering builds elements and sets textContent, never
// innerHTML with people's words in it.

(function () {
  function $(id) { return document.getElementById(id); }
  var el = {
    field: $('field'),
    canvas: $('field-canvas'),
    title: $('title'),
    loading: $('loading'),
    error: $('error'),
    hangarBody: $('hangar-body'),
    lobbyTitle: $('lobby-title'),
    lobbyNote: $('lobby-note'),
    players: $('players'),
    empty: $('empty'),
    join: $('join'),
    start: $('start'),
    resume: $('resume'),
    watch: $('watch'),
    leave: $('leave'),
    leadersSection: $('leaders-section'),
    leaders: $('leaders'),
    stage: $('stage'),
    toTitle: $('to-title'),
    score: $('score'),
    wave: $('wave'),
    shields: $('shields'),
    pilotScores: $('pilot-scores'),
    hint: $('hint'),
    out: $('out'),
    outNote: $('out-note'),
    over: $('over'),
    overLine: $('over-line'),
    overScore: $('over-score'),
    overNote: $('over-note'),
    standings: $('standings'),
    again: $('again'),
    overTitle: $('over-title'),
    connection: $('connection'),
    toast: $('toast'),
    toastText: $('toast-text'),
  };

  // The field's own colours, the same as public/scene.css names. Sparks by
  // the storm's colour index (game/rules.js PATTERNS), ships by seat.
  var SPARK_COLOURS = ['#ff5fa2', '#4ce0ff', '#b388ff', '#ffb547', '#9fd8ff'];
  var SHIP_COLOURS = ['#4ce0ff', '#ff7ac6', '#7dff9b', '#ffb547', '#b388ff', '#ffe27a', '#ff8a65', '#80d8ff'];
  var GOLD = '#ffe27a';
  var NEBULAE = ['#5b2a86', '#0e5a6b', '#7a1f4f'];
  var SHIP_PATH = 'M0 -22 L7 -4 L20 12 L20 16 L6 11 L3 17 L-3 17 L-6 11 L-20 16 L-20 12 L-7 -4 Z';
  var SHIELD_PATH = 'M0 -9 L8 -5 L8 2 C8 7 4 10 0 12 C-4 10 -8 7 -8 2 L-8 -5 Z';

  // Sizes in field units. The ship's hit box is a dot at its middle, the
  // way a dodging game's is: the sparks have to touch the dot.
  var SHIP_HIT = 4;
  var SPARK_HIT = { 1: 5, 2: 7 };
  var SPARK_R = { 1: 6, 2: 9 };
  var DUST_REACH = 30;
  var SPEED = 330;
  var SLOW = 140;
  var MAX_SPEED = 540; // a little under the server's limit
  var SPARK_LIFE_MS = 9000;
  var BEHIND_MS = 90; // how far behind the newest frame others are drawn
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var view = null;
  var screen = 'title';
  var leftGameNo = null;
  var watching = false;
  var gameNo = null;
  var frames = []; // the last few frames, with when they came: { at, f }
  var latest = null;
  var offset = null; // the server's clock minus this one's
  var me = null; // your ship, flown here: { x, y }
  var coverUntil = 0;
  var taken = {}; // stardust this page has seen collected
  var hitAt = {}; // when each ship was last hit, to flash it
  var keys = {};
  var drag = null;
  var pending = { x: 0, y: 0 };
  var lastSent = 0;
  var moved = false;
  var hidden = false;

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

  function isMe(id) {
    return !!(view && view.you && view.you.id === id);
  }
  function who(id, username) {
    return isMe(id) ? 'You' : '@' + username;
  }
  function points(n) {
    return Number(n || 0).toLocaleString('en-US');
  }
  function nth(n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function serverNow() {
    return Date.now() + (offset || 0);
  }
  function shipColour(seat) {
    return SHIP_COLOURS[seat % SHIP_COLOURS.length];
  }

  var NS = 'http://www.w3.org/2000/svg';
  function icon(path, viewBox, className, fill, stroke) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', fill);
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  // ── Where things are: the same arithmetic as game/rules.js ────────────

  function smooth(t) {
    var c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  function pulsarAt(s, T) {
    var t = T - s.t0;
    var y;
    if (t < s.enter) y = -60 + (s.ys + 60) * smooth(t / s.enter);
    else if (t < s.enter + s.stay) y = s.ys;
    else y = s.ys - (s.ys + 60) * smooth((t - s.enter - s.stay) / s.enter);
    return { x: s.x + s.sway * Math.sin((2 * Math.PI * t) / s.swayMs), y: y };
  }

  // A spark thrown from (x, y) at angle a and speed v, turning at w radians
  // a second, dt seconds later.
  var P = { x: 0, y: 0 };
  function sparkAt(x, y, a, v, w, dt) {
    if (Math.abs(w) < 1e-6) {
      P.x = x + Math.cos(a) * v * dt;
      P.y = y + Math.sin(a) * v * dt;
    } else {
      P.x = x + (v / w) * (Math.sin(a + w * dt) - Math.sin(a));
      P.y = y - (v / w) * (Math.cos(a + w * dt) - Math.cos(a));
    }
    return P;
  }

  // Every spark in the field at time T: fn(x, y, size, colour, comet).
  function eachSpark(f, T, fn) {
    var w = f.w;
    var hh = f.h;
    function visit(p, size, colour, comet) {
      if (p.x < -30 || p.x > w + 30 || p.y < -40 || p.y > hh + 40) return;
      fn(p.x, p.y, size, colour, comet);
    }
    f.storms.forEach(function (s) {
      if (!s.n) return;
      var first = s.t0 + s.enter;
      var end = first + s.stay;
      var kFrom = Math.max(0, Math.ceil((T - SPARK_LIFE_MS - first) / s.interval));
      var kTo = Math.floor((Math.min(T, end - 1) - first) / s.interval);
      for (var k = kFrom; k <= kTo; k++) {
        var te = first + k * s.interval;
        var o = pulsarAt(s, te);
        var dt = (T - te) / 1000;
        var turn = s.curve * (s.alt && k % 2 ? -1 : 1);
        var base = s.a0 + k * s.rot;
        for (var j = 0; j < s.n; j++) visit(sparkAt(o.x, o.y, base + j * s.spread, s.v, turn, dt), s.size, s.colour, false);
      }
    });
    // [id, t, x, y, n, dx, a, spread, v, size, colour, gap]
    f.bursts.forEach(function (b) {
      var dt = (T - b[1]) / 1000;
      if (dt < 0) return;
      for (var j = 0; j < b[4]; j++) {
        if (j === b[11] || j === b[11] + 1) continue;
        visit(sparkAt(b[2] + j * b[5], b[3], b[6] + j * b[7], b[8], 0, dt), b[9], b[10], b[5] > 0);
      }
    });
  }

  // ── Frames ────────────────────────────────────────────────────────────

  function addFrame(f) {
    if (!f || !f.ships) return;
    var sample = f.now - Date.now();
    offset = offset == null ? sample : Math.max(sample, offset - 4);
    frames.push({ at: performance.now(), f: f });
    if (frames.length > 10) frames.shift();
    latest = f;
    syncMe();
  }

  function myShip(f) {
    if (!f || !view || !view.you) return null;
    for (var i = 0; i < f.ships.length; i++) if (f.ships[i][0] === view.you.id) return f.ships[i];
    return null;
  }

  // Your ship appears where the server put it, and is flown here after.
  function syncMe() {
    var s = myShip(latest);
    if (!s || s[4] || (view && view.phase !== 'playing')) {
      me = null;
      return;
    }
    if (!me) {
      me = { x: s[1], y: s[2] };
      pending.x = 0;
      pending.y = 0;
    }
    coverUntil = Math.max(coverUntil, s[5]);
  }

  // Other ships, a moment behind and smoothly between two frames.
  function othersNow() {
    var at = performance.now() - BEHIND_MS;
    var a = null;
    var b = null;
    for (var i = frames.length - 1; i >= 0; i--) {
      if (frames[i].at <= at) {
        a = frames[i];
        b = frames[i + 1] || null;
        break;
      }
    }
    if (!a) return latest ? latest.ships : [];
    if (!b) return a.f.ships;
    var k = Math.max(0, Math.min(1, (at - a.at) / Math.max(1, b.at - a.at)));
    var before = {};
    a.f.ships.forEach(function (s) { before[s[0]] = s; });
    return b.f.ships.map(function (s) {
      var p = before[s[0]];
      if (!p) return s;
      var c = s.slice();
      c[1] = p[1] + (s[1] - p[1]) * k;
      c[2] = p[2] + (s[2] - p[2]) * k;
      return c;
    });
  }

  // ── The canvas ────────────────────────────────────────────────────────

  var ctx = el.canvas.getContext('2d');
  var cw = 0;
  var ch = 0;
  var dpr = 1;
  var scale = 1;
  var ox = 0;
  var oy = 0;
  var sprites = {};
  var shipPath = new Path2D(SHIP_PATH);
  var stars = [];
  [[70, 0.9, 0.45, 10], [40, 1.4, 0.7, 26], [16, 2.1, 1, 60]].forEach(function (layer, li) {
    for (var i = 0; i < layer[0]; i++) stars.push({ x: Math.random(), y: Math.random(), r: layer[1], a: layer[2], v: layer[3], layer: li });
  });
  var nebulae = NEBULAE.map(function (c, i) {
    return { x: [0.2, 0.8, 0.5][i], y: [0.25, 0.55, 0.9][i], r: [0.55, 0.5, 0.45][i], c: c };
  });
  var scroll = 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = el.canvas.clientWidth;
    ch = el.canvas.clientHeight;
    el.canvas.width = Math.round(cw * dpr);
    el.canvas.height = Math.round(ch * dpr);
    sprites = {};
  }

  function layout(f) {
    var w = f ? f.w : 600;
    var hh = f ? f.h : 1000;
    scale = Math.min(cw / w, ch / hh);
    ox = (cw - w * scale) / 2;
    oy = (ch - hh * scale) / 2;
  }

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // A glowing dot, drawn once per colour and size and stamped after.
  function sprite(colour, r) {
    var px = Math.max(4, Math.round(r * scale * dpr));
    var key = colour + px;
    if (sprites[key]) return sprites[key];
    var size = px * 6;
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var g = c.getContext('2d');
    var m = size / 2;
    var grad = g.createRadialGradient(m, m, 0, m, m, m);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.14, '#ffffff');
    grad.addColorStop(0.24, colour);
    grad.addColorStop(0.45, rgba(colour, 0.35));
    grad.addColorStop(1, rgba(colour, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    sprites[key] = c;
    return c;
  }

  function stamp(img, x, y, r) {
    ctx.drawImage(img, x - r * 3, y - r * 3, r * 6, r * 6);
  }

  function drawSky(dt, running) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!(REDUCED && !running)) scroll += dt * (running ? 1 : 0.35);
    nebulae.forEach(function (n, i) {
      var y = ((n.y * ch + scroll * (4 + i * 2)) % (ch * 1.4)) - ch * 0.2;
      var r = n.r * Math.max(cw, ch);
      var g = ctx.createRadialGradient(n.x * cw, y, 0, n.x * cw, y, r);
      g.addColorStop(0, rgba(n.c, 0.16));
      g.addColorStop(1, rgba(n.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    });
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var y = (s.y * ch + scroll * s.v * (running ? 2.2 : 1)) % ch;
      ctx.fillStyle = 'rgba(232,236,255,' + s.a + ')';
      if (running && s.layer === 2) ctx.fillRect(s.x * cw - 0.6, y - 10, 1.2, 12);
      else ctx.fillRect(s.x * cw - s.r / 2, y - s.r / 2, s.r, s.r);
    }
  }

  function drawEdges(f) {
    if (ox < 6) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(5,8,23,0.35)';
    ctx.fillRect(0, 0, ox, ch);
    ctx.fillRect(cw - ox, 0, ox, ch);
    ctx.fillStyle = 'rgba(76,224,255,0.25)';
    ctx.fillRect(ox - 1, 0, 1, ch);
    ctx.fillRect(cw - ox, 0, 1, ch);
  }

  function drawPulsar(s, T) {
    if (T > s.t0 + s.enter * 2 + s.stay) return;
    var p = pulsarAt(s, T);
    var colour = SPARK_COLOURS[s.colour % SPARK_COLOURS.length];
    ctx.globalCompositeOperation = 'lighter';
    stamp(sprite(colour, 9), p.x, p.y, 9);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((T / 1400) % (Math.PI * 2));
    ctx.fillStyle = rgba(colour, 0.55);
    for (var i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(0, -34);
      ctx.lineTo(3, 0);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawShip(x, y, seat, alpha, mine) {
    var colour = shipColour(seat);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    // The engine's flame.
    ctx.globalCompositeOperation = 'lighter';
    var flame = 24 + Math.random() * 8;
    var g = ctx.createLinearGradient(0, 14, 0, flame);
    g.addColorStop(0, 'rgba(255,226,122,0.95)');
    g.addColorStop(1, 'rgba(255,95,162,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-5, 14);
    ctx.lineTo(5, 14);
    ctx.lineTo(0, flame);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = colour;
    ctx.shadowBlur = 14;
    var body = ctx.createLinearGradient(0, -22, 0, 17);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.35, colour);
    body.addColorStop(1, rgba(colour, 0.75));
    ctx.fillStyle = body;
    ctx.fill(shipPath);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke(shipPath);
    ctx.fillStyle = '#0c0f2e';
    ctx.beginPath();
    ctx.ellipse(0, -5, 3, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    if (mine) {
      // Your hit box: the dot the sparks have to miss.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 2, SHIP_HIT, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(colour, 0.9);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawName(x, y, name) {
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,236,255,0.75)';
    ctx.fillText(name, x, y + 40);
  }

  function covered(until, T) {
    return T < until ? 0.35 + 0.55 * (Math.floor(T / 110) % 2) : 1;
  }

  function hit(T) {
    coverUntil = T + 2000;
    room.act({ type: 'hit' });
    el.stage.classList.remove('flash');
    void el.stage.offsetWidth;
    el.stage.classList.add('flash');
  }

  function draw(dt) {
    var f = latest;
    var running = !!(f && view && view.phase !== 'lobby' && !f.over);
    drawSky(dt, running && screen === 'stage');
    if (!f || !view || view.phase === 'lobby') return;
    layout(f);
    drawEdges(f);
    var T = serverNow();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    f.storms.forEach(function (s) { drawPulsar(s, T); });

    // Stardust: gold sparkles, collected by flying through them.
    f.dust.forEach(function (d) {
      if (taken[d[0]]) return;
      var x = d[1];
      var y = d[2] + (d[4] * (T - d[3])) / 1000;
      if (y > f.h + 30) return;
      if (me && screen === 'stage' && Math.hypot(me.x - x, me.y - y) < DUST_REACH) {
        taken[d[0]] = true;
        room.act({ type: 'collect', id: d[0] });
        return;
      }
      ctx.globalCompositeOperation = 'lighter';
      stamp(sprite(GOLD, 5), x, y, 5);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(T / 600);
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      for (var i = 0; i < 8; i++) {
        var r = i % 2 ? 3 : 11;
        var a = (i * Math.PI) / 4;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.fill();
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    });

    // The sparks, and whether one touches your ship.
    var canHit = !!me && screen === 'stage' && T >= coverUntil && view.phase === 'playing';
    var struck = false;
    ctx.globalCompositeOperation = 'lighter';
    eachSpark(f, T, function (x, y, size, colour, comet) {
      var c = SPARK_COLOURS[colour % SPARK_COLOURS.length];
      var r = SPARK_R[size] || 6;
      if (comet) {
        var g = ctx.createLinearGradient(x, y - 40, x, y);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(1, rgba(c, 0.55));
        ctx.fillStyle = g;
        ctx.fillRect(x - r * 0.6, y - 40, r * 1.2, 40);
      }
      stamp(sprite(c, r), x, y, r);
      if (canHit && !struck && Math.hypot(me.x - x, me.y - (y - 2)) < (SPARK_HIT[size] || 5) + SHIP_HIT) struck = true;
    });
    ctx.globalCompositeOperation = 'source-over';
    if (struck) hit(T);

    // The ships: the others a moment behind, yours where you are.
    othersNow().forEach(function (s) {
      if (s[4] || isMe(s[0])) return;
      var flash = hitAt[s[0]] && performance.now() - hitAt[s[0]] < 300;
      drawShip(s[1], s[2], s[6], flash ? 0.4 : covered(s[5], T), false);
      drawName(s[1], s[2], '@' + s[7]);
    });
    var mine = myShip(f);
    if (me && mine) drawShip(me.x, me.y, mine[6], covered(coverUntil, T), true);
  }

  // ── Flying your ship ──────────────────────────────────────────────────

  function steer(dt) {
    if (!me || screen !== 'stage') return;
    var dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    var len = Math.hypot(dx, dy);
    var before = me.x + ',' + me.y;
    if (len) {
      var speed = keys.slow ? SLOW : SPEED;
      me.x += (dx / len) * speed * dt;
      me.y += (dy / len) * speed * dt;
    }
    // A drag moves the ship as far as the finger went, as fast as it may.
    var plen = Math.hypot(pending.x, pending.y);
    if (plen > 0.01) {
      var cap = MAX_SPEED * dt;
      var k = plen > cap ? cap / plen : 1;
      me.x += pending.x * k;
      me.y += pending.y * k;
      pending.x -= pending.x * k;
      pending.y -= pending.y * k;
    }
    var f = latest;
    me.x = Math.max(0, Math.min(f ? f.w : 600, me.x));
    me.y = Math.max(0, Math.min(f ? f.h : 1000, me.y));
    var now = performance.now();
    if (before !== me.x + ',' + me.y) {
      if (!moved) {
        moved = true;
        el.hint.hidden = true;
      }
      room.input({ x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10 });
      lastSent = now;
    } else if (now - lastSent > 1000) {
      // Still here, even holding still.
      room.input({ x: me.x, y: me.y });
      lastSent = now;
    }
  }

  var KEYS = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ShiftLeft: 'slow', ShiftRight: 'slow' };
  window.addEventListener('keydown', function (e) {
    var k = KEYS[e.code];
    if (!k || screen !== 'stage') return;
    keys[k] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYS[e.code];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', function () { keys = {}; drag = null; });

  el.field.addEventListener('pointerdown', function (e) {
    if (screen !== 'stage' || !me) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    el.field.setPointerCapture(e.pointerId);
  });
  el.field.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    pending.x += (e.clientX - drag.x) / scale;
    pending.y += (e.clientY - drag.y) / scale;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  function endDrag(e) {
    if (drag && e.pointerId === drag.id) drag = null;
  }
  el.field.addEventListener('pointerup', endDrag);
  el.field.addEventListener('pointercancel', endDrag);

  var lastT = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    if (hidden) return;
    steer(dt);
    draw(dt);
    drawHud();
  }

  // ── The HUD over a run ────────────────────────────────────────────────

  var hudKey = '';
  var hintTimer = null;
  function drawHud() {
    if (screen !== 'stage' || !latest) return;
    var f = latest;
    var mine = myShip(f);
    var key = [f.sector, mine ? mine[3] + ':' + mine[4] + ':' + mine[8] : '', f.ships.map(function (s) { return s[8] + s[4]; }).join()].join('|');
    if (key === hudKey) return;
    hudKey = key;
    el.score.textContent = points(mine ? mine[8] : 0);
    el.wave.textContent = 'Sector ' + f.sector;
    el.shields.textContent = '';
    var shields = mine ? mine[3] : 0;
    for (var i = 0; i < 3; i++) {
      el.shields.appendChild(icon(SHIELD_PATH, '-10 -11 20 24', 'shield', i < shields ? '#4ce0ff' : 'none', i < shields ? '#4ce0ff' : 'rgba(232,236,255,0.4)'));
    }
    el.shields.setAttribute('aria-label', shields + (shields === 1 ? ' shield' : ' shields') + ' left');
    el.shields.hidden = !mine;
    el.pilotScores.textContent = '';
    f.ships.filter(function (s) { return !isMe(s[0]); })
      .sort(function (a, b) { return b[8] - a[8]; })
      .slice(0, 5)
      .forEach(function (s) {
        el.pilotScores.appendChild(h('li', s[4] ? 'opacity-50' : '', '@' + s[7] + ' ' + points(s[8])));
      });
    var out = !!(mine && mine[4]) && view.phase === 'playing';
    el.out.hidden = !out;
    if (out) el.outNote.textContent = points(mine[8]) + ' points. The others fly on; your score is in when the run ends.';
  }

  function drawOver() {
    var done = view.phase === 'over' && view.results;
    el.over.hidden = !done;
    if (!done) return;
    var mine = view.results.filter(function (r) { return isMe(r.id); })[0];
    el.overLine.textContent = mine ? 'Run over' : 'The run is over';
    el.overScore.textContent = points(mine ? mine.score : view.results[0].score);
    el.overNote.textContent = mine
      ? (view.results.length > 1 ? 'You came ' + nth(mine.place) + ' of ' + view.results.length + '.' : 'Your score for this run.')
      : '@' + view.results[0].username + ' flew furthest.';
    el.standings.textContent = '';
    view.results.forEach(function (r) {
      var li = h('li', 'rank');
      li.appendChild(h('span', 'rank-place', String(r.place)));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate font-bold', who(r.id, r.username)));
      li.appendChild(h('span', 'rank-score', points(r.score)));
      el.standings.appendChild(li);
    });
    el.out.hidden = true;
    el.hint.hidden = true;
  }

  // ── The title screen ──────────────────────────────────────────────────

  function drawHangar() {
    var you = view.you;
    var joined = !!(you && you.joined);
    var phase = view.phase;
    var ships = {};
    (latest && phase !== 'lobby' ? latest.ships : []).forEach(function (s) { ships[s[0]] = s; });
    el.players.textContent = '';
    view.players.forEach(function (p, seat) {
      var s = ships[p.id];
      var li = h('li', p.here ? 'pilot' : 'pilot pilot-away');
      li.setAttribute('data-player', String(p.id));
      li.appendChild(icon(SHIP_PATH, '-24 -26 48 48', 'pilot-ship', shipColour(s ? s[6] : seat), 'rgba(255,255,255,0.8)'));
      li.appendChild(h('span', 'pilot-name', who(p.id, p.username)));
      var note = !p.here ? 'away' : s ? (s[4] ? 'out, ' : 'flying, ') + points(s[8]) : 'ready';
      li.appendChild(h('span', 'pilot-note', note));
      el.players.appendChild(li);
    });
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;

    var lobby = phase === 'lobby';
    var on = phase === 'playing';
    var mine = myShip(latest);
    var flying = on && joined && mine && !mine[4];
    el.lobbyTitle.textContent = lobby ? 'In the hangar' : on ? 'A run is on' : 'The last run is over';
    el.join.hidden = !(lobby || on) || joined;
    el.join.textContent = on ? 'Join the run' : 'Join';
    el.start.hidden = !lobby || !joined;
    el.start.disabled = view.players.length < view.rules.minPlayers;
    el.resume.hidden = !flying;
    el.watch.hidden = !(on || phase === 'over') || flying;
    el.watch.textContent = on ? 'Watch the run' : 'See the results';
    el.leave.hidden = !joined || phase === 'over';
    var note = '';
    if (!you) note = 'Make an account to fly. You can watch any run.';
    else if (lobby) note = joined ? 'Launch on your own, or wait for the others to join.' : 'Join, and launch a run.';
    else if (on) note = flying ? 'Your ship is still out there. Get back to it before it drifts away.' : joined ? 'Your ship is out of this run.' : 'Join in: you start at the bottom of the field.';
    else if (view.results) note = '@' + view.results[0].username + ' flew furthest, with ' + points(view.results[0].score) + ' points.';
    el.lobbyNote.textContent = note;
    el.lobbyNote.hidden = !note;
  }

  function drawLeaders() {
    el.leadersSection.hidden = !view.leaders.length;
    el.leaders.textContent = '';
    view.leaders.forEach(function (l, i) {
      var li = h('li', 'rank');
      li.setAttribute('data-leader', '');
      li.appendChild(h('span', 'rank-place', String(i + 1)));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate font-bold', '@' + l.username));
      li.appendChild(h('span', 'rank-score', points(l.best)));
      el.leaders.appendChild(li);
    });
  }

  // ── Which screen ──────────────────────────────────────────────────────

  function show(next) {
    screen = next;
    el.title.hidden = screen !== 'title';
    el.stage.hidden = screen !== 'stage';
    hudKey = '';
    if (screen === 'stage' && !moved) {
      el.hint.textContent = window.matchMedia('(pointer: coarse)').matches
        ? 'Drag anywhere: your ship follows your finger.'
        : 'Arrow keys or WASD to fly. Hold Shift to slow down.';
      el.hint.hidden = !me;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () { el.hint.hidden = true; }, 6000);
    }
  }

  function chooseScreen() {
    var joined = !!(view.you && view.you.joined);
    if (view.phase === 'lobby') {
      watching = false;
      show('title');
    } else if (view.phase === 'playing' && joined && leftGameNo !== view.gameNo) {
      var mine = myShip(latest);
      if (!mine || !mine[4] || screen === 'stage') show('stage');
    }
  }

  function render(next) {
    view = next;
    el.loading.hidden = true;
    el.error.hidden = true;
    el.hangarBody.hidden = false;
    if (view.gameNo !== gameNo) {
      gameNo = view.gameNo;
      frames = [];
      latest = null;
      me = null;
      taken = {};
      coverUntil = 0;
      moved = false;
    }
    // Without a live connection, the view carries the frame.
    if (view.game) addFrame(view.game);
    else syncMe();
    chooseScreen();
    drawOver();
    drawHangar();
    drawLeaders();
  }

  var room = window.GameRoom.connect({
    onView: render,
    onFrame: function (f) {
      if (!view || view.phase === 'lobby') return;
      addFrame(f);
    },
    onEvent: function (e) {
      if (e.type === 'dust') taken[e.id] = true;
      if (e.type === 'hit') hitAt[e.id] = performance.now();
    },
    onError: toast,
    onHidden: function (away) {
      hidden = away;
      if (away) { keys = {}; drag = null; }
    },
    onStatus: function (status) {
      el.connection.hidden = status !== 'offline';
      el.connection.textContent = 'Reconnecting…';
    },
    onFailed: function () {
      if (view) return;
      el.loading.hidden = true;
      el.error.hidden = false;
    },
  });

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(loop);

  el.join.addEventListener('click', function () { leftGameNo = null; room.join(); });
  el.start.addEventListener('click', function () { leftGameNo = null; room.start(); });
  el.leave.addEventListener('click', function () { room.leave(); show('title'); });
  el.resume.addEventListener('click', function () { leftGameNo = null; show('stage'); });
  el.watch.addEventListener('click', function () { watching = true; show('stage'); drawOver(); });
  el.toTitle.addEventListener('click', function () {
    if (view && view.phase === 'playing') leftGameNo = view.gameNo;
    keys = {};
    drag = null;
    show('title');
  });
  el.again.addEventListener('click', function () {
    leftGameNo = null;
    Promise.resolve(room.again()).then(function () { return room.start(); });
  });
  el.overTitle.addEventListener('click', function () { show('title'); });
  $('retry').addEventListener('click', function () { window.location.reload(); });
})();
