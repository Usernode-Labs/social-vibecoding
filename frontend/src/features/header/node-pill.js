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
import { nodePillStore, NODE_PILL_EMPTY } from './node-pill-store';
import { mountNodeSheet, unmountNodeSheet } from './node-pill-sheet';

(function () {
  'use strict';

  // The status → dot/label/ink table moved to ./node-pill-row.tsx. It was a
  // `tone` string carrying a border colour AND an ink, with the border stripped
  // at runtime by a `.filter()` — a computed class name, which Tailwind's
  // extractor cannot see. It is two complete literals there.

  const NodePill = {
    _status: null,
    _sheet: null,
    // Was `hidden` on the row element. It is the model's now, and the
    // component renders the class — see ./node-pill-row.tsx.
    _visible: false,

    // #977: the sheet is a second surface, so it waits for the drawer to be
    // fully gone — one motion at a time, instead of a sheet rising while the
    // drawer is still sliding out. close() resolves immediately when nothing
    // is open, and the guard keeps the sheet working with no HeaderMenu at
    // all. This was an addEventListener on the row; it is the component's
    // onClick now, dispatching here by name.
    openFromRow() {
      const closed = (window.App && App.HeaderMenu && App.HeaderMenu.close)
        ? App.HeaderMenu.close()
        : null;
      Promise.resolve(closed).then(() => NodePill._openSheet());
    },

    async init() {
      if (!window.NativeChrome || !window.usernode ||
          window.usernode.isNative !== true) return;

      // The row is present for every native top frame — capabilities and node
      // state affect its CONTENTS, never the navigation structure — so this
      // flips before the capability probe and never flips back.
      NodePill._visible = true;
      NodePill._render();

      // Wire this BEFORE the asynchronous capability probe. The native app
      // pushes this event through the readiness replay, so it is independent
      // positive proof that node status is supported and rescues a transient /
      // degraded first probe instead of leaving the row hidden for the realm.
      window.addEventListener('usernode:node-status', (e) => {
        const status = e && e.detail;
        if (!status || typeof status.status !== 'string') return;
        NodePill._visible = true;
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

    // Five writes across two elements — the dot's class, the label's text and
    // the label's class — become one publish. The row and the sheet read the
    // same model, so they cannot disagree for a frame.
    _render() {
      const s = NodePill._status || {};
      nodePillStore.set({
        visible: NodePill._visible,
        status: typeof s.status === 'string' ? s.status : 'unavailable',
        localBestHeight: s.localBestHeight == null ? null : s.localBestHeight,
        networkBestHeight: s.networkBestHeight == null ? null : s.networkBestHeight,
        connectedPeers: s.connectedPeers == null ? null : s.connectedPeers,
        totalPeers: s.totalPeers == null ? null : s.totalPeers,
      });
    },

    // -- detail sheet ---------------------------------------------------

    // `_sheetRow` and `_renderSheetBody` built six nodes imperatively and
    // blanked them with `body.textContent = ''` on every status event. The
    // body is a portal now (./node-pill-sheet.tsx) and the store repaints it,
    // so an event arriving mid-sheet updates the numbers in place.
    _renderSheetBody() {
      NodePill._render();
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
        // Drop the portal BEFORE the kit discards the node it is mounted in —
        // the rule the dev chat's conversions wrote down, on the one seam here
        // where something other than React destroys the host.
        onDismiss: () => {
          unmountNodeSheet(bodyEl);
          NodePill._sheet = null;
        },
      });
      // The store already holds what the body draws, so the mount paints the
      // current status immediately — no separate first render.
      mountNodeSheet(bodyEl);

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
