// Gem garden: a small 3D game drawn with plain WebGL. Roll the ball with the
// arrow keys, WASD, or by dragging on the garden, and collect as many gems
// as you can in 45 seconds. The score goes to the leaderboard (api.js).
//
// No 3D library: the renderer below is one shader (a light, an ambient
// term, and a checkerboard for the lawn), four meshes and a camera, which is
// all this game needs. If it outgrows that, three.js is the usual next step;
// serve its file from this repository rather than from a CDN.
//
// The shape of it, for whoever changes it next:
//   - math: column-major 4x4 matrices in Float32Arrays (mat4 helpers);
//   - meshes: interleaved position + normal buffers (makeMesh);
//   - update(dt): physics and rules, by the time since the last frame;
//   - draw(): the camera follows the ball, then every object is drawn.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var canvas = document.querySelector('#game canvas');
  var scoreEl = document.getElementById('score');
  var timeEl = document.getElementById('hud-right');
  var overlay = document.getElementById('overlay');
  var overlayTitle = document.getElementById('overlay-title');
  var overlayText = document.getElementById('overlay-text');
  var startBtn = document.getElementById('start-btn');

  var HALF = 8;           // the garden runs from -HALF to HALF on x and z
  var BALL_R = 0.5;
  var GEMS = 6;           // gems on the lawn at once
  var ROUND_SECONDS = 45;
  var ACCEL = 18;
  var FRICTION = 2.2;

  // ── Leaderboard (kept first: it works even where WebGL does not) ────

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
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

  api('GET', '/api/leaderboard').then(renderBoard).catch(function (err) {
    document.getElementById('leaderboard').textContent = err.message;
  });

  // ── WebGL setup ─────────────────────────────────────────────────────

  var gl = canvas.getContext('webgl', { antialias: true });
  if (!gl) {
    // Not an error in this app: some browsers and locked-down devices have
    // no WebGL. Say so and leave the leaderboard working.
    overlayTitle.textContent = 'No 3D here';
    overlayText.textContent = 'This browser cannot draw 3D graphics, so the game cannot start on this device.';
    startBtn.classList.add('hidden');
    canvas.setAttribute('data-ready', 'no-webgl');
    return;
  }

  var VERT = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'uniform mat4 uViewProj;',
    'uniform mat4 uModel;',
    'uniform mat3 uNormalMat;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec4 world = uModel * vec4(aPos, 1.0);',
    '  vWorld = world.xyz;',
    '  vNormal = uNormalMat * aNormal;',
    '  gl_Position = uViewProj * world;',
    '}',
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec3 uColor;',
    'uniform vec3 uColor2;',
    'uniform float uChecker;',
    'uniform float uGlow;',
    'uniform vec3 uLightDir;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec3 base = uColor;',
    '  if (uChecker > 0.5) {',
    '    float c = mod(floor(vWorld.x) + floor(vWorld.z), 2.0);',
    '    base = mix(uColor, uColor2, c);',
    '  }',
    '  float light = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);',
    '  vec3 color = base * (0.35 + 0.65 * light) + base * uGlow;',
    '  gl_FragColor = vec4(color, 1.0);',
    '}',
  ].join('\n');

  function compile(type, src) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  var program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  var loc = {
    aPos: gl.getAttribLocation(program, 'aPos'),
    aNormal: gl.getAttribLocation(program, 'aNormal'),
    uViewProj: gl.getUniformLocation(program, 'uViewProj'),
    uModel: gl.getUniformLocation(program, 'uModel'),
    uNormalMat: gl.getUniformLocation(program, 'uNormalMat'),
    uColor: gl.getUniformLocation(program, 'uColor'),
    uColor2: gl.getUniformLocation(program, 'uColor2'),
    uChecker: gl.getUniformLocation(program, 'uChecker'),
    uGlow: gl.getUniformLocation(program, 'uGlow'),
    uLightDir: gl.getUniformLocation(program, 'uLightDir'),
  };
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);

  // ── Math: column-major 4x4 matrices ─────────────────────────────────

  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }

  function lookAt(eye, target, up) {
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz); xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ]);
  }

  function multiply(a, b) {
    var out = new Float32Array(16);
    for (var col = 0; col < 4; col++) {
      for (var row = 0; row < 4; row++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  /** translate(x, y, z) * rotateY(angle) * scale(sx, sy, sz), and its normal matrix. */
  function place(x, y, z, angle, sx, sy, sz) {
    var c = Math.cos(angle), s = Math.sin(angle);
    var model = new Float32Array([
      c * sx, 0, -s * sx, 0,
      0, sy, 0, 0,
      s * sz, 0, c * sz, 0,
      x, y, z, 1,
    ]);
    // Normals take the rotation and the INVERSE scale.
    var normal = new Float32Array([
      c / sx, 0, -s / sx,
      0, 1 / sy, 0,
      s / sz, 0, c / sz,
    ]);
    return { model: model, normal: normal };
  }

  // ── Meshes: interleaved position (3) + normal (3) ───────────────────

  function makeMesh(data) {
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return { buffer: buffer, count: data.length / 6 };
  }

  // Flat-shaded triangles from a list of corner triples (counter-clockwise
  // seen from outside).
  function flat(tris) {
    var out = [];
    tris.forEach(function (t) {
      var a = t[0], b = t[1], c = t[2];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.hypot(nx, ny, nz);
      [a, b, c].forEach(function (p) { out.push(p[0], p[1], p[2], nx / l, ny / l, nz / l); });
    });
    return out;
  }

  // A unit cube from -0.5 to 0.5.
  var cube = (function () {
    var p = [
      [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
    ];
    var faces = [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [7, 6, 2, 3], [0, 1, 5, 4]];
    var tris = [];
    faces.forEach(function (f) {
      tris.push([p[f[0]], p[f[1]], p[f[2]]], [p[f[0]], p[f[2]], p[f[3]]]);
    });
    return makeMesh(flat(tris));
  })();

  // A gem: an octahedron, stretched a little upward by its placement.
  var gem = (function () {
    var top = [0, 1, 0], bottom = [0, -1, 0];
    var ring = [[1, 0, 0], [0, 0, -1], [-1, 0, 0], [0, 0, 1]];
    var tris = [];
    for (var i = 0; i < 4; i++) {
      var a = ring[i], b = ring[(i + 1) % 4];
      tris.push([top, b, a], [bottom, a, b]);
    }
    return makeMesh(flat(tris));
  })();

  // The ball: a unit sphere with smooth normals.
  var sphere = (function () {
    var rows = 12, cols = 18, out = [];
    function pt(r, c) {
      var theta = (r / rows) * Math.PI, phi = (c / cols) * Math.PI * 2;
      return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi)];
    }
    function push(p) { out.push(p[0], p[1], p[2], p[0], p[1], p[2]); }
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var a = pt(r, c), b = pt(r + 1, c), d = pt(r, c + 1), e = pt(r + 1, c + 1);
        push(a); push(b); push(e);
        push(a); push(e); push(d);
      }
    }
    return makeMesh(out);
  })();

  // The lawn: one quad facing up.
  var lawn = makeMesh(flat([
    [[-HALF, 0, HALF], [HALF, 0, HALF], [HALF, 0, -HALF]],
    [[-HALF, 0, HALF], [HALF, 0, -HALF], [-HALF, 0, -HALF]],
  ]));

  function drawMesh(mesh, placed, color, opts) {
    opts = opts || {};
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(loc.uModel, false, placed.model);
    gl.uniformMatrix3fv(loc.uNormalMat, false, placed.normal);
    gl.uniform3fv(loc.uColor, color);
    gl.uniform3fv(loc.uColor2, opts.color2 || color);
    gl.uniform1f(loc.uChecker, opts.checker ? 1 : 0);
    gl.uniform1f(loc.uGlow, opts.glow || 0);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  // ── State and rules ─────────────────────────────────────────────────

  var state = {
    playing: false,
    score: 0,
    timeLeft: ROUND_SECONDS,
    ball: { x: 0, z: 0, vx: 0, vz: 0, spin: 0 },
    gems: [],
    clock: 0,
  };
  var keys = {};
  var drag = null; // { x0, y0, dx, dy } while a finger or mouse is down

  function randomSpot() {
    // Away from the walls, and not right on top of the ball.
    for (var tries = 0; tries < 20; tries++) {
      var x = (Math.random() * 2 - 1) * (HALF - 1.5);
      var z = (Math.random() * 2 - 1) * (HALF - 1.5);
      if (Math.hypot(x - state.ball.x, z - state.ball.z) > 3) return { x: x, z: z };
    }
    return { x: 0, z: -HALF / 2 };
  }

  function resetGems() {
    state.gems = [];
    for (var i = 0; i < GEMS; i++) {
      var spot = randomSpot();
      state.gems.push({ x: spot.x, z: spot.z, phase: Math.random() * 6 });
    }
  }
  resetGems();

  function hud() {
    scoreEl.textContent = 'Gems ' + state.score;
    timeEl.textContent = Math.ceil(state.timeLeft) + 's';
  }

  function start() {
    state.playing = true;
    state.score = 0;
    state.timeLeft = ROUND_SECONDS;
    state.ball = { x: 0, z: 0, vx: 0, vz: 0, spin: 0 };
    resetGems();
    overlay.classList.add('hidden');
    hud();
  }

  function end() {
    state.playing = false;
    overlayTitle.textContent = 'Time! ' + state.score + (state.score === 1 ? ' gem' : ' gems');
    overlayText.textContent = 'Saving your score…';
    startBtn.textContent = 'Play again';
    overlay.classList.remove('hidden');
    api('POST', '/api/scores', { score: state.score })
      .then(function (data) { renderBoard(data); overlayText.textContent = 'Saved. Can you beat it?'; })
      .catch(function (err) { overlayText.textContent = err.message; });
  }

  function update(dt) {
    var shown = Math.ceil(state.timeLeft);
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) { state.timeLeft = 0; hud(); end(); return; }
    if (Math.ceil(state.timeLeft) !== shown) hud();

    // Input: keys, or a drag measured from where it started. The camera
    // looks toward -z, so "up" on screen is -z in the garden.
    var ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var iz = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (drag) {
      var len = Math.hypot(drag.dx, drag.dy);
      if (len > 6) { ix = drag.dx / Math.max(len, 60); iz = drag.dy / Math.max(len, 60); }
    }
    var b = state.ball;
    b.vx += ix * ACCEL * dt;
    b.vz += iz * ACCEL * dt;
    b.vx -= b.vx * FRICTION * dt;
    b.vz -= b.vz * FRICTION * dt;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    var edge = HALF - BALL_R - 0.25;
    if (b.x > edge || b.x < -edge) { b.x = Math.max(-edge, Math.min(edge, b.x)); b.vx *= -0.6; }
    if (b.z > edge || b.z < -edge) { b.z = Math.max(-edge, Math.min(edge, b.z)); b.vz *= -0.6; }
    b.spin += Math.hypot(b.vx, b.vz) * dt / BALL_R;

    state.gems.forEach(function (g) {
      if (Math.hypot(g.x - b.x, g.z - b.z) < BALL_R + 0.45) {
        state.score += 1;
        var spot = randomSpot();
        g.x = spot.x; g.z = spot.z;
        hud();
      }
    });
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);

  var LAWN_A = [0.42, 0.68, 0.32];
  var LAWN_B = [0.36, 0.6, 0.27];
  var HEDGE = [0.13, 0.4, 0.2];
  var BALL = [0.96, 0.45, 0.4];
  var GEM = [0.35, 0.8, 0.95];

  function draw() {
    gl.clearColor(0.6, 0.8, 0.95, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var b = state.ball;
    // The camera looks down on the garden from behind, following the ball
    // part of the way so most of the lawn stays in view.
    var target = [b.x * 0.6, 0, b.z * 0.6 - 0.5];
    var eye = [target[0], 13, target[2] + 8];
    var viewProj = multiply(
      perspective(Math.PI / 3.6, canvas.width / canvas.height, 0.1, 100),
      lookAt(eye, target, [0, 1, 0])
    );
    gl.uniformMatrix4fv(loc.uViewProj, false, viewProj);
    gl.uniform3fv(loc.uLightDir, [0.4, 1, 0.5]);

    drawMesh(lawn, place(0, 0, 0, 0, 1, 1, 1), LAWN_A, { checker: true, color2: LAWN_B });
    // Four hedges around the edge.
    drawMesh(cube, place(0, 0.4, -HALF, 0, HALF * 2 + 0.6, 0.8, 0.6), HEDGE);
    drawMesh(cube, place(0, 0.4, HALF, 0, HALF * 2 + 0.6, 0.8, 0.6), HEDGE);
    drawMesh(cube, place(-HALF, 0.4, 0, 0, 0.6, 0.8, HALF * 2 - 0.6), HEDGE);
    drawMesh(cube, place(HALF, 0.4, 0, 0, 0.6, 0.8, HALF * 2 - 0.6), HEDGE);

    state.gems.forEach(function (g) {
      var bob = Math.sin(state.clock * 2 + g.phase) * 0.15;
      drawMesh(gem, place(g.x, 0.75 + bob, g.z, state.clock * 1.5 + g.phase, 0.32, 0.45, 0.32), GEM, { glow: 0.35 });
    });

    drawMesh(sphere, place(b.x, BALL_R, b.z, b.spin, BALL_R, BALL_R, BALL_R), BALL);
  }

  // ── Input ───────────────────────────────────────────────────────────

  var KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
  };
  window.addEventListener('keydown', function (e) {
    if (!KEYMAP[e.key]) return;
    keys[KEYMAP[e.key]] = true;
    if (state.playing) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { if (KEYMAP[e.key]) keys[KEYMAP[e.key]] = false; });

  canvas.addEventListener('pointerdown', function (e) {
    drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (drag) { drag.dx = e.clientX - drag.x0; drag.dy = e.clientY - drag.y0; }
  });
  canvas.addEventListener('pointerup', function () { drag = null; });
  canvas.addEventListener('pointercancel', function () { drag = null; });

  startBtn.addEventListener('click', start);

  // ── The loop ────────────────────────────────────────────────────────

  var last = 0;
  function frame(now) {
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    state.clock += dt;
    if (state.playing && !document.hidden) update(dt);
    draw();
    if (!canvas.hasAttribute('data-ready')) canvas.setAttribute('data-ready', 'true');
    requestAnimationFrame(frame);
  }

  resize();
  hud();
  requestAnimationFrame(frame);
})();
