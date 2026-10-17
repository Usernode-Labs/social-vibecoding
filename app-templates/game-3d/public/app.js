/* Gem garden: roll a ball around a garden and collect gems in 45 seconds.
 * Drawn with the browser's own WebGL; no 3D library. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var headers = token ? { 'x-usernode-token': token } : {};
  var canvas = document.getElementById('game3d-canvas');
  var scoreEl = document.getElementById('game3d-score');
  var timeEl = document.getElementById('game3d-time');
  var overlay = document.getElementById('game3d-overlay');
  var overlayTitle = document.getElementById('game3d-overlay-title');
  var overlayNote = document.getElementById('game3d-overlay-note');
  var startButton = document.getElementById('game3d-start');
  var errorEl = document.getElementById('game3d-error');
  var listEl = document.getElementById('leaderboard-list');
  var emptyEl = document.getElementById('leaderboard-empty');
  var bestEl = document.getElementById('your-best');

  var gl = canvas.getContext('webgl', { antialias: true });
  if (!gl) {
    overlayTitle.textContent = 'This browser cannot draw the garden';
    overlayNote.textContent = 'WebGL is turned off. The garden needs it to draw the 3D scene.';
    startButton.classList.add('hidden');
    loadBoard();
    return;
  }

  var ROUND_SECONDS = 45;
  var ball = { x: 0, z: 0, r: 0.45 };
  var gems = [];
  var score = 0;
  var secondsLeft = ROUND_SECONDS;
  var playing = false;
  var reported = false;
  var last = 0;
  var keys = {};
  var drag = null;

  var vertSrc = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'varying vec3 vNormal;',
    'void main() {',
    '  vNormal = mat3(uModel) * aNormal;',
    '  gl_Position = uMvp * vec4(aPos, 1.0);',
    '}',
  ].join('\n');
  var fragSrc = [
    'precision mediump float;',
    'varying vec3 vNormal;',
    'uniform vec3 uColor;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(0.4, 1.0, 0.3))), 0.0);',
    '  gl_FragColor = vec4(uColor * light, 1.0);',
    '}',
  ].join('\n');

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  gl.useProgram(program);
  var aPos = gl.getAttribLocation(program, 'aPos');
  var aNormal = gl.getAttribLocation(program, 'aNormal');
  var uMvp = gl.getUniformLocation(program, 'uMvp');
  var uModel = gl.getUniformLocation(program, 'uModel');
  var uColor = gl.getUniformLocation(program, 'uColor');

  function buffer(data) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return b;
  }

  // A cube: positions and per-face normals, six faces.
  var CUBE = (function () {
    var faces = [
      [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [1, 0, 0]],
      [[-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1], [-1, 0, 0]],
      [[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1], [0, 1, 0]],
      [[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1], [0, -1, 0]],
      [[-1, 1, 1], [1, 1, 1], [-1, -1, 1], [1, -1, 1], [0, 0, 1]],
      [[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [0, 0, -1]],
    ];
    var out = [];
    faces.forEach(function (f) {
      var n = f[4];
      [[f[0], f[2], f[1]], [f[1], f[2], f[3]]].forEach(function (tri) {
        tri.forEach(function (v) { out.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5, n[0], n[1], n[2]); });
      });
    });
    return out;
  })();

  // A low-poly sphere for the ball.
  var SPHERE = (function () {
    var out = [];
    var rings = 10;
    var segs = 14;
    for (var r = 0; r < rings; r += 1) {
      var p1 = Math.PI * (r / rings);
      var p2 = Math.PI * ((r + 1) / rings);
      for (var s = 0; s < segs; s += 1) {
        var t1 = 2 * Math.PI * (s / segs);
        var t2 = 2 * Math.PI * ((s + 1) / segs);
        var quad = [[p1, t1], [p2, t1], [p1, t2], [p2, t2]];
        var pts = quad.map(function (a) {
          return [Math.sin(a[0]) * Math.cos(a[1]), Math.cos(a[0]), Math.sin(a[0]) * Math.sin(a[1])];
        });
        [[pts[0], pts[1], pts[2]], [pts[2], pts[1], pts[3]]].forEach(function (tri) {
          tri.forEach(function (v) { out.push(v[0], v[1], v[2], v[0], v[1], v[2]); });
        });
      }
    }
    return out;
  })();

  var cubeBuf = buffer(CUBE);
  var sphereBuf = buffer(SPHERE);

  // ── tiny mat4 helpers ────────────────────────────────────────────────
  function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  function multiply(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c += 1) {
      for (var r = 0; r < 4; r += 1) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function translation(x, y, z) {
    var m = identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  }
  function scaling(x, y, z) {
    var m = identity();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
  }
  function perspective(fov, aspect, near, far) {
    var f = 1 / Math.tan(fov / 2);
    var m = new Array(16).fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  }
  function lookAt(eye, target, up) {
    var z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    var x = normalize(cross(up, z));
    var y = cross(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ];
  }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function normalize(v) {
    var len = Math.sqrt(dot(v, v)) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function bind(buf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
  }

  function drawObject(buf, count, model, color, viewProj) {
    gl.uniformMatrix4fv(uModel, false, new Float32Array(model));
    gl.uniformMatrix4fv(uMvp, false, new Float32Array(multiply(viewProj, model)));
    gl.uniform3fv(uColor, new Float32Array(color));
    bind(buf);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
    draw();
  }

  function reset() {
    ball.x = 0;
    ball.z = 0;
    score = 0;
    secondsLeft = ROUND_SECONDS;
    reported = false;
    gems = [];
    for (var i = 0; i < 10; i += 1) placeGem();
    updateStats();
  }

  function placeGem() {
    var angle = Math.random() * Math.PI * 2;
    var distance = 2 + Math.random() * 5.5;
    gems.push({ x: Math.cos(angle) * distance, z: Math.sin(angle) * distance });
  }

  function updateStats() {
    scoreEl.textContent = 'Gems ' + score;
    timeEl.textContent = Math.max(0, Math.ceil(secondsLeft)) + 's';
  }

  function draw() {
    gl.clearColor(0.09, 0.13, 0.2, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    var aspect = canvas.width / Math.max(1, canvas.height);
    var proj = perspective(Math.PI / 4, aspect, 0.1, 100);
    var view = lookAt([ball.x * 0.4, 11, ball.z + 12], [ball.x * 0.4, 0, ball.z], [0, 1, 0]);
    var viewProj = multiply(proj, view);

    // The garden: a wide green ground plane, plus a path square.
    drawObject(cubeBuf, 36, multiply(translation(0, -0.15, 0), scaling(16, 0.3, 16)), [0.24, 0.52, 0.32], viewProj);
    drawObject(cubeBuf, 36, multiply(translation(0, 0.02, 0), scaling(3.2, 0.08, 3.2)), [0.58, 0.47, 0.33], viewProj);

    // Gems: small blue octahedron-ish cubes, bobbing.
    var t = performance.now() / 600;
    gems.forEach(function (gem) {
      drawObject(cubeBuf, 36, multiply(translation(gem.x, 0.55 + Math.sin(t + gem.x) * 0.1, gem.z), scaling(0.5, 0.5, 0.5)), [0.38, 0.65, 1], viewProj);
    });

    // The ball.
    drawObject(sphereBuf, SPHERE.length / 6, multiply(translation(ball.x, ball.r, ball.z), scaling(ball.r * 2, ball.r * 2, ball.r * 2)), [0.1, 0.43, 0.88], viewProj);
  }

  function tick(now) {
    if (!playing) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    secondsLeft -= dt;
    if (secondsLeft <= 0) {
      finish();
      return;
    }

    var dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var dz = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (drag) { dx += drag.x; dz += drag.z; }
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len > 1) { dx /= len; dz /= len; }
    ball.x = Math.max(-7.2, Math.min(7.2, ball.x + dx * 4.2 * dt));
    ball.z = Math.max(-7.2, Math.min(7.2, ball.z + dz * 4.2 * dt));
    if (drag) { drag.x *= 0.86; drag.z *= 0.86; }

    for (var i = gems.length - 1; i >= 0; i -= 1) {
      var g = gems[i];
      var gx = g.x - ball.x;
      var gz = g.z - ball.z;
      if (Math.sqrt(gx * gx + gz * gz) < 0.75) {
        gems.splice(i, 1);
        score += 1;
        placeGem();
        updateStats();
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
    overlayTitle.textContent = 'Time: ' + score + (score === 1 ? ' gem' : ' gems');
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

  function keyName(event) {
    var k = event.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') return 'left';
    if (k === 'arrowright' || k === 'd') return 'right';
    if (k === 'arrowup' || k === 'w') return 'up';
    if (k === 'arrowdown' || k === 's') return 'down';
    return null;
  }

  window.addEventListener('keydown', function (event) {
    var k = keyName(event);
    if (!k) return;
    keys[k] = true;
    if (playing) event.preventDefault();
  });
  window.addEventListener('keyup', function (event) {
    var k = keyName(event);
    if (k) keys[k] = false;
  });

  canvas.addEventListener('pointerdown', function (event) {
    drag = { x: 0, z: 0, lastX: event.clientX, lastY: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!drag) return;
    drag.x = Math.max(-1, Math.min(1, (event.clientX - drag.lastX) / 40));
    drag.z = Math.max(-1, Math.min(1, (event.clientY - drag.lastY) / 40));
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
  });
  canvas.addEventListener('pointerup', function () { drag = null; });
  canvas.addEventListener('pointercancel', function () { drag = null; });

  startButton.addEventListener('click', start);
  window.addEventListener('resize', resize);

  resize();
  reset();
  draw();
  loadBoard();
})();
