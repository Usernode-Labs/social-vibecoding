// Orb run — the starter 3D game.
//
// A ball rolls on a square platform; eight glowing orbs are scattered on it.
// Steer the ball with the arrow keys, WASD, or by dragging on the canvas.
// The clock runs from the first move; collecting the last orb stops it, the
// elapsed time goes to the shared scoreboard (GET/POST /api/scores in
// server.js, quickest first), and the list below the canvas shows it.
//
// Rendering is three.js, vendored at public/vendor/three.module.min.js so
// the app loads no cross-origin asset (see public/vendor/README.md). The
// game is a template placeholder: the group's first real change replaces it.

import * as THREE from '/vendor/three.module.min.js';

const canvas = document.getElementById('game-canvas');
if (canvas) {
  const statusEl = document.getElementById('game-status');
  const overEl = document.getElementById('game-over');
  const boardEl = document.getElementById('scoreboard');

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const headers = token ? { 'x-usernode-token': token } : {};

  const PLATFORM = 20; // square platform edge, world units
  const ORBS = 8;
  const BALL_R = 0.5;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#09090b');

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight('#8888aa', 0.7));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(6, 14, 8);
  scene.add(sun);

  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(PLATFORM, 1, PLATFORM),
    new THREE.MeshStandardMaterial({ color: '#27272a', roughness: 0.9 }),
  );
  platform.position.y = -0.5;
  scene.add(platform);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 24, 16),
    new THREE.MeshStandardMaterial({ color: '#0a6ee0', roughness: 0.4 }),
  );
  scene.add(ball);

  const orbGeo = new THREE.SphereGeometry(0.35, 16, 12);
  const orbMat = new THREE.MeshStandardMaterial({
    color: '#a78bfa', emissive: '#7c3aed', emissiveIntensity: 1.4, roughness: 0.3,
  });
  let orbs = [];

  function scatterOrbs() {
    for (const o of orbs) scene.remove(o);
    orbs = [];
    for (let i = 0; i < ORBS; i++) {
      const orb = new THREE.Mesh(orbGeo, orbMat);
      const edge = PLATFORM / 2 - 1.5;
      orb.position.set(
        (Math.random() * 2 - 1) * edge, 0.6, (Math.random() * 2 - 1) * edge,
      );
      scene.add(orb);
      orbs.push(orb);
    }
  }

  // ── The run ────────────────────────────────────────────────────────────
  let vel = { x: 0, z: 0 };
  let keys = { left: false, right: false, up: false, down: false };
  let running = false;
  let startedAt = 0;
  let rafId = 0;
  let submitted = false;

  function reset() {
    ball.position.set(0, BALL_R, 0);
    vel = { x: 0, z: 0 };
    running = false;
    startedAt = 0;
    submitted = false;
    overEl.textContent = '';
    statusEl.textContent = 'Roll the ball, collect ' + ORBS + ' orbs · against the clock';
    scatterOrbs();
  }

  function begin() {
    if (running || submitted) return;
    running = true;
    startedAt = performance.now();
  }

  function fmt(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }

  function step(dt) {
    const speed = 14;
    let ax = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let az = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (touch.dir) { ax = touch.dir.x; az = touch.dir.z; }
    vel.x += ax * speed * dt;
    vel.z += az * speed * dt;
    vel.x *= Math.pow(0.02, dt); // rolling friction
    vel.z *= Math.pow(0.02, dt);
    ball.position.x += vel.x * dt;
    ball.position.z += vel.z * dt;
    const edge = PLATFORM / 2 - BALL_R;
    ball.position.x = Math.min(edge, Math.max(-edge, ball.position.x));
    ball.position.z = Math.min(edge, Math.max(-edge, ball.position.z));
    // The ball visibly rolls: spin it around its travel axis.
    const v2 = Math.hypot(vel.x, vel.z);
    if (v2 > 0.01) {
      ball.rotateOnWorldAxis(new THREE.Vector3(vel.z, 0, -vel.x).normalize(), (v2 * dt) / BALL_R);
    }
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      o.rotation.y += dt * 2;
      if (o.position.distanceTo(ball.position) < BALL_R + 0.55) {
        scene.remove(o);
        orbs.splice(i, 1);
        statusEl.textContent = orbs.length + ' orb' + (orbs.length === 1 ? '' : 's') + ' left';
      }
    }
    if (running) {
      const elapsed = performance.now() - startedAt;
      statusEl.textContent = orbs.length
        ? fmt(elapsed) + ' · ' + orbs.length + ' orb' + (orbs.length === 1 ? '' : 's') + ' left'
        : fmt(elapsed);
      if (!orbs.length) {
        running = false;
        submitted = true;
        overEl.textContent = 'All orbs collected in ' + fmt(elapsed) + '!';
        submitScore(Math.round(elapsed));
      }
    }
  }

  // ── Input: keys, and drag-to-steer on the canvas for touch ────────────
  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', d: 'right', w: 'up', s: 'down', A: 'left', D: 'right', W: 'up', S: 'down',
  };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.key];
    if (k) { keys[k] = true; begin(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.key];
    if (k) keys[k] = false;
  });

  const touch = { active: false, dir: null };
  function steerFrom(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len < 8) { touch.dir = null; return; }
    const mag = Math.min(1, len / (rect.width / 4));
    touch.dir = { x: (dx / len) * mag, z: (dy / len) * mag };
  }
  canvas.addEventListener('pointerdown', (e) => {
    touch.active = true;
    canvas.setPointerCapture(e.pointerId);
    steerFrom(e.clientX, e.clientY);
    begin();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (touch.active) steerFrom(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', () => { touch.active = false; touch.dir = null; });
  canvas.addEventListener('pointercancel', () => { touch.active = false; touch.dir = null; });

  document.getElementById('game-restart').addEventListener('click', reset);

  // ── The shared scoreboard ─────────────────────────────────────────────
  async function submitScore(ms) {
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ score: ms }),
      });
      loadScores(res.status === 401);
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
        boardEl.innerHTML = '<p class="text-center text-zinc-600 text-sm">No runs yet — set the first best time</p>';
        return;
      }
      boardEl.innerHTML = scores.map((r, i) =>
        '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
        '<span>' + (i + 1) + '. ' + r.username.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' +
        '<span class="font-mono">' + fmt(r.score) + '</span></div>'
      ).join('');
    } catch {}
  }

  // ── Resize and the render loop ────────────────────────────────────────
  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 360;
    const h = Math.round(w * 0.75);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    // The camera tracks the ball from above and behind.
    camera.position.set(
      ball.position.x * 0.4, 14, ball.position.z * 0.4 + 13,
    );
    camera.lookAt(ball.position.x * 0.5, 0, ball.position.z * 0.5);
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }

  reset();
  loadScores(false);
  rafId = requestAnimationFrame(frame);
}