'use strict';

// 3D game starter: a small 3D scene to walk around and collect glowing
// orbs in, with a group high score. The scene is built from the browser's
// own 3D CSS transforms, so a scaffolded app still needs only express, pg
// and jsonwebtoken. Non-violent by design: orbs to collect, nothing to
// fight, and the score is a plain number.

const base = require('./base');

const ROUTES = `// The group board, best first.
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, MAX(score)::int AS score FROM scores GROUP BY username ORDER BY score DESC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  try {
    const score = Number(req.body.score);
    if (!Number.isInteger(score) || score < 0 || score > 999) {
      return res.status(400).json({ error: 'A score is a whole number from 0 to 999.' });
    }
    await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
      [req.user.id, req.user.username, score]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

const EXAMPLE = `      <div id="scene" class="relative mx-auto rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden" style="width:320px;height:320px;perspective:700px;touch-action:none">
        <div id="world" style="position:absolute;inset:0;transform-style:preserve-3d;transform:rotateX(55deg)">
          <div style="position:absolute;left:-360px;top:-360px;width:1040px;height:1040px;background-image:linear-gradient(#27272a 1px,transparent 1px),linear-gradient(90deg,#27272a 1px,transparent 1px);background-size:52px 52px"></div>
        </div>
        <div style="position:absolute;left:50%;top:64%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:9999px;background:#7c3aed;box-shadow:0 0 12px #7c3aed" aria-hidden="true"></div>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span id="game-status" class="text-sm text-zinc-400">Collect the orbs</span>
        <button id="game-start" class="rounded-full bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-semibold text-white">Start game</button>
      </div>
      <div>
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Group scores</h3>
        <div id="game-scores" class="space-y-1"></div>
      </div>`;

const SCRIPT = `    const scene = document.getElementById('scene');
    const world = document.getElementById('world');
    const statusEl = document.getElementById('game-status');
    const startButton = document.getElementById('game-start');
    const scoresEl = document.getElementById('game-scores');
    const ROUND_MS = 45000;
    const PLACES = [
      { x: -90, z: -110 }, { x: 40, z: -120 }, { x: 110, z: -40 }, { x: -120, z: -20 },
      { x: -60, z: 90 }, { x: 70, z: 80 }, { x: 0, z: 0 }, { x: 120, z: 120 },
    ];
    const state = { running: false, score: 0, endsAt: 0, x: 0, z: 0, orbs: [] };
    const keys = {};

    function buildOrbs() {
      Array.prototype.slice.call(world.querySelectorAll('.orb')).forEach(function (el) { el.remove(); });
      state.orbs = PLACES.map(function (place) {
        var el = document.createElement('div');
        el.className = 'orb';
        el.style.position = 'absolute';
        el.style.left = (160 + place.x) + 'px';
        el.style.top = (160 + place.z) + 'px';
        el.style.width = '18px';
        el.style.height = '18px';
        el.style.margin = '-9px 0 0 -9px';
        el.style.borderRadius = '9999px';
        el.style.background = '#a78bfa';
        el.style.boxShadow = '0 0 14px #8b5cf6';
        el.style.transform = 'translateZ(18px)';
        world.appendChild(el);
        return { x: place.x, z: place.z, el: el, taken: false };
      });
    }

    function paintWorld() {
      world.style.transform = 'rotateX(55deg) translate(' + (-state.x) + 'px,' + (-state.z) + 'px)';
    }

    function tick(now) {
      if (!state.running) return;
      var speed = 2.6;
      if (keys.ArrowLeft || keys.a || keys.A) state.x -= speed;
      if (keys.ArrowRight || keys.d || keys.D) state.x += speed;
      if (keys.ArrowUp || keys.w || keys.W) state.z -= speed;
      if (keys.ArrowDown || keys.s || keys.S) state.z += speed;
      state.x = Math.max(-160, Math.min(160, state.x));
      state.z = Math.max(-160, Math.min(160, state.z));
      state.orbs.forEach(function (orb) {
        if (orb.taken) return;
        var dx = orb.x - state.x;
        var dz = orb.z - state.z;
        if (Math.sqrt(dx * dx + dz * dz) < 28) {
          orb.taken = true;
          orb.el.style.display = 'none';
          state.score += 1;
        }
      });
      var left = Math.max(0, Math.ceil((state.endsAt - now) / 1000));
      statusEl.textContent = 'Orbs ' + state.score + ' \\u00b7 ' + left + 's left';
      paintWorld();
      if (now >= state.endsAt) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    }

    async function finish() {
      state.running = false;
      startButton.disabled = false;
      statusEl.textContent = 'Time! You collected ' + state.score + '.';
      try {
        await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ score: state.score }),
        });
      } catch (e) {}
      loadScores();
    }

    function start() {
      state.running = true;
      state.score = 0;
      state.x = 0;
      state.z = 0;
      state.endsAt = performance.now() + ROUND_MS;
      buildOrbs();
      paintWorld();
      startButton.disabled = true;
      requestAnimationFrame(tick);
    }

    async function loadScores() {
      try {
        const res = await fetch('/api/scores', { headers: headers });
        if (!res.ok) return;
        const data = await res.json();
        const rows = data.scores || [];
        if (!rows.length) {
          scoresEl.innerHTML = '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
          return;
        }
        scoresEl.innerHTML = rows.map(function (r, i) {
          return '<div class="flex justify-between px-3 py-1 rounded text-sm ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
            '<span>' + (i + 1) + '. ' + esc(r.username) + '</span><span class="font-mono">' + r.score + '</span></div>';
        }).join('');
      } catch (e) {}
    }

    document.addEventListener('keydown', function (e) {
      keys[e.key] = true;
      if (e.key.indexOf('Arrow') === 0 && state.running) e.preventDefault();
    });
    document.addEventListener('keyup', function (e) { keys[e.key] = false; });

    var drag = null;
    scene.addEventListener('pointerdown', function (e) {
      if (!state.running) return;
      drag = { x: e.clientX, y: e.clientY };
      scene.setPointerCapture(e.pointerId);
    });
    scene.addEventListener('pointermove', function (e) {
      if (!drag || !state.running) return;
      state.x -= (e.clientX - drag.x) * 1.6;
      state.z -= (e.clientY - drag.y) * 1.6;
      state.x = Math.max(-160, Math.min(160, state.x));
      state.z = Math.max(-160, Math.min(160, state.z));
      drag = { x: e.clientX, y: e.clientY };
      paintWorld();
    });
    scene.addEventListener('pointerup', function () { drag = null; });
    scene.addEventListener('pointercancel', function () { drag = null; });
    startButton.addEventListener('click', start);

    buildOrbs();
    paintWorld();
    state.orbs.forEach(function (orb) { orb.el.style.display = 'none'; });
    loadScores();`;

module.exports = {
  key: 'game-3d',
  name: '3D game',
  caption: 'Walk a small 3D scene and collect the glowing orbs.',
  index({ appName }) {
    return base.page({
      appName,
      intro: 'Walk a small 3D scene and collect the glowing orbs. Arrow keys, WASD, or drag to move.',
      working: [
        { title: 'Sign-in through Homeroom', text: 'Every score is saved under the player Homeroom knows.' },
        { title: 'Your own database, storing the scores', text: 'The group board is read from it.' },
        { title: 'A live API behind the board', text: 'Finishing a round posts your score to the server.' },
      ],
      example: EXAMPLE,
      script: SCRIPT,
    });
  },
  server({ slug }) {
    return base.server({
      slug,
      bootstrap: `    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
      routes: ROUTES,
    });
  },
  claudeStarter: `## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the orb scene (the demo markup in
\`public/index.html\`, the \`/api/scores\` routes, and the \`scores\` table
bootstrap in \`server.js\`) — is a starter from Homeroom's 3D game
template, not product intent. The scene is drawn with the browser's own
3D CSS transforms, so it adds no dependency.

When the user asks for their first real feature, REPLACE the starter
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the \`scores\` table as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.

The starter takes the browser's score as sent. If scores start to matter,
verify the round on the server instead. Keep the game non-violent: Homeroom
allows no weapons, combat, gambling or mature themes.`,
  readmeDemo: `- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores the group's scores in a \`scores\` table.
- **Live API** — two example routes (\`GET /api/scores\`, \`POST /api/scores\`)
  read and write through a real Express server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};
