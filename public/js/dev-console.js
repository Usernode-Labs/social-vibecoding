// In-platform developer console for app iframes.
//
// Captures postMessage events emitted by the forwarder snippet
// (usernode-dev-console@1) embedded in each scaffolded app. Maintains
// a per-app ring buffer, tracks unseen-error counts for the header
// badge, and renders a slide-up panel on demand.
//
// Messages from frames served by other pages/iframes (ads, third-party
// widgets, etc.) are ignored via the sentinel check.
//
// Header-icon visibility: by default the icon is hidden until the
// current app actually logs an error, so the header stays clean for
// the common case where a working app produces no errors. Users who
// want it visible all the time can flip the "always show" toggle in
// Settings — that's persisted in localStorage as a UI preference.

const DevConsole = {
  SENTINEL: '__usernodeDevConsole',
  MAX_ENTRIES: 500,

  // Visibility mode. Persisted across reloads via localStorage so users
  // don't have to re-set it every session. Only flipped by the toggle
  // in Settings (Settings.js) — there's no other UI for it.
  MODE_KEY: 'usernode:devConsoleMode',
  MODE_ERRORS_ONLY: 'errors-only',
  MODE_ALWAYS: 'always',

  entries: [],
  unseenErrors: 0,
  panelOpen: false,
  filter: 'all',
  currentAppSlug: null,
  // Tracks whether an app iframe is currently mounted (production App
  // tab or staging overlay). Set by setButtonVisible() — see comment on
  // that method for why the public name lies a little.
  iframeVisible: false,
  mode: 'errors-only',

  // Store per-app so switching between apps preserves each app's log.
  byApp: new Map(),

  init() {
    DevConsole.mode = DevConsole._loadMode();

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

    // Apply the initial mode to both buttons in case markup ships with
    // them visible (e.g. the staging twin has no `hidden` class).
    DevConsole._refreshButtonVisibility();
  },

  _loadMode() {
    try {
      return window.localStorage.getItem(DevConsole.MODE_KEY) === DevConsole.MODE_ALWAYS
        ? DevConsole.MODE_ALWAYS
        : DevConsole.MODE_ERRORS_ONLY;
    } catch {
      return DevConsole.MODE_ERRORS_ONLY;
    }
  },

  // Public API for Settings. Pass MODE_ERRORS_ONLY (default) or
  // MODE_ALWAYS. Anything else is normalised to errors-only — guards
  // against truthy-string bugs from older callers.
  setMode(mode) {
    const next = mode === DevConsole.MODE_ALWAYS
      ? DevConsole.MODE_ALWAYS
      : DevConsole.MODE_ERRORS_ONLY;
    DevConsole.mode = next;
    try { window.localStorage.setItem(DevConsole.MODE_KEY, next); } catch {}
    DevConsole._refreshButtonVisibility();
  },

  getMode() {
    return DevConsole.mode;
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
    // An incoming error in errors-only mode may need to flip the icon
    // from hidden to visible. Cheap to re-evaluate on every message;
    // the underlying classList.toggle is idempotent.
    if (entry.level === 'error') DevConsole._refreshButtonVisibility();

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

  // Swap active buffer when user navigates between apps. The header
  // icon's visibility is driven by setButtonVisible() (iframe context)
  // and the resolved mode/error state — see _refreshButtonVisibility().
  setCurrentApp(slug) {
    if (DevConsole.currentAppSlug === slug) return;
    DevConsole.currentAppSlug = slug || null;
    DevConsole.entries = DevConsole.byApp.get(slug) || [];
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    if (DevConsole.panelOpen) DevConsole._rerenderLog();
    if (!slug) {
      DevConsole.setButtonVisible(false);
    } else {
      // Different app's error buffer -> recompute visibility. A user
      // switching from an error-laden app to a clean one should see
      // the icon disappear (in errors-only mode).
      DevConsole._refreshButtonVisibility();
    }
  },

  // Signal that an app iframe is/isn't on screen. The name is a little
  // misleading — it doesn't directly toggle the button, just records
  // the iframe context. The actual icon visibility falls out of mode +
  // error state via _refreshButtonVisibility(). Public name kept for
  // backward compat with existing callers in app.js / app-view.js.
  setButtonVisible(visible) {
    DevConsole.iframeVisible = !!visible;
    DevConsole._refreshButtonVisibility();
  },

  // Resolve final visibility from all inputs. Cheap (a couple of class
  // toggles + a small linear scan over the current app's buffer); safe
  // to call from any state-changing method.
  _refreshButtonVisibility() {
    const inIframeContext = DevConsole.iframeVisible && !!DevConsole.currentAppSlug;
    // Errors-only mode hides the icon until the current app's buffer
    // contains at least one error. We also keep it visible while the
    // panel itself is open so the user has a stable focus point even
    // after Clear empties the buffer.
    const hasErrors = DevConsole.entries.some(e => e.level === 'error');
    const show = inIframeContext
      && (DevConsole.mode === DevConsole.MODE_ALWAYS
          || hasErrors
          || DevConsole.panelOpen);

    const btn = document.getElementById('dev-console-btn');
    const stagingBtn = document.getElementById('staging-dev-console-btn');
    if (btn) btn.classList.toggle('hidden', !show);
    if (stagingBtn) stagingBtn.classList.toggle('hidden', !show);

    if (!show && DevConsole.panelOpen) DevConsole.hide();
  },

  toggle() {
    if (DevConsole.panelOpen) DevConsole.hide();
    else DevConsole.show();
  },

  _sheet: null,

  show() {
    const panel = document.getElementById('dev-console-panel');
    if (!panel) return;
    // Touch platforms: the console rides in a draggable kit bottom
    // sheet (it was already a slide-up panel in spirit). Desktop keeps
    // the fixed bottom panel below.
    if (PlatformUI.isTouch() && !DevConsole._sheet) {
      panel.classList.remove('hidden');
      panel.classList.add('platform-sheet-adopted');
      // Render BEFORE presenting — the kit sheet measures its height
      // once at present time to seed the slide-up spring (see the
      // matching note in notifications.js show()).
      DevConsole._rerenderLog();
      const sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => {
          panel.classList.remove('platform-sheet-adopted');
          panel.classList.add('hidden');
          document.body.appendChild(panel);
          DevConsole._sheet = null;
          DevConsole.panelOpen = false;
          DevConsole._refreshButtonVisibility();
        },
      });
      if (sheet) {
        DevConsole._sheet = sheet;
        DevConsole.panelOpen = true;
        DevConsole.unseenErrors = 0;
        DevConsole._updateBadge();
        DevConsole._refreshButtonVisibility();
        return;
      }
      panel.classList.remove('platform-sheet-adopted');
    }
    panel.classList.remove('hidden');
    DevConsole.panelOpen = true;
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    DevConsole._rerenderLog();
    DevConsole._refreshButtonVisibility();
  },

  hide() {
    if (DevConsole._sheet) {
      DevConsole._sheet.dismiss();
      return;
    }
    const panel = document.getElementById('dev-console-panel');
    if (panel) panel.classList.add('hidden');
    DevConsole.panelOpen = false;
    // Closing the panel may take us back to the "no errors, errors-only
    // mode" state — re-evaluate so the icon disappears if appropriate.
    DevConsole._refreshButtonVisibility();
  },

  clear() {
    const slug = DevConsole.currentAppSlug || '_default';
    DevConsole.byApp.set(slug, []);
    DevConsole.entries = DevConsole.byApp.get(slug);
    DevConsole.unseenErrors = 0;
    DevConsole._updateBadge();
    DevConsole._rerenderLog();
    DevConsole._refreshButtonVisibility();
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
