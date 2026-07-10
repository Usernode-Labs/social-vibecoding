const AppDetail = {
  app: null,
  builders: [],
  _loadId: 0,
  _outsideHandler: null,
  _keyHandler: null,

  async render(appData) {
    const content = document.getElementById('app-content');
    if (!content) return;
    const app = appData || AppView.appData;
    AppDetail.app = app || null;
    AppDetail.builders = [];
    AppDetail._paint();
    if (!app) return;

    const loadId = ++AppDetail._loadId;
    const buildersPromise = fetch(`/api/apps/${encodeURIComponent(app.slug)}/builders`)
      .then((res) => res.ok ? res.json() : { builders: [] })
      .then((data) => Array.isArray(data.builders) ? data.builders : [])
      .catch(() => []);
    const shortcutPromise = typeof Home !== 'undefined' && Home._probeShortcutSupport
      ? Home._probeShortcutSupport()
      : Promise.resolve(null);
    const [builders] = await Promise.all([buildersPromise, shortcutPromise]);
    if (loadId !== AppDetail._loadId || App.currentTab !== 'detail' || App.currentApp !== app.slug) return;
    AppDetail.builders = builders;
    AppDetail._paint();
  },

  close() {
    AppDetail._loadId++;
    AppDetail._removeOutsideHandler();
  },

  _paint() {
    const content = document.getElementById('app-content');
    if (!content) return;
    const app = AppDetail.app;
    if (!app) {
      content.innerHTML = '<div class="app-detail-state">App not found</div>';
      return;
    }
    content.innerHTML = AppDetail._pageHtml(app, AppDetail.builders);
    AppDetail._wire();
  },

  _pageHtml(app, builders) {
    const activeUsers = parseInt(app.active_users || 0, 10) || 0;
    const categoryLabel = app.category === 'game' ? 'Game'
      : app.category === 'tool' ? 'Tool'
      : '';
    const category = categoryLabel
      ? `<span class="app-category-chip is-${app.category}">${categoryLabel}</span>`
      : '';
    const tagline = app.tagline
      ? `<p class="app-detail-tagline">${detailEscape(app.tagline)}</p>`
      : '';
    const icon = typeof Home !== 'undefined' && Home.iconTileFor
      ? Home.iconTileFor(app, {
          imageClass: 'w-full h-full rounded-lg object-cover',
          emojiClass: 'text-4xl leading-none',
        })
      : { kind: 'letter', html: detailEscape((app.name || '?').charAt(0).toUpperCase()) };
    const running = app.status === 'running' && !!app.url;
    const openLabel = running ? 'Open'
      : app.status === 'creating' ? 'Spinning up...'
      : app.status === 'awaiting_secrets' ? 'Awaiting secrets'
      : app.status === 'error' ? 'Error'
      : 'Open';
    const canImprove = app.can_collaborate !== false;
    const isBuilt = !!app.is_collaborator;
    const isFavorite = isBuilt || !!app.is_favorited;
    const heartLabel = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    const favoriteTitle = isBuilt
      ? 'You build this app, so it is always in your favorites'
      : heartLabel;
    const overflowItems = AppDetail._overflowItems(app);
    const more = overflowItems.length ? `
      <div class="app-detail-more-wrap">
        <button id="app-detail-more" type="button" class="app-detail-action app-detail-action-more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="false">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h.01M12 12h.01M19 12h.01"/></svg>
        </button>
        <div id="app-detail-more-menu" class="app-detail-more-menu hidden" role="menu">
          ${overflowItems.map((item) => `<button type="button" role="menuitem" data-detail-action="${item.key}">${detailEscape(item.label)}</button>`).join('')}
        </div>
      </div>` : '';
    const builderSection = builders.length ? `
      <section class="app-detail-builders" aria-labelledby="app-detail-builders-title">
        <h2 id="app-detail-builders-title">Builders</h2>
        <div class="app-detail-builder-list" role="list">
          ${builders.map((builder) => {
            const username = String(builder.username || 'Unknown');
            const count = parseInt(builder.merged_count || 0, 10) || 0;
            const countText = count === 1 ? '1 change merged' : `${count} changes merged`;
            return `<div class="app-detail-builder" role="listitem">
              <span class="app-detail-builder-avatar" aria-hidden="true">${detailEscape(username.charAt(0).toUpperCase() || '?')}</span>
              <span class="app-detail-builder-name">${detailEscape(username)}</span>
              <span class="app-detail-builder-count">${countText}</span>
            </div>`;
          }).join('')}
        </div>
      </section>` : '';

    return `
      <div class="app-detail-scroll">
        <main class="app-detail-page">
          <section class="app-detail-identity">
            <div class="app-detail-icon" data-icon="${icon.kind}">${icon.html}</div>
            <div class="app-detail-heading-row">
              <h1>${detailEscape(app.name || app.slug)}</h1>
              ${category}
            </div>
            ${tagline}
            <p class="app-detail-active"><span>${activeUsers} active</span> People who used this app in the last 10 days</p>
          </section>

          <section class="app-detail-actions" aria-label="App actions">
            <button id="app-detail-open" type="button" class="app-detail-action app-detail-action-primary" title="${openLabel}"${running ? '' : ' disabled'}>${openLabel}</button>
            ${canImprove ? '<button id="app-detail-improve" type="button" class="app-detail-action app-detail-action-secondary">Improve</button>' : ''}
            <button id="app-detail-favorite" type="button" class="app-detail-heart${isFavorite ? ' is-active' : ''}" aria-label="${heartLabel}" title="${favoriteTitle}"${isBuilt ? ' disabled' : ''}>
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="${isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z"/></svg>
            </button>
            ${more}
          </section>

          ${builderSection}
        </main>
      </div>`;
  },

  _overflowItems(app) {
    const items = [];
    const support = typeof Home !== 'undefined' ? Home._shortcutSupport : null;
    const canShortcut = app.status === 'running'
      && typeof Home !== 'undefined'
      && Home.isYours(app)
      && support
      && support.mechanism !== 'unsupported';
    if (canShortcut) {
      items.push({
        key: 'shortcut',
        label: support.mechanism === 'widget' ? 'Add to Usernode widget' : 'Add to home screen',
      });
    }
    if (App.user?.canCreateApps && !app.self_hosted && app.repo_url) {
      items.push({ key: 'fork', label: 'Fork' });
    }
    return items;
  },

  _wire() {
    AppDetail._removeOutsideHandler();
    const app = AppDetail.app;
    if (!app) return;
    document.getElementById('app-detail-open')?.addEventListener('click', () => App.switchTab('app'));
    document.getElementById('app-detail-improve')?.addEventListener('click', () => App.switchTab('dev'));
    document.getElementById('app-detail-favorite')?.addEventListener('click', () => AppDetail._toggleFavorite());

    const moreButton = document.getElementById('app-detail-more');
    const menu = document.getElementById('app-detail-more-menu');
    if (moreButton && menu) {
      const close = () => {
        menu.classList.add('hidden');
        moreButton.setAttribute('aria-expanded', 'false');
      };
      moreButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const opening = menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !opening);
        moreButton.setAttribute('aria-expanded', String(opening));
      });
      menu.querySelectorAll('[data-detail-action]').forEach((button) => {
        button.addEventListener('click', () => {
          close();
          if (button.dataset.detailAction === 'shortcut') Home._addShortcutForApp(app);
          if (button.dataset.detailAction === 'fork') AppDetail._openForkFlow();
        });
      });
      AppDetail._outsideHandler = (event) => {
        if (!event.target.closest('.app-detail-more-wrap')) close();
      };
      AppDetail._keyHandler = (event) => {
        if (event.key === 'Escape') {
          close();
          moreButton.focus();
        }
      };
      document.addEventListener('click', AppDetail._outsideHandler);
      document.addEventListener('keydown', AppDetail._keyHandler);
    }
  },

  _removeOutsideHandler() {
    if (AppDetail._outsideHandler) {
      document.removeEventListener('click', AppDetail._outsideHandler);
      AppDetail._outsideHandler = null;
    }
    if (AppDetail._keyHandler) {
      document.removeEventListener('keydown', AppDetail._keyHandler);
      AppDetail._keyHandler = null;
    }
  },

  async _toggleFavorite() {
    const app = AppDetail.app;
    if (!app || app.is_collaborator) return;
    const next = !app.is_favorited;
    const button = document.getElementById('app-detail-favorite');
    if (button) button.disabled = true;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(app.slug)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: next }),
      });
      if (!res.ok) throw new Error('Could not update favorites');
      app.is_favorited = next;
      const cached = (Home._apps || []).find((candidate) => candidate.slug === app.slug);
      if (cached) cached.is_favorited = next;
      AppDetail._paint();
    } catch {
      if (button) button.disabled = false;
    }
  },

  _openForkFlow() {
    if (typeof AppView !== 'undefined' && AppView.promptFork && AppDetail.app) {
      AppView.promptFork({ slug: AppDetail.app.slug, name: AppDetail.app.name });
    }
  },
};

function detailEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

if (typeof window !== 'undefined') window.AppDetail = AppDetail;
if (typeof module !== 'undefined' && module.exports) module.exports = AppDetail;
