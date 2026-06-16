// Game Store screen.
// Rendered into #store-root; mounted/unmounted by App.navigateToStore()
// when the #store hash route is active. Follows the same singleton
// pattern as leaderboard.js: open() loads data, close() clears state,
// render() rebuilds the DOM.
//
// Two tabs: Browse (all games) and Library (owned games).
// Wallet gate: if App.user.usernodePubkey is null, show a locked state
// with a link to open Settings for wallet linking.

const Store = {
  tab: 'browse',
  games: [],
  library: [],
  untBalance: 0,
  isStaging: false,
  _loading: false,
  _detailGame: null,

  open() {
    Store._loading = false;
    Store.render();
    Store._load();
  },

  close() {
    Store._detailGame = null;
  },

  _setTab(t) {
    Store.tab = t;
    Store.render();
  },

  async _load() {
    if (Store._loading) return;
    Store._loading = true;
    try {
      const res = await fetch('/api/store/games');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      Store.games = data.games || [];
      Store.untBalance = data.untBalance ?? 0;
      Store.isStaging = !!data.isStaging;
    } catch (err) {
      console.warn('[store] failed to load games', err);
    }
    try {
      const res = await fetch('/api/store/library');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      Store.library = data.games || [];
    } catch (err) {
      console.warn('[store] failed to load library', err);
    }
    Store._loading = false;
    Store.render();
  },

  render() {
    const root = document.getElementById('store-root');
    if (!root) return;

    // Wallet gate
    if (!App.user?.usernodePubkey) {
      root.innerHTML = `
        <div class="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
          <div class="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center mb-4">
            <svg class="w-8 h-8 text-violet-600 dark:text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
          </div>
          <h2 class="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">Wallet required</h2>
          <p class="text-zinc-500 dark:text-zinc-400 mb-6 max-w-sm">Link your Usernode wallet to access the Game Store and pay with UNT.</p>
          <button id="store-link-wallet-btn" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-5 py-2.5 text-sm font-medium text-white transition-colors">
            Link Usernode Wallet
          </button>
        </div>
      `;
      root.querySelector('#store-link-wallet-btn')?.addEventListener('click', () => {
        if (window.Settings?.open) Settings.open();
      });
      return;
    }

    const tabs = ['browse', 'library'].map((t) => {
      const active = t === Store.tab;
      const label = t === 'browse' ? 'Browse' : 'Library';
      const cls = active
        ? 'border-violet-500 text-violet-700 dark:text-violet-300'
        : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200';
      return `<button data-store-tab="${t}" class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${cls}">${label}</button>`;
    }).join('');

    const balancePill = `
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full bg-violet-100 dark:bg-violet-900/40 px-3 py-1 text-sm font-semibold text-violet-700 dark:text-violet-300">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6l4 2"/></svg>
          Balance: ${Store.untBalance} UNT
        </span>
        ${Store.isStaging ? `<button id="store-topup-btn" class="text-xs text-violet-500 hover:text-violet-400 underline">Top up +100</button>` : ''}
      </div>
    `;

    let bodyHtml = '';
    if (Store._loading && !Store.games.length) {
      bodyHtml = `<div class="flex justify-center items-center py-16 text-zinc-400 text-sm">Loading…</div>`;
    } else if (Store.tab === 'browse') {
      bodyHtml = Store._renderBrowse();
    } else {
      bodyHtml = Store._renderLibrary();
    }

    root.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <nav class="flex border-b border-zinc-200 dark:border-zinc-800 w-auto">${tabs}</nav>
        ${balancePill}
      </div>
      <div id="store-body">${bodyHtml}</div>
      <div id="store-detail-modal" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60" style="backdrop-filter:blur(2px)"></div>
    `;

    root.querySelectorAll('[data-store-tab]').forEach((btn) => {
      btn.addEventListener('click', () => Store._setTab(btn.dataset.storeTab));
    });

    root.querySelectorAll('[data-store-game]').forEach((card) => {
      card.addEventListener('click', () => {
        const id = parseInt(card.dataset.storeGame, 10);
        const game = Store.games.find((g) => g.id === id);
        if (game) Store._openDetail(game);
      });
    });

    const topupBtn = root.querySelector('#store-topup-btn');
    if (topupBtn) {
      topupBtn.addEventListener('click', () => Store._topup());
    }
  },

  _renderBrowse() {
    if (!Store.games.length) {
      return `<p class="text-zinc-500 dark:text-zinc-400 text-sm text-center py-12">No games available yet.</p>`;
    }
    const cards = Store.games.map((g) => Store._renderCard(g)).join('');
    return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">${cards}</div>`;
  },

  _renderLibrary() {
    if (!Store.library.length) {
      return `
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <p class="text-zinc-500 dark:text-zinc-400 text-sm mb-3">No games yet — browse the Store to find something!</p>
          <button data-store-tab="browse" class="text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline">Go to Browse</button>
        </div>
      `;
    }
    const cards = Store.library.map((g) => Store._renderCard({ ...g, owned: true })).join('');
    return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">${cards}</div>`;
  },

  _renderCard(g, opts = {}) {
    const tags = (g.genre_tags || []).slice(0, 2).map((t) =>
      `<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-white/20 text-white/90">${_esc(t)}</span>`
    ).join('');

    const badge = g.owned
      ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-400">Owned</span>`
      : `<span class="text-sm font-bold text-zinc-900 dark:text-zinc-100">${g.price_unt} UNT</span>`;

    return `
      <button data-store-game="${g.id}" class="group text-left rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-violet-400 dark:hover:border-violet-600 transition-colors shadow-sm hover:shadow-md">
        <div class="h-32 flex items-end p-3 relative" style="background:linear-gradient(135deg,${g.cover_color}cc,${g.cover_color}66)">
          <div class="absolute inset-0 opacity-20" style="background:radial-gradient(circle at 30% 30%,#fff,transparent)"></div>
          <div class="relative flex gap-1 flex-wrap">${tags}</div>
        </div>
        <div class="p-3 flex items-center justify-between gap-2">
          <span class="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate flex-1">${_esc(g.title)}</span>
          ${badge}
        </div>
      </button>
    `;
  },

  _openDetail(game) {
    Store._detailGame = game;
    const modal = document.getElementById('store-detail-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    Store._renderDetail();
    modal.addEventListener('click', (e) => {
      if (e.target === modal) Store._closeDetail();
    }, { once: true });
  },

  _closeDetail() {
    const modal = document.getElementById('store-detail-modal');
    if (modal) modal.classList.add('hidden');
    Store._detailGame = null;
  },

  _renderDetail() {
    const modal = document.getElementById('store-detail-modal');
    if (!modal || !Store._detailGame) return;
    const g = Store._detailGame;

    const canBuy = !g.owned && Store.untBalance >= g.price_unt;
    const btnLabel = g.owned ? 'Owned' : Store.untBalance < g.price_unt ? 'Not enough UNT' : `Buy for ${g.price_unt} UNT`;
    const btnCls = (g.owned || Store.untBalance < g.price_unt)
      ? 'w-full rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 text-sm font-medium text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
      : 'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2.5 text-sm font-medium text-white transition-colors';

    const tags = (g.genre_tags || []).map((t) =>
      `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">${_esc(t)}</span>`
    ).join('');

    const screenshots = [1, 2, 3].map((n) =>
      `<div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 h-24 flex items-center justify-center text-xs text-zinc-400 dark:text-zinc-600 font-medium">Screenshot ${n}</div>`
    ).join('');

    modal.innerHTML = `
      <div class="w-full sm:max-w-lg bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90dvh]">
        <div class="h-44 flex items-end p-4 relative shrink-0" style="background:linear-gradient(135deg,${g.cover_color}dd,${g.cover_color}88)">
          <div class="absolute inset-0 opacity-20" style="background:radial-gradient(circle at 25% 25%,#fff,transparent)"></div>
          <button id="store-detail-close" class="absolute top-3 right-3 text-white/70 hover:text-white" aria-label="Close">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
          <h2 class="relative text-2xl font-bold text-white">${_esc(g.title)}</h2>
        </div>
        <div class="overflow-y-auto flex-1 p-4">
          <div class="flex flex-wrap gap-1.5 mb-3">${tags}</div>
          <p class="text-sm text-zinc-600 dark:text-zinc-300 mb-4 leading-relaxed">${_esc(g.description)}</p>
          <div class="grid grid-cols-3 gap-2 mb-4">${screenshots}</div>
        </div>
        <div class="p-4 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm text-zinc-500 dark:text-zinc-400">Price</span>
            <span class="font-bold text-zinc-900 dark:text-zinc-100">${g.owned ? '—' : `${g.price_unt} UNT`}</span>
          </div>
          <button id="store-buy-btn" ${g.owned || Store.untBalance < g.price_unt ? 'disabled' : ''} class="${btnCls}">${btnLabel}</button>
          ${!g.owned && Store.untBalance < g.price_unt ? `<p class="text-xs text-center text-zinc-400 mt-2">Your balance: ${Store.untBalance} UNT</p>` : ''}
        </div>
        <div id="store-buy-toast" class="hidden px-4 pb-3 text-center text-sm font-medium text-green-600 dark:text-green-400">Purchased!</div>
      </div>
    `;

    modal.querySelector('#store-detail-close')?.addEventListener('click', () => Store._closeDetail());

    const buyBtn = modal.querySelector('#store-buy-btn');
    if (buyBtn && canBuy) {
      buyBtn.addEventListener('click', () => Store._purchase(g.id));
    }
  },

  async _purchase(gameId) {
    const modal = document.getElementById('store-detail-modal');
    const buyBtn = modal?.querySelector('#store-buy-btn');
    if (buyBtn) {
      buyBtn.disabled = true;
      buyBtn.textContent = 'Buying…';
    }
    try {
      const res = await fetch('/api/store/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (buyBtn) {
          buyBtn.disabled = false;
          buyBtn.textContent = data.error || 'Failed';
        }
        return;
      }
      Store.untBalance = data.untBalance;
      // Mark game as owned in the local lists
      const idx = Store.games.findIndex((g) => g.id === gameId);
      if (idx !== -1) Store.games[idx] = { ...Store.games[idx], owned: true };
      // Re-fetch library
      try {
        const lr = await fetch('/api/store/library');
        if (lr.ok) Store.library = (await lr.json()).games || [];
      } catch {}
      // Show toast in modal before closing
      const toast = modal?.querySelector('#store-buy-toast');
      if (toast) toast.classList.remove('hidden');
      // Update detail state and re-render buy button area
      if (Store._detailGame?.id === gameId) {
        Store._detailGame = { ...Store._detailGame, owned: true };
        Store._renderDetail();
        const t2 = modal?.querySelector('#store-buy-toast');
        if (t2) t2.classList.remove('hidden');
      }
      // Refresh the balance pill in the background
      Store.render();
      // Re-open the modal since render() rebuilt the DOM
      const newModal = document.getElementById('store-detail-modal');
      if (newModal && Store._detailGame) {
        newModal.classList.remove('hidden');
        Store._renderDetail();
        const t3 = newModal?.querySelector('#store-buy-toast');
        if (t3) t3.classList.remove('hidden');
      }
    } catch (err) {
      if (buyBtn) {
        buyBtn.disabled = false;
        buyBtn.textContent = 'Error — try again';
      }
      console.warn('[store] purchase failed', err);
    }
  },

  async _topup() {
    try {
      const res = await fetch('/api/store/topup', { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      Store.untBalance = data.untBalance;
      Store.render();
    } catch (err) {
      console.warn('[store] topup failed', err);
    }
  },
};

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.Store = Store;
