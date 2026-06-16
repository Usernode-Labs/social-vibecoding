// Block Blast puzzle game — client module.
//
// Mirrors the structure of public/js/leaderboard.js (open/close driven by
// the hash-router in app.js). Owns two sub-views inside #blockblast-root:
//   play        → canvas-based 8×8 block-placement puzzle
//   leaderboard → HTML list of top 20 scores
//
// Wallet check on every open(): if getNodeAddress() resolves to empty,
// shows a gate message instead of the game board.
//
// All game logic runs client-side. The server stores only the personal-best
// score, written on Submit after a game ends.

// ─── Piece definitions ────────────────────────────────────────────────────
// Each piece: cells[] is [row, col] offsets from top-left [0,0].

const BB_PIECES = [
  { cells: [[0,0]],                                                     color: '#ec4899' }, // 1×1
  { cells: [[0,0],[0,1]],                                               color: '#14b8a6' }, // 1×2 H
  { cells: [[0,0],[1,0]],                                               color: '#8b5cf6' }, // 1×2 V
  { cells: [[0,0],[0,1],[0,2]],                                         color: '#f59e0b' }, // 1×3 H
  { cells: [[0,0],[1,0],[2,0]],                                         color: '#10b981' }, // 1×3 V
  { cells: [[0,0],[0,1],[0,2],[0,3]],                                   color: '#06b6d4' }, // 1×4 H
  { cells: [[0,0],[1,0],[2,0],[3,0]],                                   color: '#22d3ee' }, // 1×4 V
  { cells: [[0,0],[0,1],[1,0],[1,1]],                                   color: '#eab308' }, // 2×2
  { cells: [[0,0],[0,1],[0,2],[1,1]],                                   color: '#a855f7' }, // T
  { cells: [[0,0],[0,1],[0,2],[1,0]],                                   color: '#3b82f6' }, // J
  { cells: [[0,0],[0,1],[0,2],[1,2]],                                   color: '#f97316' }, // L
  { cells: [[0,1],[0,2],[1,0],[1,1]],                                   color: '#22c55e' }, // S
  { cells: [[0,0],[0,1],[1,1],[1,2]],                                   color: '#ef4444' }, // Z
  { cells: [[0,0],[1,0],[1,1]],                                         color: '#f43f5e' }, // ⌐ corner
  { cells: [[0,1],[1,0],[1,1]],                                         color: '#6366f1' }, // ¬ corner
  { cells: [[0,0],[0,1],[1,0]],                                         color: '#84cc16' }, // Γ corner
  { cells: [[0,0],[0,1],[1,1]],                                         color: '#fbbf24' }, // ⌐ corner 2
];

function bbRandPiece() {
  return BB_PIECES[Math.floor(Math.random() * BB_PIECES.length)];
}

function bbBounds(piece) {
  const maxR = Math.max(...piece.cells.map(c => c[0]));
  const maxC = Math.max(...piece.cells.map(c => c[1]));
  return { rows: maxR + 1, cols: maxC + 1 };
}

function bbEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Main module ──────────────────────────────────────────────────────────

