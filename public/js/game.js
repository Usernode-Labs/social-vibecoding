// Multiplayer obstacle-race — client module.
//
// Mirrors the structure of public/js/leaderboard.js (open/close driven by
// the hash-router in app.js). Owns four views inside #game-screen:
//   lobby   → create / join a room + recent races
//   waiting → room code, invite link + QR, live roster, host Start button
//   racing  → <canvas> render loop + local physics + WS position sync
//   results → finishing order, Race again (host) / Leave
//
// Transport: a single WebSocket to /ws/game/<CODE>. Movement is
// client-authoritative (we simulate our own disc and stream {x,y,angle});
// the server owns finish ordering and broadcasts the authoritative result.
// Obstacle motion is derived locally from the shared race-start timestamp,
// so hazards never need per-frame sync.
//
// No new dependencies: plain Canvas 2D + the QR library already loaded by
// index.html (window.QRCode).

const Game = {
  // ---- runtime state ---------------------------------------------------
  ws: null,
  view: 'lobby',
  room: null,          // { code, hostUserId, arenaId, status, players[], maxPlayers }
  arenasById: null,    // cache of GET /api/game/arenas
  arena: null,
  startAt: null,       // server epoch ms for the current race
  results: null,
  _opening: false,

  // race physics
  self: null,          // { x, y, vx, vy, angle }
  peers: new Map(),    // userId -> { x, y, angle, color, username }
  keys: {},
  joy: { active: false, dx: 0, dy: 0, id: null },
  raf: null,
  lastSent: 0,
  finishedSent: false,

  // ---- lifecycle -------------------------------------------------------

  async open(code) {
    if (this._opening) return;
    this._opening = true;
    try {
      await this._ensureArenas();
      this._bindKeys();
      if (code) {
        await this._joinByCode(code);
      } else {
        this._renderLobby();
      }
    } finally {
      this._opening = false;
    }
  },

  close() {
    this._disconnect();
    this._stopLoop();
    this._unbindKeys();
    this.view = 'lobby';
    this.room = null;
    this.results = null;
    this.peers.clear();
    const stage = document.getElementById('game-stage');
    if (stage) stage.classList.add('hidden');
    const root = document.getElementById('game-root');
    if (root) root.classList.remove('hidden');
  },

  get myId() {
    return window.App?.user?.id ?? null;
  },

  isHost() {
    return this.room && this.myId != null && this.room.hostUserId === this.myId;
  },

  // ---- data fetch ------------------------------------------------------

  async _ensureArenas() {
    if (this.arenasById) return;
    try {
      const res = await fetch('/api/game/arenas', { headers: this._authHeaders() });
      const data = await res.json();
      this.arenasById = {};
      (data.arenas || []).forEach((a) => { this.arenasById[a.id] = a; });
    } catch {
      this.arenasById = {};
    }
  },

  _authHeaders() {
    // Forward the staging iframe token like the rest of the app's fetches.
    const token = new URLSearchParams(location.search).get('token');
    return token ? { 'x-usernode-token': token } : {};
  },

  // ---- lobby view ------------------------------------------------------

  async _renderLobby() {
    this.view = 'lobby';
    this._showRoot();
    const root = document.getElementById('game-root');
    root.innerHTML = `
      <div class="max-w-md mx-auto">
        <h2 class="text-xl font-semibold mb-1 text-zinc-100">Obstacle Race</h2>
        <p class="text-sm text-zinc-400 mb-5">Create a room and invite friends, or join with a code. First disc across the finish line wins.</p>
        <div class="flex flex-col gap-3 mb-6">
          <button id="game-create" class="rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium py-3">Create a room</button>
          <div class="flex gap-2">
            <input id="game-join-code" maxlength="6" placeholder="ENTER CODE"
              class="flex-1 uppercase tracking-widest text-center rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 py-3 placeholder-zinc-500" />
            <button id="game-join" class="rounded-lg border border-zinc-600 hover:border-violet-500 text-zinc-100 px-4">Join</button>
          </div>
          <p id="game-lobby-error" class="hidden text-sm text-rose-400"></p>
        </div>
        <h3 class="text-sm font-semibold text-zinc-300 mb-2">Recent races</h3>
        <div id="game-recent" class="text-sm text-zinc-400">Loading…</div>
      </div>`;

    root.querySelector('#game-create').onclick = () => this._createRoom();
    root.querySelector('#game-join').onclick = () => {
      const v = root.querySelector('#game-join-code').value.trim().toUpperCase();
      if (v) location.hash = `#game/${encodeURIComponent(v)}`;
    };
    root.querySelector('#game-join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#game-join').click();
    });

    this._loadRecent();
  },

  async _loadRecent() {
    const el = document.getElementById('game-recent');
    if (!el) return;
    try {
      const res = await fetch('/api/game/results?limit=8', { headers: this._authHeaders() });
      const data = await res.json();
      const rows = data.results || [];
      if (!rows.length) {
        el.innerHTML = '<p class="text-zinc-500">No races yet — be the first!</p>';
        return;
      }
      el.innerHTML = rows.map((r) => `
        <div class="flex items-center justify-between py-2 border-b border-zinc-800">
          <span class="text-zinc-200">🏆 ${this._esc(r.winner || 'Unknown')}</span>
          <span class="text-zinc-500 text-xs">${r.playerCount} racers · ${this._timeAgo(r.finishedAt)}</span>
        </div>`).join('');
    } catch {
      el.innerHTML = '<p class="text-zinc-500">Could not load recent races.</p>';
    }
  },

  _lobbyError(msg) {
    const el = document.getElementById('game-lobby-error');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  },

  async _createRoom() {
    try {
      const res = await fetch('/api/game/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this._authHeaders() },
      });
      if (!res.ok) throw new Error('create failed');
      const data = await res.json();
      location.hash = `#game/${encodeURIComponent(data.code)}`;
    } catch {
      this._lobbyError('Could not create a room. Try again.');
    }
  },

  async _joinByCode(code) {
    const norm = String(code).trim().toUpperCase();
    try {
      const res = await fetch(`/api/game/rooms/${encodeURIComponent(norm)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this._authHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Stay on the lobby with the error; reset the hash so back works.
        await this._renderLobby();
        this._lobbyError(data.error || 'That race has already started or ended.');
        return;
      }
      this.room = data.room;
      this.arena = this.arenasById[this.room.arenaId] || null;
      this._connect(norm);
      this._renderWaiting();
    } catch {
      await this._renderLobby();
      this._lobbyError('Could not join that room.');
    }
  },

  // ---- waiting room ----------------------------------------------------

  _renderWaiting() {
    this.view = 'waiting';
    this._showRoot();
    this._stopLoop();
    const stage = document.getElementById('game-stage');
    if (stage) stage.classList.add('hidden');

    const root = document.getElementById('game-root');
    const link = this._inviteLink();
    root.innerHTML = `
      <div class="max-w-md mx-auto">
        <div class="text-center mb-5">
          <p class="text-xs uppercase tracking-widest text-zinc-500 mb-1">Room code</p>
          <p class="text-5xl font-bold tracking-[0.3em] text-violet-400">${this._esc(this.room.code)}</p>
        </div>
        <div class="flex flex-col items-center gap-3 mb-5">
          <div id="game-qr" class="bg-white p-2 rounded-lg"></div>
          <button id="game-copy" class="rounded-lg border border-zinc-600 hover:border-violet-500 text-zinc-200 text-sm px-4 py-2">Copy invite link</button>
        </div>
        <h3 class="text-sm font-semibold text-zinc-300 mb-2">Players <span id="game-pcount" class="text-zinc-500"></span></h3>
        <div id="game-roster" class="flex flex-col gap-2 mb-6"></div>
        <div id="game-host-controls"></div>
        <button id="game-leave" class="w-full mt-3 text-sm text-zinc-500 hover:text-zinc-300">Leave room</button>
      </div>`;

    // QR code (library loaded in index.html).
    const qrEl = root.querySelector('#game-qr');
    if (window.QRCode && qrEl) {
      try {
        new QRCode(qrEl, { text: link, width: 140, height: 140,
          colorDark: '#1a1a30', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      } catch { qrEl.remove(); }
    } else if (qrEl) {
      qrEl.remove();
    }

    root.querySelector('#game-copy').onclick = (e) => {
      navigator.clipboard?.writeText(link);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy invite link'; }, 1500);
    };
    root.querySelector('#game-leave').onclick = () => App.navigateHome();

    this._renderRoster();
  },

  _renderRoster() {
    if (this.view !== 'waiting' || !this.room) return;
    const rosterEl = document.getElementById('game-roster');
    const countEl = document.getElementById('game-pcount');
    if (countEl) countEl.textContent = `(${this.room.players.length}/${this.room.maxPlayers})`;
    if (rosterEl) {
      rosterEl.innerHTML = this.room.players.map((p) => `
        <div class="flex items-center gap-3 rounded-lg bg-zinc-800/60 px-3 py-2">
          <span class="w-4 h-4 rounded-full" style="background:${p.color}"></span>
          <span class="text-zinc-100">${this._esc(p.username)}</span>
          ${p.isHost ? '<span class="ml-auto text-xs text-violet-400">host</span>' : ''}
        </div>`).join('');
    }
    const hostEl = document.getElementById('game-host-controls');
    if (hostEl) {
      if (this.isHost()) {
        hostEl.innerHTML = `<button id="game-start" class="w-full rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium py-3">Start race</button>`;
        const startBtn = hostEl.querySelector('#game-start');
        const enough = this.room.players.length >= 1;
        startBtn.disabled = !enough;
        if (!enough) startBtn.classList.add('opacity-50', 'cursor-not-allowed');
        startBtn.onclick = () => this._send({ type: 'start' });
      } else {
        hostEl.innerHTML = `<p class="text-center text-sm text-zinc-500 py-3">Waiting for the host to start…</p>`;
      }
    }
  },

  _inviteLink() {
    return `${location.origin}${location.pathname}#game/${encodeURIComponent(this.room.code)}`;
  },

  // ---- WebSocket -------------------------------------------------------

  _connect(code) {
    this._disconnect();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = new URLSearchParams(location.search).get('token');
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/game/${encodeURIComponent(code)}${qs}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
  },

  _disconnect() {
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  },

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* noop */ }
    }
  },

  _onMessage(msg) {
    switch (msg.type) {
      case 'lobby':
        this.room = msg.room;
        this.arena = this.arenasById[this.room.arenaId] || this.arena;
        if (this.room.status === 'lobby') {
          // Back to the waiting room (initial join, or after a rematch).
          if (this.view !== 'waiting') this._renderWaiting();
          else this._renderRoster();
        }
        break;
      case 'race_start':
        this.startAt = msg.startAt;
        this.arena = this.arenasById[msg.arenaId] || this.arena;
        this._beginRace();
        break;
      case 'snapshot':
        this._applySnapshot(msg);
        break;
      case 'race_finished':
        this.results = msg.results;
        this._renderResults();
        break;
      case 'room_closed':
        this._stopLoop();
        this._disconnect();
        this._renderLobby();
        this._lobbyError(msg.reason === 'host_left'
          ? 'The host left and the room was closed.'
          : 'That room is no longer available.');
        break;
      case 'error':
        // Non-fatal; surface in the waiting room if present.
        break;
      default:
        break;
    }
  },

  // ---- race ------------------------------------------------------------

  _beginRace() {
    this.view = 'racing';
    this.finishedSent = false;
    this.peers.clear();
    const arena = this.arena || this.arenasById[this.room.arenaId];
    this.arena = arena;
    // Spawn position: find my roster index for a stable lane.
    const idx = Math.max(0, this.room.players.findIndex((p) => p.userId === this.myId));
    const lanes = this.room.maxPlayers || 8;
    const slot = (idx % lanes + 0.5) / lanes;
    this.self = {
      x: arena.start.x + slot * arena.start.w,
      y: arena.start.y + arena.start.h / 2,
      vx: 0, vy: 0, angle: 0,
    };

    // Swap to the canvas stage.
    document.getElementById('game-root').classList.add('hidden');
    const stage = document.getElementById('game-stage');
    stage.classList.remove('hidden');
    this._setupCanvas();
    this._setupJoystick();
    this._startLoop();
  },

  _setupCanvas() {
    const canvas = document.getElementById('game-canvas');
    const stage = document.getElementById('game-stage');
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();
    // Portrait viewport: full arena width, tall window.
    const w = Math.min(rect.width, 520);
    const h = rect.height;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    this._ctx = canvas.getContext('2d');
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._viewW = w;
    this._viewH = h;
    this._scale = w / this.arena.width;
  },

  _startLoop() {
    this._stopLoop();
    this._lastFrame = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
      this._lastFrame = now;
      this._update(dt);
      this._draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },

  _stopLoop() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  },

  _elapsed() {
    return (Date.now() - (this.startAt || Date.now()));
  },

  _inCountdown() {
    return this._elapsed() < 3000;
  },

  _update(dt) {
    if (this.view !== 'racing' || !this.self || !this.arena) return;
    const arena = this.arena;
    const r = arena.playerRadius;

    // Frozen during the 3-2-1 countdown.
    if (!this._inCountdown()) {
      const dir = this._inputVector();
      const speed = 300;
      this.self.vx = dir.x * speed;
      this.self.vy = dir.y * speed;
      if (dir.x || dir.y) this.self.angle = Math.atan2(dir.y, dir.x);

      this.self.x += this.self.vx * dt;
      this.self.y += this.self.vy * dt;

      // Clamp to world.
      this.self.x = Math.min(Math.max(this.self.x, r), arena.width - r);
      this.self.y = Math.min(Math.max(this.self.y, r), arena.height - r);

      // Collide with static walls.
      for (const wll of arena.walls) {
        const p = this._resolveCircleRect(this.self.x, this.self.y, r, wll);
        this.self.x = p.x; this.self.y = p.y;
      }
      // Collide with moving sweepers (treated as solid — they halt/shove).
      for (const ob of arena.obstacles) {
        const rect = this._sweeperRect(ob);
        const p = this._resolveCircleRect(this.self.x, this.self.y, r, rect);
        this.self.x = p.x; this.self.y = p.y;
      }
      // Elastic push-out from peers (bumping).
      for (const peer of this.peers.values()) {
        const ddx = this.self.x - peer.x;
        const ddy = this.self.y - peer.y;
        const dist = Math.hypot(ddx, ddy);
        const min = r * 2;
        if (dist > 0 && dist < min) {
          const push = (min - dist);
          this.self.x += (ddx / dist) * push;
          this.self.y += (ddy / dist) * push;
        }
      }

      // Finish — client claims, server validates + ranks authoritatively.
      if (!this.finishedSent && this._pointInRect(this.self.x, this.self.y, arena.finish)) {
        this.finishedSent = true;
        this._send({ type: 'finish', x: this.self.x, y: this.self.y });
      }
    }

    // Stream position at ~20Hz.
    const now = performance.now();
    if (now - this.lastSent >= 50) {
      this.lastSent = now;
      this._send({ type: 'pos', x: this.self.x, y: this.self.y, angle: this.self.angle });
    }
  },

  _applySnapshot(msg) {
    if (this.view !== 'racing') return;
    const seen = new Set();
    for (const p of msg.players) {
      if (p.userId === this.myId) continue; // our own disc is local-authoritative
      seen.add(p.userId);
      const meta = (this.room?.players || []).find((rp) => rp.userId === p.userId) || {};
      const existing = this.peers.get(p.userId) || {};
      this.peers.set(p.userId, {
        x: p.x, y: p.y, angle: p.angle,
        color: meta.color || existing.color || '#888',
        username: meta.username || existing.username || '',
      });
    }
    // Drop peers no longer present.
    for (const id of [...this.peers.keys()]) {
      if (!seen.has(id)) this.peers.delete(id);
    }
  },

  // ---- input -----------------------------------------------------------

  _inputVector() {
    let x = 0, y = 0;
    if (this.keys['ArrowLeft'] || this.keys['a'] || this.keys['A']) x -= 1;
    if (this.keys['ArrowRight'] || this.keys['d'] || this.keys['D']) x += 1;
    if (this.keys['ArrowUp'] || this.keys['w'] || this.keys['W']) y -= 1;
    if (this.keys['ArrowDown'] || this.keys['s'] || this.keys['S']) y += 1;
    if (this.joy.active) { x += this.joy.dx; y += this.joy.dy; }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  },

  _bindKeys() {
    if (this._keysBound) return;
    this._keysBound = true;
    this._onKeyDown = (e) => {
      if (this.view !== 'racing') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys[e.key] = true;
    };
    this._onKeyUp = (e) => { this.keys[e.key] = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  },

  _unbindKeys() {
    if (!this._keysBound) return;
    this._keysBound = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.keys = {};
  },

  _setupJoystick() {
    const joy = document.getElementById('game-joystick');
    const thumb = document.getElementById('game-joystick-thumb');
    if (!joy) return;
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (!isTouch) { joy.classList.add('hidden'); return; }
    joy.classList.remove('hidden');
    if (this._joyBound) return;
    this._joyBound = true;

    const radius = 48;
    const reset = () => {
      this.joy.active = false; this.joy.dx = 0; this.joy.dy = 0; this.joy.id = null;
      thumb.style.left = '36px'; thumb.style.top = '36px';
    };
    const move = (cx, cy) => {
      const rect = joy.getBoundingClientRect();
      let dx = cx - (rect.left + rect.width / 2);
      let dy = cy - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) { dx = dx / len * radius; dy = dy / len * radius; }
      thumb.style.left = (36 + dx) + 'px';
      thumb.style.top = (36 + dy) + 'px';
      this.joy.dx = dx / radius; this.joy.dy = dy / radius; this.joy.active = true;
    };
    joy.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0]; this.joy.id = t.identifier; move(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });
    joy.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.joy.id) move(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.joy.id) reset();
    };
    joy.addEventListener('touchend', end);
    joy.addEventListener('touchcancel', end);
  },

  // ---- geometry helpers ------------------------------------------------

  _sweeperRect(ob) {
    const elapsedSec = Math.max(0, this._elapsed()) / 1000;
    const cx = ob.x + ob.amplitude * Math.sin(elapsedSec * ob.speed + ob.phase);
    return { x: cx - ob.w / 2, y: ob.y - ob.h / 2, w: ob.w, h: ob.h };
  },

  _pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  },

  // Push a circle out of an axis-aligned rect (closest-point resolution).
  _resolveCircleRect(cx, cy, r, rect) {
    const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
    const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
    const dx = cx - nx;
    const dy = cy - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return { x: cx, y: cy };
    const d = Math.sqrt(d2) || 0.0001;
    const push = r - d;
    return { x: cx + (dx / d) * push, y: cy + (dy / d) * push };
  },

  // ---- rendering -------------------------------------------------------

  _draw() {
    const ctx = this._ctx;
    if (!ctx || !this.arena) return;
    const arena = this.arena;
    const scale = this._scale;
    const camY = Math.min(Math.max(this.self.y - (this._viewH / scale) / 2, 0),
      Math.max(0, arena.height - this._viewH / scale));

    ctx.clearRect(0, 0, this._viewW, this._viewH);
    ctx.fillStyle = '#0c0c16';
    ctx.fillRect(0, 0, this._viewW, this._viewH);

    const toX = (wx) => wx * scale;
    const toY = (wy) => (wy - camY) * scale;

    // Start + finish bands.
    ctx.fillStyle = 'rgba(34,197,94,0.18)';
    ctx.fillRect(toX(arena.start.x), toY(arena.start.y), arena.start.w * scale, arena.start.h * scale);
    ctx.fillStyle = 'rgba(168,85,247,0.30)';
    ctx.fillRect(toX(arena.finish.x), toY(arena.finish.y), arena.finish.w * scale, arena.finish.h * scale);
    // Finish checker line.
    ctx.fillStyle = '#a855f7';
    ctx.font = `${Math.round(14)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('FINISH', toX(arena.finish.x + arena.finish.w / 2), toY(arena.finish.y + arena.finish.h / 2));

    // Walls.
    ctx.fillStyle = '#3a3a55';
    for (const w of arena.walls) {
      ctx.fillRect(toX(w.x), toY(w.y), w.w * scale, w.h * scale);
    }
    // Moving sweepers.
    ctx.fillStyle = '#ef4444';
    for (const ob of arena.obstacles) {
      const rect = this._sweeperRect(ob);
      ctx.fillRect(toX(rect.x), toY(rect.y), rect.w * scale, rect.h * scale);
    }

    // Peers.
    for (const peer of this.peers.values()) {
      this._drawDisc(ctx, toX(peer.x), toY(peer.y), arena.playerRadius * scale, peer.color, peer.username);
    }
    // Self.
    this._drawDisc(ctx, toX(this.self.x), toY(this.self.y), arena.playerRadius * scale,
      this._myColor(), 'You', true);

    // HUD.
    const hud = document.getElementById('game-hud');
    if (hud) {
      if (this._inCountdown()) {
        const n = Math.ceil((3000 - this._elapsed()) / 1000);
        hud.innerHTML = `<span class="text-5xl font-bold text-white drop-shadow">${n > 0 ? n : 'GO!'}</span>`;
      } else {
        hud.innerHTML = '';
      }
    }
  },

  _drawDisc(ctx, x, y, r, color, label, isSelf) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color || '#888';
    ctx.fill();
    if (isSelf) { ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    if (label) {
      ctx.fillStyle = '#e5e5ef';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - r - 4);
    }
  },

  _myColor() {
    const me = (this.room?.players || []).find((p) => p.userId === this.myId);
    return me ? me.color : '#fff';
  },

  // ---- results ---------------------------------------------------------

  _renderResults() {
    this.view = 'results';
    this._stopLoop();
    document.getElementById('game-stage').classList.add('hidden');
    this._showRoot();
    const root = document.getElementById('game-root');
    const medal = (p) => (p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : `${p}.`);
    root.innerHTML = `
      <div class="max-w-md mx-auto text-center">
        <h2 class="text-2xl font-bold text-zinc-100 mb-1">Race results</h2>
        <p class="text-sm text-zinc-400 mb-5">Room ${this._esc(this.room?.code || '')}</p>
        <div class="flex flex-col gap-2 mb-6 text-left">
          ${(this.results || []).map((r) => `
            <div class="flex items-center gap-3 rounded-lg px-3 py-2 ${r.placement === 1 ? 'bg-violet-600/30 border border-violet-500' : 'bg-zinc-800/60'}">
              <span class="w-7 text-center">${medal(r.placement)}</span>
              <span class="w-4 h-4 rounded-full" style="background:${r.color || '#888'}"></span>
              <span class="text-zinc-100 ${r.userId === this.myId ? 'font-semibold' : ''}">${this._esc(r.username)}${r.userId === this.myId ? ' (you)' : ''}</span>
              ${r.placement === 1 && r.finishMs != null ? `<span class="ml-auto text-xs text-zinc-400">${(r.finishMs / 1000).toFixed(1)}s</span>` : ''}
            </div>`).join('')}
        </div>
        <div id="game-results-controls" class="flex flex-col gap-2"></div>
      </div>`;
    const ctrls = root.querySelector('#game-results-controls');
    if (this.isHost()) {
      ctrls.innerHTML = `
        <button id="game-again" class="rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium py-3">Race again</button>
        <button id="game-leave2" class="text-sm text-zinc-500 hover:text-zinc-300 py-2">Leave</button>`;
      ctrls.querySelector('#game-again').onclick = () => this._send({ type: 'rematch' });
    } else {
      ctrls.innerHTML = `
        <p class="text-sm text-zinc-500 py-2">Waiting for the host to start another race…</p>
        <button id="game-leave2" class="text-sm text-zinc-500 hover:text-zinc-300 py-2">Leave</button>`;
    }
    ctrls.querySelector('#game-leave2').onclick = () => App.navigateHome();
  },

  // ---- util ------------------------------------------------------------

  _showRoot() {
    document.getElementById('game-root').classList.remove('hidden');
    const stage = document.getElementById('game-stage');
    if (stage && this.view !== 'racing') stage.classList.add('hidden');
  },

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  _timeAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};

window.Game = Game;
