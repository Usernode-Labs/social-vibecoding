// MOVED in #1079 chunk B. This file was public/js/node-pill.js;
// #header-menu-panel became a React island and this module owns nodes inside
// it, so it moved into the bundle with the region it writes to. Its legacy
// window publication and layout-effect init seam remain load-bearing.
//
// Node status row (top of the hamburger drawer) — surfaces the embedded
// Usernode node's sync state when the platform runs inside the Usernode
// app (app-as-SV-chrome migration, see NATIVE-BRIDGE.md). Lived in the
// header as a pill originally; moved into the drawer to keep the header
// uncluttered.
//
// Data flow: the app pushes `usernode:node-status` CustomEvents (once through
// the explicit realm-readiness replay + on pill-state transitions), so the row
// renders from the event stream; `usernode.getNodeStatus()` is only called for
// the initial value and when the detail sheet opens. No polling.
//
// The row is present for every native top frame, even while capabilities or
// node state are unavailable. Desktop browsers and child-app iframes keep it
// hidden. A temporary bridge/provisioning problem must not rewrite navigation.
(function () {
  'use strict';

  // status → { dot color, label, pill tone } — statuses come from the
  // app's chrome-level provider: synced | syncing | connecting | offline.
  const STATUS_STYLES = {
    synced: {
      dot: 'bg-emerald-500',
      label: 'Synced',
      tone: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
    },
    syncing: {
      dot: 'bg-amber-500',
      label: 'Syncing',
      tone: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    },
    connecting: {
      dot: 'bg-zinc-400 animate-pulse',
      label: 'Connecting',
      tone: 'border-zinc-400/40 text-zinc-500 dark:text-zinc-400',
    },
    offline: {
      dot: 'bg-red-500',
      label: 'Offline',
      tone: 'border-red-500/40 text-red-600 dark:text-red-400',
    },
    unavailable: {
      dot: 'bg-zinc-400',
      label: 'Unavailable',
      tone: 'border-zinc-400/40 text-zinc-500 dark:text-zinc-400',
    },
  };

  const NodePill = {
    _status: null,
    _sheet: null,

    async init() {
      if (!window.NativeChrome || !window.usernode ||
          window.usernode.isNative !== true) return;

      const row = document.getElementById('drawer-row-node');
      if (row) {
        row.classList.remove('hidden');
        row.addEventListener('click', () => {
          // #977: the sheet is a second surface, so it waits for the
          // drawer to be fully gone — one motion at a time, instead of
          // a sheet rising while the drawer is still sliding out.
          // close() resolves immediately when nothing is open, and the
          // guard keeps the sheet working with no HeaderMenu at all.
          const closed = (window.App && App.HeaderMenu && App.HeaderMenu.close)
            ? App.HeaderMenu.close()
            : null;
          Promise.resolve(closed).then(() => NodePill._openSheet());
        });
      }

      // Wire this BEFORE the asynchronous capability probe. The native app
      // pushes this event through the readiness replay, so it is independent
      // positive proof that node status is supported and rescues a transient /
      // degraded first probe instead of leaving the row hidden for the realm.
      window.addEventListener('usernode:node-status', (e) => {
        const status = e && e.detail;
        if (!status || typeof status.status !== 'string') return;
        if (row) row.classList.remove('hidden');
        NodePill._status = status;
        NodePill._render();
        NodePill._renderSheetBody();
      });

      if (!(await NativeChrome.has('getNodeStatus'))) {
        NodePill._render();
        return;
      }

      try {
        const snap = await window.usernode.getNodeStatus();
        // An event that arrived while we awaited wins (fresher).
        if (snap && !NodePill._status) NodePill._status = snap;
      } catch (_) { /* event stream will populate it */ }
      NodePill._render();
    },

    _styleFor(status) {
      return STATUS_STYLES[status] || STATUS_STYLES.unavailable;
    },

    _render() {
      const dot = document.getElementById('drawer-node-dot');
      const statusEl = document.getElementById('drawer-node-status');
      if (!dot || !statusEl) return;
      const s = NodePill._status;
      const style = NodePill._styleFor(s && s.status);
      dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 ' + style.dot;
      statusEl.textContent = style.label;
      statusEl.className = 'ml-auto text-xs font-medium ' +
        style.tone.split(' ').filter((c) => !c.startsWith('border')).join(' ');
    },

    // -- detail sheet ---------------------------------------------------

    _sheetRow(label, value) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-2 border-b ' +
        'border-zinc-100 dark:border-zinc-800 text-sm';
      const l = document.createElement('span');
      l.className = 'text-zinc-500 dark:text-zinc-400';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'font-medium text-zinc-800 dark:text-zinc-100';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      return row;
    },

    _renderSheetBody() {
      const body = document.getElementById('node-pill-sheet-body');
      if (!body) return;
      const s = NodePill._status || {};
      const style = NodePill._styleFor(s.status);
      body.textContent = '';

      const statusLine = document.createElement('div');
      statusLine.className = 'flex items-center gap-2 mb-2';
      const dot = document.createElement('span');
      dot.className = 'w-2.5 h-2.5 rounded-full ' + style.dot;
      const label = document.createElement('span');
      label.className = 'text-base font-semibold';
      label.textContent = style.label;
      statusLine.appendChild(dot);
      statusLine.appendChild(label);
      body.appendChild(statusLine);

      const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
      body.appendChild(NodePill._sheetRow('Your block height',
        fmt(s.localBestHeight)));
      body.appendChild(NodePill._sheetRow('Network block height',
        fmt(s.networkBestHeight)));
      body.appendChild(NodePill._sheetRow('Peers',
        s.connectedPeers == null
          ? '—'
          : `${fmt(s.connectedPeers)} connected` +
            (s.totalPeers != null ? ` / ${fmt(s.totalPeers)} known` : '')));
    },

    async _openSheet() {
      if (NodePill._sheet) return;

      const panel = document.createElement('div');
      panel.className = 'px-4 pb-4';
      const title = document.createElement('div');
      title.className = 'text-lg font-bold py-3';
      title.textContent = 'Node';
      panel.appendChild(title);
      const bodyEl = document.createElement('div');
      bodyEl.id = 'node-pill-sheet-body';
      panel.appendChild(bodyEl);

      NodePill._sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => { NodePill._sheet = null; },
      });
      NodePill._renderSheetBody();

      // Refresh heights/peers on open — pill events only fire on state
      // transitions, so the numbers can be stale between flips.
      try {
        const snap = await window.usernode.getNodeStatus();
        if (snap) {
          NodePill._status = snap;
          NodePill._render();
          NodePill._renderSheetBody();
        }
      } catch (_) { /* keep the last snapshot */ }
    },
  };

  // Published for the legacy callers that still reach for it by name, exactly
  // as before. init() is NOT called here any more: this module now evaluates
  // while the bundle is being imported, i.e. BEFORE hydration, and its init
  // removes `hidden` from #drawer-row-node — a class React is about to hydrate
  // against. The island calls it from a layout effect instead (see
  // features/header/header-menu.tsx), which is still before DOMContentLoaded.
  // `typeof window` guard: the shell's markup is PRERENDERED in Node
  // (frontend/scripts/build-shell.mjs), which imports this island's module
  // graph. Same guard as features/notifications/notifications.js.
  if (typeof window !== 'undefined') window.NodePill = NodePill;
})();