const BlockBlast = {
  _open: false,
  sub: 'play',          // 'play' | 'leaderboard'
  _walletPubkey: null,

  // Game state
  _grid: null,          // 8×8 array of null | color-string
  _tray: [null, null, null],
  _score: 0,
  _personalBest: 0,
  _gameRunning: false,
  _gameOver: false,
  _submitting: false,
  _submitted: false,

  // Drag
  _drag: null,          // { trayIdx, piece, px, py, snapRow, snapCol, valid }
  _rafId: null,

  // Layout — recomputed each draw cycle
  _layout: null,

  // Leaderboard
  _lbCache: null,
  _lbLoading: false,

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async open() {
    if (!BlockBlast._open) {
      BlockBlast._open = true;
      BlockBlast._buildUI();
    }
    BlockBlast._syncTabs();

    // Re-check wallet on every open so linking mid-session is reflected.
    BlockBlast._showWalletGate(false);
    BlockBlast._walletPubkey = null;
    try {
      const addr = window.getNodeAddress ? await window.getNodeAddress() : null;
      BlockBlast._walletPubkey = addr || null;
    } catch (_) { BlockBlast._walletPubkey = null; }

    if (!BlockBlast._walletPubkey) {
      BlockBlast._showWalletGate(true);
      return;
    }

    if (!BlockBlast._gameRunning && !BlockBlast._gameOver) {
      BlockBlast._startGame();
    } else {
      BlockBlast._drawGame();
    }
  },

  close() {
    BlockBlast._open = false;
    if (BlockBlast._rafId) {
      cancelAnimationFrame(BlockBlast._rafId);
      BlockBlast._rafId = null;
    }
  },

  // ── DOM construction ────────────────────────────────────────────────────

  _buildUI() {
    const root = document.getElementById('blockblast-root');
    if (!root) return;
    root.innerHTML = `
<div class="flex flex-col h-full text-zinc-100 select-none overflow-hidden">
  <div class="flex border-b border-zinc-800 shrink-0 bg-zinc-950">
    <button id="bb-tab-play"
      class="flex-1 py-2.5 text-sm font-medium text-violet-400 border-b-2 border-violet-400">
      Play
    </button>
    <button id="bb-tab-lb"
      class="flex-1 py-2.5 text-sm font-medium text-zinc-400 hover:text-zinc-200">
      Leaderboard
    </button>
  </div>

  <div id="bb-play-view" class="flex-1 relative overflow-hidden">
    <canvas id="bb-canvas" style="display:block;width:100%;height:100%;touch-action:none"></canvas>

    <!-- Wallet not linked -->
    <div id="bb-wallet-gate"
      class="hidden absolute inset-0 flex flex-col items-center justify-center gap-5 bg-zinc-950 p-8 text-center">
      <svg class="w-14 h-14 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M21 12a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18-3a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/>
      </svg>
      <p class="text-zinc-200 font-semibold text-lg">Connect your wallet to play Block Blast</p>
      <p class="text-zinc-500 text-sm max-w-xs">Open the menu → Settings → Wallet to link your Usernode wallet, then return here.</p>
    </div>

    <!-- Game over panel -->
    <div id="bb-gameover"
      class="hidden absolute inset-0 flex items-center justify-center bg-zinc-950/85">
      <div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 flex flex-col items-center gap-4 w-72 shadow-2xl">
        <p class="text-xl font-bold text-zinc-100">Game Over</p>
        <div class="text-center">
          <p id="bb-final-score" class="text-5xl font-black text-violet-400">0</p>
          <p class="text-xs text-zinc-500 mt-1 uppercase tracking-wide">Your score</p>
        </div>
        <div id="bb-best-wrap" class="hidden text-center">
          <p id="bb-best-display" class="text-base font-semibold text-amber-400"></p>
          <p class="text-xs text-zinc-600 mt-0.5">All-time best</p>
        </div>
        <button id="bb-submit-btn"
          class="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-semibold text-sm transition-colors">
          Submit Score
        </button>
        <button id="bb-again-btn"
          class="hidden w-full py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 active:bg-zinc-800 text-zinc-100 font-semibold text-sm transition-colors">
          Play Again
        </button>
        <p id="bb-submit-msg" class="hidden text-xs text-zinc-400 text-center"></p>
      </div>
    </div>
  </div>

  <div id="bb-lb-view" class="hidden flex-1 overflow-y-auto bg-zinc-950">
    <div id="bb-lb-rows" class="max-w-lg mx-auto p-4"></div>
  </div>
</div>`;

    BlockBlast._attachListeners();
  },

  _attachListeners() {
    document.getElementById('bb-tab-play')?.addEventListener('click', () => {
      BlockBlast.sub = 'play';
      BlockBlast._syncTabs();
    });
    document.getElementById('bb-tab-lb')?.addEventListener('click', () => {
      BlockBlast.sub = 'leaderboard';
      BlockBlast._syncTabs();
      BlockBlast._loadLeaderboard();
    });
    document.getElementById('bb-submit-btn')?.addEventListener('click', () => {
      BlockBlast._submitScore();
    });
    document.getElementById('bb-again-btn')?.addEventListener('click', () => {
      document.getElementById('bb-gameover')?.classList.add('hidden');
      BlockBlast._startGame();
    });

    const cv = document.getElementById('bb-canvas');
    if (cv) {
      cv.addEventListener('pointerdown', BlockBlast._onPointerDown, { passive: false });
      cv.addEventListener('pointermove', BlockBlast._onPointerMove, { passive: false });
      cv.addEventListener('pointerup', BlockBlast._onPointerUp);
      cv.addEventListener('pointercancel', BlockBlast._onPointerCancel);
    }

    window.addEventListener('resize', () => {
      if (BlockBlast._open && BlockBlast.sub === 'play' && !BlockBlast._walletGateVisible()) {
        BlockBlast._layout = null;
        BlockBlast._drawGame();
      }
    });
  },

  _walletGateVisible() {
    const g = document.getElementById('bb-wallet-gate');
    return g && !g.classList.contains('hidden');
  },

  // ── Tab sync ─────────────────────────────────────────────────────────────

  _syncTabs() {
    const playView = document.getElementById('bb-play-view');
    const lbView   = document.getElementById('bb-lb-view');
    const tabPlay  = document.getElementById('bb-tab-play');
    const tabLb    = document.getElementById('bb-tab-lb');
    if (!playView || !lbView) return;

    const isPlay = BlockBlast.sub === 'play';
    playView.classList.toggle('hidden', !isPlay);
    lbView.classList.toggle('hidden', isPlay);

    const activeClass = 'text-violet-400 border-b-2 border-violet-400';
    const inactiveClass = 'text-zinc-400 hover:text-zinc-200';
    if (tabPlay) tabPlay.className = `flex-1 py-2.5 text-sm font-medium ${isPlay ? activeClass : inactiveClass}`;
    if (tabLb)   tabLb.className   = `flex-1 py-2.5 text-sm font-medium ${isPlay ? inactiveClass : activeClass}`;

    if (isPlay && BlockBlast._walletPubkey && BlockBlast._gameRunning) {
      // Force a layout recompute on tab switch (canvas may have been hidden)
      BlockBlast._layout = null;
      BlockBlast._drawGame();
    }
  },

  _showWalletGate(show) {
    document.getElementById('bb-wallet-gate')?.classList.toggle('hidden', !show);
  },

  // ── Game lifecycle ───────────────────────────────────────────────────────

  _startGame() {
    BlockBlast._grid = Array.from({ length: 8 }, () => new Array(8).fill(null));
    BlockBlast._score = 0;
    BlockBlast._gameRunning = true;
    BlockBlast._gameOver = false;
    BlockBlast._submitting = false;
    BlockBlast._submitted = false;
    BlockBlast._drag = null;
    BlockBlast._tray = [null, null, null];
    BlockBlast._refillTray();
    BlockBlast._layout = null;
    BlockBlast._drawGame();
  },

  _refillTray() {
    for (let i = 0; i < 3; i++) {
      if (BlockBlast._tray[i] === null) {
        BlockBlast._tray[i] = bbRandPiece();
      }
    }
  },

  // ── Game logic ───────────────────────────────────────────────────────────

  _canPlace(piece, row, col) {
    for (const [dr, dc] of piece.cells) {
      const r = row + dr, c = col + dc;
      if (r < 0 || r >= 8 || c < 0 || c >= 8) return false;
      if (BlockBlast._grid[r][c] !== null) return false;
    }
    return true;
  },

  _anyMovePossible() {
    for (let i = 0; i < 3; i++) {
      const piece = BlockBlast._tray[i];
      if (!piece) continue;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (BlockBlast._canPlace(piece, r, c)) return true;
        }
      }
    }
    return false;
  },

  _placePiece(trayIdx, row, col) {
    const piece = BlockBlast._tray[trayIdx];
    if (!piece || !BlockBlast._canPlace(piece, row, col)) return;

    for (const [dr, dc] of piece.cells) {
      BlockBlast._grid[row + dr][col + dc] = piece.color;
    }
    BlockBlast._tray[trayIdx] = null;

    const cleared = BlockBlast._clearLines();
    BlockBlast._score += cleared * 10;

    if (BlockBlast._tray.every(p => p === null)) {
      BlockBlast._tray = [null, null, null];
      BlockBlast._refillTray();
    }

    if (!BlockBlast._anyMovePossible()) {
      BlockBlast._gameRunning = false;
      BlockBlast._gameOver = true;
      BlockBlast._drawGame();
      BlockBlast._showGameOver();
      return;
    }

    BlockBlast._drawGame();
  },

  _clearLines() {
    let cleared = 0;
    const rowsToClear = [];
    const colsToClear = [];

    for (let r = 0; r < 8; r++) {
      if (BlockBlast._grid[r].every(c => c !== null)) rowsToClear.push(r);
    }
    for (let c = 0; c < 8; c++) {
      if (BlockBlast._grid.every(row => row[c] !== null)) colsToClear.push(c);
    }

    for (const r of rowsToClear) {
      BlockBlast._grid[r] = new Array(8).fill(null);
      cleared += 8;
    }
    for (const c of colsToClear) {
      for (let r = 0; r < 8; r++) BlockBlast._grid[r][c] = null;
      cleared += 8;
    }

    return cleared;
  },

  _showGameOver() {
    const el = document.getElementById('bb-gameover');
    if (!el) return;
    el.classList.remove('hidden');

    const finalEl = document.getElementById('bb-final-score');
    if (finalEl) finalEl.textContent = BlockBlast._score.toLocaleString();

    const bestWrap = document.getElementById('bb-best-wrap');
    const bestDisp = document.getElementById('bb-best-display');
    if (bestWrap && bestDisp) {
      if (BlockBlast._score >= BlockBlast._personalBest && BlockBlast._personalBest > 0) {
        bestDisp.textContent = '🏆 New High Score!';
        bestWrap.classList.remove('hidden');
      } else if (BlockBlast._personalBest > 0) {
        bestDisp.textContent = `Best: ${BlockBlast._personalBest.toLocaleString()}`;
        bestWrap.classList.remove('hidden');
      }
    }

    const submitBtn = document.getElementById('bb-submit-btn');
    if (submitBtn) { submitBtn.classList.remove('hidden'); submitBtn.disabled = false; submitBtn.textContent = 'Submit Score'; }
    document.getElementById('bb-again-btn')?.classList.add('hidden');
    const msg = document.getElementById('bb-submit-msg');
    if (msg) { msg.textContent = ''; msg.classList.add('hidden'); }
  },

  async _submitScore() {
    if (BlockBlast._submitting || BlockBlast._submitted) return;
    BlockBlast._submitting = true;

    const submitBtn = document.getElementById('bb-submit-btn');
    const msg = document.getElementById('bb-submit-msg');
    const againBtn = document.getElementById('bb-again-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

    try {
      const res = await fetch('/api/block-blast/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: BlockBlast._score }),
      });
      const data = await res.json();
      if (res.ok) {
        BlockBlast._submitted = true;
        BlockBlast._personalBest = data.personalBest || BlockBlast._score;
        BlockBlast._lbCache = null; // invalidate so next view is fresh
        if (submitBtn) submitBtn.classList.add('hidden');
        if (msg) { msg.textContent = 'Score saved!'; msg.classList.remove('hidden'); }
        if (againBtn) againBtn.classList.remove('hidden');
      } else {
        const txt = data.error === 'Wallet not linked'
          ? 'Wallet not linked — connect it in Settings.'
          : (data.error || 'Save failed. Try again.');
        if (msg) { msg.textContent = txt; msg.classList.remove('hidden'); }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Try Again'; }
      }
    } catch (_) {
      if (msg) { msg.textContent = 'Network error — try again.'; msg.classList.remove('hidden'); }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Try Again'; }
    } finally {
      BlockBlast._submitting = false;
    }
  },

  // ── Canvas rendering ─────────────────────────────────────────────────────

  _computeLayout(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;

    // Resize backing store to match CSS pixel size × dpr
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }

    const PAD = 12;
    const SCORE_H = 34;
    const TRAY_GAP = 14;
    const TRAY_ROWS = 4; // max piece height in cells

    const availW = w - PAD * 2;
    const availH = h - PAD * 2 - SCORE_H - 8 - TRAY_GAP;

    const cellFromH = Math.floor(availH / (8 + TRAY_ROWS));
    const cellFromW = Math.floor(availW / 8);
    const CELL = Math.max(20, Math.min(cellFromH, cellFromW, 60));
    const STRIDE = CELL + 1; // 1 px gap between cells

    const gridPxW = STRIDE * 8 - 1;
    const gridPxH = STRIDE * 8 - 1;
    const gridX = Math.floor((w - gridPxW) / 2);
    const gridY = PAD + SCORE_H + 8;

    const trayY = gridY + gridPxH + TRAY_GAP;
    const slotW = Math.floor(gridPxW / 3);

    return { dpr, w, h, CELL, STRIDE, gridX, gridY, gridPxW, gridPxH, trayY, slotW, PAD, SCORE_H };
  },

  _drawGame() {
    const cv = document.getElementById('bb-canvas');
    if (!cv) return;
    if (!BlockBlast._layout) {
      BlockBlast._layout = BlockBlast._computeLayout(cv);
    }
    const L = BlockBlast._layout;
    const { dpr, w, h, CELL, STRIDE, gridX, gridY, trayY, slotW } = L;

    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#09090b'; // zinc-950
    ctx.fillRect(0, 0, w, h);

    // Score bar
    ctx.fillStyle = '#a1a1aa'; // zinc-400
    ctx.font = `600 ${Math.min(16, CELL - 6)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('SCORE', L.PAD, L.PAD + L.SCORE_H / 2);
    ctx.fillStyle = '#e4e4e7'; // zinc-200
    ctx.font = `800 ${Math.min(22, CELL)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(BlockBlast._score.toLocaleString(), w - L.PAD, L.PAD + L.SCORE_H / 2);

    // Grid background
    ctx.fillStyle = '#27272a'; // zinc-800
    ctx.fillRect(gridX - 2, gridY - 2, L.gridPxW + 4, L.gridPxH + 4);

    // Grid cells
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const x = gridX + c * STRIDE;
        const y = gridY + r * STRIDE;
        const color = BlockBlast._grid?.[r]?.[c] || null;
        ctx.fillStyle = color || '#3f3f46'; // zinc-700 for empty
        ctx.fillRect(x, y, CELL, CELL);
        if (color) {
          // Subtle inner highlight
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(x, y, CELL, 3);
        }
      }
    }

    // Drop preview (ghost)
    if (BlockBlast._drag) {
      const { piece, snapRow, snapCol, valid } = BlockBlast._drag;
      if (snapRow !== null && snapCol !== null) {
        ctx.globalAlpha = valid ? 0.5 : 0.3;
        ctx.fillStyle = valid ? piece.color : '#ef4444';
        for (const [dr, dc] of piece.cells) {
          const r = snapRow + dr, c = snapCol + dc;
          if (r >= 0 && r < 8 && c >= 0 && c < 8) {
            ctx.fillRect(gridX + c * STRIDE, gridY + r * STRIDE, CELL, CELL);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Tray dividers
    ctx.fillStyle = '#27272a';
    ctx.fillRect(gridX, trayY - 6, L.gridPxW, 1);

    // Tray pieces
    for (let i = 0; i < 3; i++) {
      const piece = BlockBlast._tray[i];
      if (!piece) continue;
      if (BlockBlast._drag?.trayIdx === i) continue; // hidden while floating

      const b = bbBounds(piece);
      const piecePixW = b.cols * STRIDE - 1;
      const piecePixH = b.rows * STRIDE - 1;
      const slotCX = gridX + slotW * i + Math.floor(slotW / 2);
      const trayMidY = trayY + Math.floor(CELL * 2);
      const px = slotCX - Math.floor(piecePixW / 2);
      const py = trayMidY - Math.floor(piecePixH / 2);

      ctx.fillStyle = piece.color;
      for (const [dr, dc] of piece.cells) {
        ctx.fillRect(px + dc * STRIDE, py + dr * STRIDE, CELL, CELL);
      }
      // Highlight
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (const [dr, dc] of piece.cells) {
        ctx.fillRect(px + dc * STRIDE, py + dr * STRIDE, CELL, 3);
      }
    }

    // Floating dragged piece
    if (BlockBlast._drag) {
      const { piece, px: dragPx, py: dragPy } = BlockBlast._drag;
      const b = bbBounds(piece);
      const offX = dragPx - Math.floor(b.cols * STRIDE / 2);
      const offY = dragPy - Math.floor(b.rows * STRIDE / 2);

      ctx.globalAlpha = 0.92;
      ctx.fillStyle = piece.color;
      for (const [dr, dc] of piece.cells) {
        ctx.fillRect(offX + dc * STRIDE, offY + dr * STRIDE, CELL, CELL);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (const [dr, dc] of piece.cells) {
        ctx.fillRect(offX + dc * STRIDE, offY + dr * STRIDE, CELL, 3);
      }
      ctx.globalAlpha = 1;
    }
  },

  // ── Pointer events ───────────────────────────────────────────────────────

  _pointerPos(e) {
    const cv = document.getElementById('bb-canvas');
    if (!cv) return { px: 0, py: 0 };
    const rect = cv.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  },

  _hitTrayIdx(px, py) {
    const L = BlockBlast._layout;
    if (!L) return -1;
    const { CELL, STRIDE, gridX, trayY, slotW } = L;
    for (let i = 0; i < 3; i++) {
      const piece = BlockBlast._tray[i];
      if (!piece) continue;
      const b = bbBounds(piece);
      const piecePixW = b.cols * STRIDE - 1;
      const piecePixH = b.rows * STRIDE - 1;
      const slotCX = gridX + slotW * i + Math.floor(slotW / 2);
      const trayMidY = trayY + Math.floor(CELL * 2);
      const pieceX = slotCX - Math.floor(piecePixW / 2);
      const pieceY = trayMidY - Math.floor(piecePixH / 2);
      const HIT_PAD = 14;
      if (
        px >= pieceX - HIT_PAD && px <= pieceX + piecePixW + HIT_PAD &&
        py >= pieceY - HIT_PAD && py <= pieceY + piecePixH + HIT_PAD
      ) return i;
    }
    return -1;
  },

  _calcSnap(px, py, piece) {
    const L = BlockBlast._layout;
    if (!L) return { snapRow: null, snapCol: null };
    const { STRIDE, gridX, gridY } = L;
    const b = bbBounds(piece);
    // Center piece around pointer
    const snapCol = Math.round((px - gridX) / STRIDE - (b.cols - 1) / 2);
    const snapRow = Math.round((py - gridY) / STRIDE - (b.rows - 1) / 2);
    return { snapRow, snapCol };
  },

  _onPointerDown(e) {
    if (!BlockBlast._gameRunning || BlockBlast._gameOver) return;
    if (BlockBlast._drag) return; // already dragging
    const { px, py } = BlockBlast._pointerPos(e);
    const idx = BlockBlast._hitTrayIdx(px, py);
    if (idx === -1) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const piece = BlockBlast._tray[idx];
    const { snapRow, snapCol } = BlockBlast._calcSnap(px, py, piece);
    const valid = snapRow !== null && snapCol !== null && BlockBlast._canPlace(piece, snapRow, snapCol);
    BlockBlast._drag = { trayIdx: idx, piece, px, py, snapRow, snapCol, valid };
    BlockBlast._startRaf();
  },

  _onPointerMove(e) {
    if (!BlockBlast._drag) return;
    e.preventDefault();
    const { px, py } = BlockBlast._pointerPos(e);
    const { piece } = BlockBlast._drag;
    const { snapRow, snapCol } = BlockBlast._calcSnap(px, py, piece);
    const valid = snapRow !== null && snapCol !== null && BlockBlast._canPlace(piece, snapRow, snapCol);
    BlockBlast._drag = { ...BlockBlast._drag, px, py, snapRow, snapCol, valid };
  },

  _onPointerUp(e) {
    if (!BlockBlast._drag) return;
    const { trayIdx, snapRow, snapCol, valid } = BlockBlast._drag;
    BlockBlast._drag = null;
    if (BlockBlast._rafId) { cancelAnimationFrame(BlockBlast._rafId); BlockBlast._rafId = null; }
    if (valid && snapRow !== null && snapCol !== null) {
      BlockBlast._placePiece(trayIdx, snapRow, snapCol);
    } else {
      BlockBlast._drawGame();
    }
  },

  _onPointerCancel() {
    BlockBlast._drag = null;
    if (BlockBlast._rafId) { cancelAnimationFrame(BlockBlast._rafId); BlockBlast._rafId = null; }
    BlockBlast._drawGame();
  },

  _startRaf() {
    if (BlockBlast._rafId) return;
    const tick = () => {
      if (!BlockBlast._drag) { BlockBlast._rafId = null; return; }
      BlockBlast._drawGame();
      BlockBlast._rafId = requestAnimationFrame(tick);
    };
    BlockBlast._rafId = requestAnimationFrame(tick);
  },

  // ── Leaderboard ──────────────────────────────────────────────────────────

  async _loadLeaderboard() {
    if (BlockBlast._lbLoading) return;
    if (BlockBlast._lbCache) {
      BlockBlast._renderLeaderboard(BlockBlast._lbCache);
      return;
    }
    BlockBlast._lbLoading = true;
    const el = document.getElementById('bb-lb-rows');
    if (el) el.innerHTML = '<p class="text-zinc-500 text-sm py-10 text-center">Loading…</p>';
    try {
      const res = await fetch('/api/block-blast/leaderboard');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      BlockBlast._lbCache = data.rows || [];
      BlockBlast._renderLeaderboard(BlockBlast._lbCache);
    } catch (_) {
      const el2 = document.getElementById('bb-lb-rows');
      if (el2) el2.innerHTML = '<p class="text-red-400 text-sm py-10 text-center">Failed to load leaderboard.</p>';
    } finally {
      BlockBlast._lbLoading = false;
    }
  },

  _renderLeaderboard(rows) {
    const el = document.getElementById('bb-lb-rows');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p class="text-zinc-500 text-sm py-10 text-center">No scores yet — be the first!</p>';
      return;
    }
    const me = (typeof App !== 'undefined') ? App.user?.username : null;
    el.innerHTML = `
<table class="w-full text-sm border-collapse">
  <thead>
    <tr class="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
      <th class="pb-3 font-medium text-left w-8">#</th>
      <th class="pb-3 font-medium text-left">Player</th>
      <th class="pb-3 font-medium text-right">Score</th>
      <th class="pb-3 font-medium text-right pl-4 hidden sm:table-cell">Wallet</th>
    </tr>
  </thead>
  <tbody>
    ${rows.map(r => {
      const isMe = me && r.username === me;
      return `<tr class="${isMe ? 'bg-violet-950/30' : ''} border-b border-zinc-800/40">
        <td class="py-3 text-zinc-500 font-mono">${r.rank}</td>
        <td class="py-3 font-medium ${isMe ? 'text-violet-300' : 'text-zinc-200'}">
          ${bbEscape(r.username)}${isMe ? ' <span class="text-xs text-violet-500 font-normal ml-1">(you)</span>' : ''}
        </td>
        <td class="py-3 text-right font-mono font-bold text-amber-400">${r.score.toLocaleString()}</td>
        <td class="py-3 text-right font-mono text-zinc-600 text-xs pl-4 hidden sm:table-cell">${bbEscape(r.walletShort)}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>`;
  },
};
