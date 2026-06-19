// Game Store — Steam-inspired UI
// All visual theming is injected into <style id="store-steam-theme"> when
// Store.open() is called and removed on Store.close() so styles never bleed
// into other screens.

const Store = (() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let _open = false;
  let _activeTab = 'browse';   // 'browse' | 'library' | 'achievements'
  let _games = [];
  let _library = [];
  let _achievements = [];
  let _balance = 0;
  let _heroIdx = 0;
  let _heroTimer = null;
  let _activeGenre = null;
  let _selectedLibraryGame = null;
  let _promoCode = '';
  let _promoResult = null;   // { id, code, discount_pct } | null
  let _loading = false;

  // ── Steam palette (CSS custom properties injected once) ──────────────────
  const THEME_CSS = `
    #store-root {
      background: #1b2838;
      color: #c6d4df;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100%;
    }
    .st-panel   { background: #2a475e; border-radius: 6px; }
    .st-card    { background: #2a475e; border-radius: 6px; overflow: hidden;
                  transition: transform 0.15s, box-shadow 0.15s; cursor: pointer; }
    .st-card:hover { transform: translateY(-3px);
                     box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .st-btn     { background: #1a9fff; color: #fff; border: none;
                  border-radius: 3px; padding: 8px 20px; cursor: pointer;
                  font-size: 14px; font-weight: 600; transition: background 0.1s; }
    .st-btn:hover { background: #66c0f4; }
    .st-btn:disabled { background: #4a5568; color: #718096; cursor: not-allowed; }
    .st-btn-sm  { padding: 5px 14px; font-size: 12px; }
    .st-btn-ghost { background: transparent; border: 1px solid #4a6a7a;
                    color: #8f98a0; }
    .st-btn-ghost:hover { border-color: #1a9fff; color: #1a9fff; }
    .st-price   { background: #4c6b22; color: #beee11; border-radius: 3px;
                  padding: 4px 10px; font-weight: 700; font-size: 13px; }
    .st-price-free { background: #1a3a1a; color: #4caf50; }
    .st-muted   { color: #8f98a0; }
    .st-accent  { color: #1a9fff; }
    .st-genre-pill { background: #1b2838; border: 1px solid #4a6a7a;
                     color: #8f98a0; border-radius: 20px; padding: 3px 12px;
                     font-size: 12px; cursor: pointer; transition: all 0.1s; }
    .st-genre-pill.active,
    .st-genre-pill:hover { background: #1a9fff; border-color: #1a9fff; color: #fff; }
    .st-achievement { background: #1b2838; border: 1px solid #b8972f;
                      border-radius: 6px; padding: 10px 14px;
                      display: flex; align-items: center; gap: 12px; }
    .st-achievement.earned { border-color: #beee11; background: #1a2e10; }
    .st-lib-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
                  border-radius: 4px; cursor: pointer; transition: background 0.1s; }
    .st-lib-row:hover { background: #316282; }
    .st-lib-row.active { background: #316282; }
    .store-card-overlay { position: absolute; inset: 0;
                          background: linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 60%); }
    .st-tabs { display: flex; gap: 0; border-bottom: 2px solid #316282; margin-bottom: 20px; }
    .st-tab  { padding: 10px 22px; cursor: pointer; color: #8f98a0;
               border-bottom: 2px solid transparent; margin-bottom: -2px;
               font-size: 14px; font-weight: 600; transition: color 0.1s; }
    .st-tab.active { color: #c6d4df; border-bottom-color: #1a9fff; }
    .st-tab:hover  { color: #c6d4df; }
    .st-input { background: #1b2838; border: 1px solid #4a6a7a; color: #c6d4df;
                border-radius: 3px; padding: 7px 12px; font-size: 13px;
                outline: none; }
    .st-input:focus { border-color: #1a9fff; }
    .st-hero { position: relative; border-radius: 8px; overflow: hidden;
               height: 220px; margin-bottom: 20px; }
    .st-hero-bg { position: absolute; inset: 0; display: flex;
                  align-items: center; justify-content: center;
                  font-size: 80px; font-weight: 900; opacity: 0.25;
                  user-select: none; }
    .st-hero-content { position: absolute; bottom: 0; left: 0; right: 0;
                        padding: 20px; background: linear-gradient(to top, rgba(0,0,0,0.85), transparent); }
    .st-dot { width: 8px; height: 8px; border-radius: 50%; background: #4a6a7a;
               cursor: pointer; transition: background 0.1s; }
    .st-dot.active { background: #1a9fff; }
  `;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmt(n) { return Number(n).toLocaleString(); }

  function discountedPrice(game) {
    if (!_promoResult) return game.price_unt;
    return Math.max(0, Math.round(game.price_unt * (1 - _promoResult.discount_pct / 100)));
  }

  function genreList() {
    const genres = [...new Set(_games.map((g) => g.genre).filter(Boolean))].sort();
    return genres;
  }

  function filteredGames() {
    if (!_activeGenre) return _games;
    return _games.filter((g) => g.genre === _activeGenre);
  }

  function isOwned(gameId) {
    return _library.some((p) => p.game_id === gameId);
  }

  // ── Style injection ───────────────────────────────────────────────────────
  function _injectTheme() {
    if (document.getElementById('store-steam-theme')) return;
    const el = document.createElement('style');
    el.id = 'store-steam-theme';
    el.textContent = THEME_CSS;
    document.head.appendChild(el);
  }

  function _removeTheme() {
    document.getElementById('store-steam-theme')?.remove();
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function _loadAll() {
    _loading = true;
    _render();
    try {
      const [gRes, lRes, aRes] = await Promise.all([
        fetch('/api/store/games'),
        fetch('/api/store/library'),
        fetch('/api/store/achievements'),
      ]);
      if (gRes.ok) {
        const d = await gRes.json();
        _games = d.games || [];
      }
      if (lRes.ok) {
        const d = await lRes.json();
        _library = d.library || [];
        _balance = d.balance ?? 0;
      }
      if (aRes.ok) {
        const d = await aRes.json();
        _achievements = d.achievements || [];
      }
    } catch {}
    _loading = false;
    _render();
    _startHeroTimer();
  }

  // ── Hero carousel ─────────────────────────────────────────────────────────
  function _startHeroTimer() {
    _stopHeroTimer();
    if (_games.length < 2) return;
    _heroTimer = setInterval(() => {
      _heroIdx = (_heroIdx + 1) % Math.min(_games.length, 5);
      _renderHero();
    }, 5000);
  }

  function _stopHeroTimer() {
    if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  }

  // ── Purchase flow ─────────────────────────────────────────────────────────
  async function _purchase(gameId) {
    const btn = document.querySelector(`[data-buy="${gameId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Purchasing…'; }
    try {
      const body = { game_id: gameId };
      if (_promoResult) body.promo_code = _promoResult.code;
      const res = await fetch('/api/store/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        _showToast(data.error || 'Purchase failed', 'error');
        return;
      }
      _balance = data.new_balance;
      _promoResult = null;
      _promoCode = '';
      // Add to library optimistically
      const game = _games.find((g) => g.id === gameId);
      if (game) _library.unshift({ ...game, game_id: game.id, price_paid: data.price_paid, purchased_at: new Date().toISOString() });

      if (data.new_achievements?.length) {
        _achievements = _achievements.map((a) => {
          const earned = data.new_achievements.find((na) => na.slug === a.slug);
          return earned ? { ...a, earned_at: earned.earned_at } : a;
        });
        _showToast(`🏆 Achievement unlocked: ${data.new_achievements.map((a) => a.name).join(', ')}`, 'success');
      } else {
        _showToast('Game added to library!', 'success');
      }
      _render();
    } catch {
      _showToast('Network error', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add to Library'; }
    }
  }

  async function _validatePromo() {
    const code = _promoCode.trim().toUpperCase();
    if (!code) return;
    const btn = document.getElementById('st-promo-apply');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const res = await fetch(`/api/store/promo/validate?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (res.ok && data.promo) {
        _promoResult = data.promo;
        _renderBrowse();
        _showToast(`Promo applied: ${data.promo.discount_pct}% off!`, 'success');
      } else {
        _promoResult = null;
        _showToast(data.error || 'Invalid code', 'error');
      }
    } catch {
      _showToast('Network error', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
    }
  }

  async function _recordPlay(gameId) {
    try {
      await fetch(`/api/store/games/${gameId}/play`, { method: 'POST' });
      const idx = _library.findIndex((p) => p.game_id === gameId);
      if (idx !== -1) _library[idx].last_played_at = new Date().toISOString();
    } catch {}
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function _showToast(msg, type = 'info') {
    const root = document.getElementById('store-root');
    if (!root) return;
    const toast = document.createElement('div');
    toast.textContent = msg;
    const bg = type === 'error' ? '#c0392b' : type === 'success' ? '#1a5c1a' : '#1e3a5f';
    toast.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:${bg};color:#fff;padding:10px 20px;border-radius:6px;font-size:14px;
      z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.5);max-width:90vw;text-align:center;`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function _render() {
    const root = document.getElementById('store-root');
    if (!root) return;
    if (_loading) {
      root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:200px;color:#8f98a0;">Loading store…</div>`;
      return;
    }
    root.innerHTML = `
      <div style="max-width:1100px;margin:0 auto;padding:20px 16px;">
        ${_renderHeader()}
        ${_renderTabs()}
        <div id="st-tab-content"></div>
      </div>`;
    _renderTabContent();
    _bindEvents();
  }

  function _renderHeader() {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-size:22px;font-weight:700;color:#c6d4df;">🎮 Game Store</div>
          <div class="st-muted" style="font-size:13px;margin-top:2px;">Spend your UNT on great games</div>
        </div>
        <div class="st-panel" style="padding:10px 18px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">💰</span>
          <div>
            <div style="font-size:13px;font-weight:700;color:#beee11;">${fmt(_balance)} UNT</div>
            <div class="st-muted" style="font-size:11px;">Your balance</div>
          </div>
        </div>
      </div>`;
  }

  function _renderTabs() {
    const tabs = [
      { id: 'browse',       label: 'Browse' },
      { id: 'library',      label: `Library (${_library.length})` },
      { id: 'achievements', label: `Achievements (${_achievements.filter((a) => a.earned_at).length}/${_achievements.length})` },
    ];
    return `<div class="st-tabs">${tabs.map((t) => `
      <div class="st-tab${_activeTab === t.id ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</div>
    `).join('')}</div>`;
  }

  function _renderTabContent() {
    const el = document.getElementById('st-tab-content');
    if (!el) return;
    if (_activeTab === 'browse')       { el.innerHTML = _getBrowseHTML();       _bindBrowseEvents(); }
    else if (_activeTab === 'library') { el.innerHTML = _getLibraryHTML();       _bindLibraryEvents(); }
    else                               { el.innerHTML = _getAchievementsHTML();  }
  }

  // ── Browse tab ────────────────────────────────────────────────────────────
  function _getBrowseHTML() {
    const games = _games;
    if (!games.length) return `<div class="st-muted" style="padding:40px;text-align:center;">No games available yet.</div>`;

    const heroGames = games.slice(0, 5);
    const heroGame = heroGames[_heroIdx % heroGames.length];

    const heroHTML = heroGame ? `
      <div class="st-hero" style="background:${heroGame.cover_color}20;border:1px solid ${heroGame.cover_color}40;" id="st-hero">
        <div class="st-hero-bg">${esc(heroGame.name[0])}</div>
        <div class="store-card-overlay"></div>
        <div class="st-hero-content">
          <div style="font-size:20px;font-weight:700;margin-bottom:4px;">${esc(heroGame.name)}</div>
          <div class="st-muted" style="font-size:13px;margin-bottom:10px;">${esc(heroGame.description || '')}</div>
          <div style="display:flex;align-items:center;gap:10px;">
            ${_priceTag(heroGame)}
            ${isOwned(heroGame.id)
              ? `<span style="color:#4caf50;font-size:13px;">✓ In Library</span>`
              : `<button class="st-btn st-btn-sm" data-buy="${heroGame.id}">Add to Library</button>`}
          </div>
        </div>
        <div style="position:absolute;bottom:12px;right:16px;display:flex;gap:6px;">
          ${heroGames.map((_, i) => `<div class="st-dot${i === _heroIdx % heroGames.length ? ' active' : ''}" data-hero-dot="${i}"></div>`).join('')}
        </div>
      </div>` : '';

    const genrePills = genreList().map((g) =>
      `<div class="st-genre-pill${_activeGenre === g ? ' active' : ''}" data-genre="${esc(g)}">${esc(g)}</div>`
    ).join('');

    const promoSection = `
      <div class="st-panel" style="padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:13px;color:#8f98a0;">Promo code:</span>
        <input id="st-promo-input" class="st-input" style="width:160px;" placeholder="LAUNCH20"
               value="${esc(_promoCode)}" maxlength="32">
        <button id="st-promo-apply" class="st-btn st-btn-sm">Apply</button>
        ${_promoResult
          ? `<span style="color:#beee11;font-size:13px;">✓ ${esc(_promoResult.code)} — ${_promoResult.discount_pct}% off
             <button id="st-promo-remove" style="background:none;border:none;color:#8f98a0;cursor:pointer;margin-left:4px;">✕</button>
             </span>`
          : ''}
      </div>`;

    const filtered = filteredGames();
    const grid = filtered.map((g) => _gameCardHTML(g)).join('');

    return `
      ${heroHTML}
      <div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <div class="st-genre-pill${!_activeGenre ? ' active' : ''}" data-genre="">All</div>
        ${genrePills}
      </div>
      ${promoSection}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;">
        ${grid || '<div class="st-muted" style="grid-column:1/-1;padding:30px;text-align:center;">No games in this genre.</div>'}
      </div>`;
  }

  function _gameCardHTML(g) {
    const owned = isOwned(g.id);
    const price = discountedPrice(g);
    const original = g.price_unt;
    const hasDiscount = _promoResult && price !== original;
    return `
      <div class="st-card" style="position:relative;" data-game-id="${g.id}">
        <div style="height:120px;background:${g.cover_color}30;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:900;color:${g.cover_color};border-bottom:2px solid ${g.cover_color}40;">
          ${esc(g.name[0])}
        </div>
        <div style="padding:10px 12px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(g.name)}</div>
          ${g.genre ? `<div class="st-muted" style="font-size:11px;margin-bottom:8px;">${esc(g.genre)}</div>` : '<div style="margin-bottom:8px;"></div>'}
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
            <div style="display:flex;align-items:center;gap:6px;">
              ${hasDiscount ? `<span style="text-decoration:line-through;color:#8f98a0;font-size:11px;">${original} UNT</span>` : ''}
              <span class="st-price${price === 0 ? ' st-price-free' : ''}">${price === 0 ? 'Free' : `${price} UNT`}</span>
            </div>
            ${owned
              ? `<span style="color:#4caf50;font-size:12px;font-weight:600;">✓ Owned</span>`
              : `<button class="st-btn st-btn-sm" data-buy="${g.id}">Buy</button>`}
          </div>
        </div>
      </div>`;
  }

  function _priceTag(g) {
    const price = discountedPrice(g);
    return `<span class="st-price${price === 0 ? ' st-price-free' : ''}">${price === 0 ? 'Free' : `${price} UNT`}</span>`;
  }

  function _renderBrowse() {
    const el = document.getElementById('st-tab-content');
    if (!el || _activeTab !== 'browse') return;
    el.innerHTML = _getBrowseHTML();
    _bindBrowseEvents();
  }

  function _renderHero() {
    const hero = document.getElementById('st-hero');
    if (!hero) return;
    // Re-render just the browse tab to update hero
    _renderBrowse();
  }

  function _bindBrowseEvents() {
    document.querySelectorAll('[data-genre]').forEach((el) => {
      el.addEventListener('click', () => {
        _activeGenre = el.dataset.genre || null;
        _renderBrowse();
      });
    });

    document.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _purchase(parseInt(btn.dataset.buy));
      });
    });

    document.querySelectorAll('[data-hero-dot]').forEach((dot) => {
      dot.addEventListener('click', () => {
        _heroIdx = parseInt(dot.dataset.heroDot);
        _stopHeroTimer();
        _renderBrowse();
        _startHeroTimer();
      });
    });

    const promoInput = document.getElementById('st-promo-input');
    if (promoInput) {
      promoInput.addEventListener('input', (e) => { _promoCode = e.target.value; });
      promoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _validatePromo(); });
    }
    document.getElementById('st-promo-apply')?.addEventListener('click', _validatePromo);
    document.getElementById('st-promo-remove')?.addEventListener('click', () => {
      _promoResult = null; _promoCode = ''; _renderBrowse();
    });
  }

  // ── Library tab ───────────────────────────────────────────────────────────
  function _getLibraryHTML() {
    if (!_library.length) {
      return `<div class="st-muted" style="padding:60px;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">🎮</div>
        <div style="font-size:16px;margin-bottom:8px;">Your library is empty</div>
        <div style="font-size:13px;">Browse and purchase games to get started.</div>
      </div>`;
    }

    const sidebar = `
      <div style="width:220px;flex-shrink:0;">
        <div style="font-size:12px;font-weight:700;color:#8f98a0;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Your Games</div>
        ${_library.map((p) => `
          <div class="st-lib-row${_selectedLibraryGame?.game_id === p.game_id ? ' active' : ''}" data-lib-game="${p.game_id}">
            <div style="width:36px;height:36px;border-radius:4px;background:${p.cover_color}30;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:${p.cover_color};flex-shrink:0;">
              ${esc(p.name[0])}
            </div>
            <div style="overflow:hidden;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</div>
              ${p.last_played_at
                ? `<div class="st-muted" style="font-size:11px;">Played ${_relDate(p.last_played_at)}</div>`
                : `<div class="st-muted" style="font-size:11px;">Never played</div>`}
            </div>
          </div>`).join('')}
      </div>`;

    const detail = _selectedLibraryGame
      ? _gameDetailHTML(_selectedLibraryGame)
      : `<div class="st-muted" style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;">
          <div style="font-size:48px;">👆</div>
          <div>Select a game to view details</div>
        </div>`;

    return `<div style="display:flex;gap:20px;align-items:flex-start;">${sidebar}<div style="flex:1;">${detail}</div></div>`;
  }

  function _gameDetailHTML(purchase) {
    return `
      <div class="st-panel" style="padding:24px;">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
          <div style="width:80px;height:80px;border-radius:8px;background:${purchase.cover_color}30;
               display:flex;align-items:center;justify-content:center;font-size:36px;
               font-weight:900;color:${purchase.cover_color};border:2px solid ${purchase.cover_color}40;">
            ${esc(purchase.name[0])}
          </div>
          <div>
            <div style="font-size:20px;font-weight:700;">${esc(purchase.name)}</div>
            ${purchase.genre ? `<div class="st-muted" style="font-size:13px;margin-top:2px;">${esc(purchase.genre)}</div>` : ''}
            <div style="font-size:12px;color:#8f98a0;margin-top:4px;">Purchased for ${purchase.price_paid} UNT</div>
          </div>
        </div>
        ${purchase.description ? `<div style="font-size:14px;color:#8f98a0;margin-bottom:20px;line-height:1.5;">${esc(purchase.description)}</div>` : ''}
        <div style="display:flex;gap:10px;">
          <button class="st-btn" data-play="${purchase.game_id}">▶ Play</button>
        </div>
        ${purchase.last_played_at
          ? `<div class="st-muted" style="font-size:12px;margin-top:12px;">Last played: ${new Date(purchase.last_played_at).toLocaleDateString()}</div>`
          : ''}
      </div>`;
  }

  function _bindLibraryEvents() {
    document.querySelectorAll('[data-lib-game]').forEach((el) => {
      el.addEventListener('click', () => {
        const gameId = parseInt(el.dataset.libGame);
        _selectedLibraryGame = _library.find((p) => p.game_id === gameId) || null;
        const el2 = document.getElementById('st-tab-content');
        if (el2) { el2.innerHTML = _getLibraryHTML(); _bindLibraryEvents(); }
      });
    });

    document.querySelectorAll('[data-play]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gameId = parseInt(btn.dataset.play);
        _recordPlay(gameId);
        _showToast('Starting game… 🎮', 'info');
      });
    });
  }

  // ── Achievements tab ──────────────────────────────────────────────────────
  function _getAchievementsHTML() {
    if (!_achievements.length) {
      return `<div class="st-muted" style="padding:40px;text-align:center;">No achievements available yet.</div>`;
    }
    const earned = _achievements.filter((a) => a.earned_at);
    const unearned = _achievements.filter((a) => !a.earned_at);

    const section = (title, list, fade) => list.length ? `
      <div style="font-size:13px;font-weight:700;color:#8f98a0;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">${title}</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px;">
        ${list.map((a) => `
          <div class="st-achievement${a.earned_at ? ' earned' : ''}" style="${fade ? 'opacity:0.5;' : ''}">
            <div style="font-size:28px;flex-shrink:0;">${a.icon || '🏆'}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:700;">${esc(a.name)}</div>
              <div class="st-muted" style="font-size:12px;">${esc(a.description || '')}</div>
              ${a.earned_at ? `<div style="font-size:11px;color:#beee11;margin-top:2px;">Earned ${_relDate(a.earned_at)}</div>` : ''}
            </div>
            ${a.earned_at ? `<div style="color:#beee11;font-size:18px;">✓</div>` : `<div style="color:#4a6a7a;font-size:18px;">🔒</div>`}
          </div>`).join('')}
      </div>` : '';

    return `
      <div style="max-width:700px;">
        <div class="st-panel" style="padding:12px 18px;margin-bottom:20px;display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">🏆</span>
          <div>
            <div style="font-weight:700;">${earned.length} / ${_achievements.length} achievements</div>
            <div style="width:200px;height:6px;background:#1b2838;border-radius:3px;margin-top:4px;overflow:hidden;">
              <div style="height:100%;background:#beee11;border-radius:3px;width:${_achievements.length ? Math.round(earned.length / _achievements.length * 100) : 0}%;"></div>
            </div>
          </div>
        </div>
        ${section('Earned', earned, false)}
        ${section('Locked', unearned, true)}
      </div>`;
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function _relDate(iso) {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  function _bindEvents() {
    document.querySelectorAll('.st-tab[data-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        _activeTab = el.dataset.tab;
        _render();
      });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function open() {
    if (_open) return;
    _open = true;
    _injectTheme();
    _loadAll();
  }

  function close() {
    _open = false;
    _stopHeroTimer();
    _removeTheme();
    const root = document.getElementById('store-root');
    if (root) root.innerHTML = '';
  }

  return { open, close };
})();

window.Store = Store;
