// Header node pill — surfaces the embedded Usernode node's sync state in
// the SV header when the platform runs inside the Usernode app
// (app-as-SV-chrome migration, see NATIVE-BRIDGE.md).
//
// Data flow: the app pushes `usernode:node-status` CustomEvents (once per
// page load + on pill-state transitions), so the pill renders from the
// event stream; `usernode.getNodeStatus()` is only called for the initial
// value and when the detail sheet opens. No polling.
//
// Hidden entirely (empty slot) when the bridge lacks the `getNodeStatus`
// capability — desktop browsers, child-app iframes, old app builds.
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
  };

  const NodePill = {
    _status: null,
    _sheet: null,

    async init() {
      if (!window.NativeChrome) return;
      if (!(await NativeChrome.has('getNodeStatus'))) return;

      window.addEventListener('usernode:node-status', (e) => {
        NodePill._status = e.detail || null;
        NodePill._render();
        NodePill._renderSheetBody();
      });

      try {
        const snap = await window.usernode.getNodeStatus();
        // An event that arrived while we awaited wins (fresher).
        if (snap && !NodePill._status) NodePill._status = snap;
      } catch (_) { /* event stream will populate it */ }
      NodePill._render();
    },

    _styleFor(status) {
      return STATUS_STYLES[status] || STATUS_STYLES.offline;
    },

    _render() {
      const slot = document.getElementById('node-pill-slot');
      if (!slot) return;
      const s = NodePill._status;
      const style = NodePill._styleFor(s && s.status);
      slot.classList.add('mr-3');
      let btn = slot.firstElementChild;
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'node-pill';
        btn.setAttribute('aria-label', 'Node status');
        btn.addEventListener('click', () => NodePill._openSheet());
        btn.appendChild(document.createElement('span'));
        slot.appendChild(btn);
      }
      btn.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 ' +
        'rounded-full border text-xs font-medium ' + style.tone;
      const dot = btn.firstElementChild;
      dot.className = 'w-2 h-2 rounded-full shrink-0 ' + style.dot;
      btn.title = 'Node: ' + style.label;
      if (window.HeaderLayout && HeaderLayout.refresh) HeaderLayout.refresh();
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

  window.NodePill = NodePill;
  NodePill.init();
})();
