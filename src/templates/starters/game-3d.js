'use strict';

/**
 * Starter: 3D game — a small 3D game with a leaderboard (request #3521).
 * Tower stack: a block slides above the tower; tap (or click) to drop it;
 * whatever misses the block below ends the round, and the score is the
 * blocks placed. The score is posted once, when the round ends, and the
 * top-10 board shows the result.
 *
 * The 3D graphics come from a VENDORED copy of three.js, served from the
 * app's own origin (public/vendor/three.module.min.js, read at module
 * load here and emitted only for this starter). No CDN, no npm
 * dependency — package.json and the lockfile are untouched, and offline
 * launch keeps working. index.js carries the file and its provenance row.
 *
 * A ranking on a board is all it is: no combat, no weapons, nothing to
 * bet, and the round ends by itself (the first complete miss).
 */

const fs = require('fs');
const path = require('path');

const VENDORED = fs.readFileSync(path.join(__dirname, 'game-3d', 'three.module.min.js'), 'utf8');

const VENDOR_README = `# public/vendor — vendored files

Files here are vendored, never fetched at runtime: this app loads no
cross-origin assets.

- \`three.module.min.js\` — three.js, the MIT-licensed 3D graphics library,
  release 0.180.0 (\`three@0.180.0\`), the minified ES module build, served
  to the game in \`public/index.html\` from this app's own origin.
  SHA-384: \`1b6d38707f32886441b0878e7746b20579fb3120ee7f45f94e8eb5e31b7ed9bd40a6a354c405a7fd7a8bf178a56aec9d\`
  (338908 bytes). Upstream: https://github.com/mrdoob/three.js
`;

