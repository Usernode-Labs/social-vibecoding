// In-platform developer console for app iframes.
//
// Captures postMessage events emitted by the forwarder snippet
// (usernode-dev-console@1) embedded in each scaffolded app. Maintains
// a per-app ring buffer, tracks unseen-error counts for the header
// badge, and renders a slide-up panel on demand.
//
// Messages from frames served by other pages/iframes (ads, third-party
// widgets, etc.) are ignored via the sentinel check.

const DevConsole = {
  SENTINEL: '__usernodeDevConsole',
  MAX_ENTRIES: 500,

  entries: [],
  unseenErrors: 0,
  panelOpen: false,
  filter: 'all',
  currentAppSlug: null,

  // Store per-app so switching between apps preserves each app's log.
  byApp: new Map(),

  init() {
    window.addEventListener('message', DevConsole._onMessage);

    const btn = document.getElementById('dev-console-btn');
    if (btn) btn.addEventListener('click', DevConsole.toggle);

    // The staging overlay covers the global header (z-40) and so hides
    // the header's dev-console button. We render a twin inside the
    // overlay's chrome so the console is still reachable when previewing
    // staging; same handler, separately updated badge.
    const stagingBtn = document.getElementById('staging-dev-console-btn');
    if (stagingBtn) stagingBtn.addEventListener('click', DevConsole.toggle);

    const close = document.getElementById('dev-console-close');
    if (close) close.addEventListener('click', DevConsole.hide);

    const clear = document.getElementById('dev-console-clear');
    if (clear) clear.addEventListener('click', DevConsole.clear);

    const filter = document.getElementById('dev-console-filter');
    if (filter) {
      filter.addEventListener('change', (e) => {
        DevConsole.filter = e.target.value;
        DevConsole._rerenderLog();
      });
    }
  },

  _onMessage(event) {
    const data = event.data;
    if (!data || data.sentinel !== DevConsole.SENTINEL) return;

    const entry = {
      level: data.level || 'log',
      args: Array.isArray(data.args) ? data.args : [String(data.args)],
      ts: data.ts || Date.now(),
      url: data.url || '',
      source: data.source,
      line: data.line,
      col: data.col,
      kind: data.kind,
    };

    DevConsole._store(entry);

    if (entry.level === 'error' && !DevConsole.panelOpen) {
      DevConsole.unseenErrors++;
    }
    DevConsole._updateBadge();

    if (DevConsole.panelOpen) DevConsole._appendLogEntry(entry);
  },

  _store(entry) {
    const slug = DevConsole.currentAppSlug || '_default';
    let list = DevConsole.byApp.get(slug);
    if (!list) {
      list = [];
      DevConsole.byApp.set(slug, list);
    }
    list.push(entry);
    if (list.length > DevConsole.MAX_ENTRIES) {
      list.splice(0, list.length - DevConsole.MAX_ENTRIES);
    }
    DevConsole.entries = list;
  },

  // Swap active buffer when user navigates between apps. Note: this no
  // longer toggles the header button — visibility is driven separately by
  // setButtonVisible() so the icon only appears on views that actually
  // mount the app/staging iframe (not on group/dev chat tabs).
  setCurrentApp(slug) {
    if (DevConsole.currentAppSlug === slug) return;
    DevConsole.currentAppSlug = slug || null;
    DevConsole.entries = DevConsole.byApp.get(slug) || [];
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    if (DevConsole.panelOpen) DevConsole._rerenderLog();
    if (!slug) DevConsole.setButtonVisible(false);
  },

  // Header icon visibility. Only meaningful when there's an iframe on
  // screen — i.e. the App tab (production preview) or the staging
  // overlay. Group chat / dev chat tabs hide it.
  setButtonVisible(visible) {
    const btn = document.getElementById('dev-console-btn');
    if (!btn) return;
    const show = !!visible && !!DevConsole.currentAppSlug;
    btn.classList.toggle('hidden', !show);
    if (!show && DevConsole.panelOpen) DevConsole.hide();
  },

  toggle() {
    if (DevConsole.panelOpen) DevConsole.hide();
    else DevConsole.show();
  },

  show() {
    const panel = document.getElementById('dev-console-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    DevConsole.panelOpen = true;
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    DevConsole._rerenderLog();
  },

  hide() {
    const panel = document.getElementById('dev-console-panel');
    if (panel) panel.classList.add('hidden');
    DevConsole.panelOpen = false;
  },

  clear() {
    const slug = DevConsole.currentAppSlug || '_default';
    DevConsole.byApp.set(slug, []);
    DevConsole.entries = DevConsole.byApp.get(slug);
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    DevConsole._rerenderLog();
  },

  _updateBadge() {
    const label = DevConsole.unseenErrors > 99 ? '99+' : String(DevConsole.unseenErrors);
    const show = DevConsole.unseenErrors > 0;
    for (const id of ['dev-console-badge', 'staging-dev-console-badge']) {
      const badge = document.getElementById(id);
      if (!badge) continue;
      if (show) {
        badge.textContent = label;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  },

  _rerenderLog() {
    const container = document.getElementById('dev-console-log');
    const counts = document.getElementById('dev-console-counts');
    const empty = document.getElementById('dev-console-empty-hint');
    if (!container) return;

    container.innerHTML = '';
    const visible = DevConsole.entries.filter((e) => DevConsole.filter === 'all' || e.level === DevConsole.filter);
    for (const e of visible) container.appendChild(DevConsole._renderEntry(e));

    if (counts) {
      const by = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };
      for (const e of DevConsole.entries) by[e.level] = (by[e.level] || 0) + 1;
      counts.textContent = `${DevConsole.entries.length} total · ${by.error} err · ${by.warn} warn`;
    }

    if (empty) empty.classList.toggle('hidden', DevConsole.entries.length > 0);

    // Auto-scroll to bottom when re-rendering (e.g. new entries)
    container.scrollTop = container.scrollHeight;
  },

  _appendLogEntry(entry) {
    const container = document.getElementById('dev-console-log');
    if (!container) return;
    if (DevConsole.filter !== 'all' && DevConsole.filter !== entry.level) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    container.appendChild(DevConsole._renderEntry(entry));
    if (nearBottom) container.scrollTop = container.scrollHeight;
    const counts = document.getElementById('dev-console-counts');
    if (counts) {
      const by = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };
      for (const e of DevConsole.entries) by[e.level] = (by[e.level] || 0) + 1;
      counts.textContent = `${DevConsole.entries.length} total · ${by.error} err · ${by.warn} warn`;
    }
    const empty = document.getElementById('dev-console-empty-hint');
    if (empty) empty.classList.add('hidden');
  },

  _renderEntry(entry) {
    const row = document.createElement('div');
    row.className = 'dc-log-entry dc-log-' + entry.level;
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
    const meta = entry.source ? ` @ ${entry.source}${entry.line ? ':' + entry.line : ''}` : '';
    const text = entry.args.join(' ');
    row.innerHTML = `<span class="dc-log-time">${time}</span><span class="dc-log-level">${entry.level.toUpperCase()}</span><span class="dc-log-msg"></span>`;
    row.querySelector('.dc-log-msg').textContent = text + meta;
    return row;
  },
};

window.DevConsole = DevConsole;
document.addEventListener('DOMContentLoaded', () => DevConsole.init());