const SCORES_DDL = `CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;

const SCORES_ROUTES = `// Tower-stack scores: the round posts ONCE, when it ends. A score is an
// integer clamped server-side to 0..100000 — a client's claim, not a
// truth, but never a route anyone can bet on.
app.post('/api/scores', async (req, res) => {
  const raw = Number(req.body.score);
  if (!Number.isFinite(raw)) {
    return res.status(400).json({ error: 'A score is a number.' });
  }
  const score = Math.max(0, Math.min(100000, Math.round(raw)));
  try {
    const { rows } = await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3) RETURNING id, score',
      [req.user.id, req.user.username, score]
    );
    res.status(201).json({ score: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, score FROM scores ORDER BY score DESC, id ASC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

module.exports = {
  id: 'game-3d',
  title: '3D game',
  caption: 'A small 3D game with a leaderboard.',
  exampleNote: 'the tower-stack example (the demo markup in `public/index.html`, the `/api/scores` routes, and the `scores` table bootstrap in `server.js`)',
  demoTable: 'scores',
  readmeExample: `- **Database** — the app has its own private Postgres database; the
  demo stores game scores in a \`scores\` table.
- **Live API** — the score routes (\`/api/scores\`) read and write
  through a real Express server.`,

  /** Only this starter carries extra files: the vendored three and its README. */
  extraFiles: [
    { path: 'public/vendor/three.module.min.js', content: VENDORED },
    { path: 'public/vendor/README.md', content: VENDOR_README },
  ],

  demoServer() {
    return { ddl: SCORES_DDL, routes: SCORES_ROUTES };
  },

  demoScreen() {
    return {
      markup: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <div id="stack-mount" class="block w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-950 overflow-hidden cursor-pointer"></div>

      <div id="game-status" class="text-sm text-zinc-400">Tap the game to start — tap again to drop each sliding block</div>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h3>
        <div id="board" class="space-y-1"></div>
      </div>
    </section>`,
      script: `    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    const mount = document.getElementById('stack-mount');
    const status = document.getElementById('game-status');

    let renderer = null;
    let scene = null;
    let camera = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(320, 220);
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.width = '100%';
      mount.appendChild(renderer.domElement);
    } catch (e) {
      status.textContent = 'This browser cannot show the 3D game (no WebGL).';
    }

    if (renderer) {
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x09090b);
      camera = new THREE.PerspectiveCamera(45, 320 / 220, 0.1, 100);
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(5, 10, 5);
      scene.add(sun);
    }

    const BLOCK_H = 0.6;
    const COLORS = [0x7c3aed, 0xa78bfa, 0x6d28d9];
    let stack = [];
    let moving = null;
    let dir = 1;
    let score = 0;
    let running = false;

    function clearTower() {
      for (const m of stack) scene.remove(m);
      stack = [];
      if (moving) { scene.remove(moving); moving = null; }
    }

    function base() {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(3, BLOCK_H, 3),
        new THREE.MeshLambertMaterial({ color: 0x7c3aed })
      );
      m.position.set(0, BLOCK_H / 2, 0);
      scene.add(m);
      stack.push(m);
    }

    function spawn() {
      const top = stack[stack.length - 1];
      const width = top.geometry.parameters.width;
      moving = new THREE.Mesh(
        new THREE.BoxGeometry(width, BLOCK_H, top.geometry.parameters.depth),
        new THREE.MeshLambertMaterial({ color: COLORS[stack.length % COLORS.length] })
      );
      moving.position.set(top.position.x + dir * 4.5, top.position.y + BLOCK_H, 0);
      scene.add(moving);
    }

    function drop() {
      if (!running || !moving) return;
      const top = stack[stack.length - 1];
      const delta = moving.position.x - top.position.x;
      const overlap = top.geometry.parameters.width - Math.abs(delta);
      scene.remove(moving);
      moving = null;
      if (overlap <= 0.05) { endRound(); return; }
      const landed = new THREE.Mesh(
        new THREE.BoxGeometry(overlap, BLOCK_H, top.geometry.parameters.depth),
        new THREE.MeshLambertMaterial({ color: COLORS[stack.length % COLORS.length] })
      );
      landed.position.set(top.position.x + delta / 2, top.position.y + BLOCK_H, 0);
      scene.add(landed);
      stack.push(landed);
      score += 1;
      dir = -dir;
      status.textContent = 'Score ' + score;
      spawn();
    }

    function startRound() {
      if (!renderer || running) return;
      clearTower();
      score = 0;
      dir = 1;
      running = true;
      base();
      spawn();
      status.textContent = 'Score 0';
    }

    function endRound() {
      running = false;
      status.textContent =
        'Round over — you stacked ' + score + (score === 1 ? ' block' : ' blocks') + '. Tap the game to go again.';
      // The score is posted once, automatically, when the round ends.
      if (score > 0) {
        fetch('/api/scores', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ score: score })
        }).then(loadBoard).catch(function () {});
      }
    }

    mount.addEventListener('click', function () {
      if (!running) startRound();
      else drop();
    });

    let lastFrame = performance.now();
    function loop(now) {
      const dt = Math.min(50, now - lastFrame) / 1000;
      lastFrame = now;
      if (renderer) {
        if (running && moving) {
          moving.position.x += dir * 2.4 * dt * Math.min(4, 1 + score * 0.12);
          if (moving.position.x > 4.5) { moving.position.x = 4.5; dir = -1; }
          if (moving.position.x < -4.5) { moving.position.x = -4.5; dir = 1; }
        }
        const height = stack.length * BLOCK_H;
        camera.position.set(6, height + 5, 8);
        camera.lookAt(0, Math.max(0.5, height - BLOCK_H * 2), 0);
        renderer.render(scene, camera);
      }
      requestAnimationFrame(loop);
    }

    async function loadBoard() {
      const res = await fetch('/api/scores', { headers });
      if (!res.ok) return;
      const data = await res.json();
      const el = document.getElementById('board');
      const scores = data.scores || [];
      if (!scores.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
        return;
      }
      el.innerHTML = scores.map(function (r, i) {
        return '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
          '<span>' + (i + 1) + '. ' + r.username + '</span>' +
          '<span class="font-mono">' + r.score + '</span></div>';
      }).join('');
    }

    loadBoard();
    requestAnimationFrame(loop);`,
      // The game's script is an ES module: it imports the vendored three
      // from the app's own origin, relative, no host named.
      moduleImport: `      import * as THREE from '/vendor/three.module.min.js';`,
    };
  },
};
