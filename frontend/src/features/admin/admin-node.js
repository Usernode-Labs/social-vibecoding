'use strict';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';

// Node & chain section of the admin console (#860) — the retired
// standalone /node-status viewer, ported into #admin/node.
//
// Same three cards (Node, Explorer, Chain-dependent services) and the
// same 2s poll of /api/node-status/full. Changes from the standalone
// page:
//
//   - `render(host)` / `destroy()` so AdminConsole owns the poll's
//     lifetime instead of it running for the life of the tab;
//   - the page's self-contained CSS became Tailwind classes shared with
//     the rest of the console (the AdminUI registry in admin-console.js
//     plus the NodeUI locals below). The dapp-server.js status page keeps
//     its own look; the two are no longer visually paired.
//
// PERMISSIONS: one of the two `public` console sections.
// /api/node-status/full is mounted before authMiddleware (server.js) and
// carries only on-chain / sidecar info, which is public by nature — no
// progressive disclosure needed, same as the standalone page.

// Local class recipes for this section — complete literals (Tailwind's
// extractor scans this file; see the AdminUI note in admin-console.js).
// The section previously kept the dapp-server.js status-page look via
// scoped --un-ns-* CSS variables in app.css; it now shares the console's
// topochain-style vocabulary.
const NodeUI = Object.freeze({
  kv: 'grid grid-cols-[max-content_1fr] items-baseline gap-x-6 gap-y-1.5 text-sm',
  label: 'text-gray-500 dark:text-gray-400',
  val: 'break-all text-gray-900 dark:text-gray-100',
  small: 'text-[11px] text-gray-500 dark:text-gray-400',
  empty: 'py-1.5 text-xs italic text-gray-500 dark:text-gray-400',
  errText: 'text-xs text-red-600 dark:text-red-400',
  warnText: 'text-xs text-amber-600 dark:text-amber-400',
  code: 'rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5 font-mono text-xs',
  link: 'text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 hover:underline',
  details: 'rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-1.5 my-2',
  summary: 'cursor-pointer select-none py-1 text-[13px] font-medium text-gray-700 dark:text-gray-300',
  syncBar: 'mt-1 h-1.5 w-full max-w-[240px] overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800',
  syncFill: 'h-full rounded-full bg-indigo-600 transition-all duration-300',
  syncFillFull: 'h-full rounded-full bg-emerald-500 transition-all duration-300',
});

const AdminNode = {
  POLL_MS: 2000,

  _timer: null,

  esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  fmtAge(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    let s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    let m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm ' + s + 's';
    let h = Math.floor(m / 60); m = m % 60;
    if (h < 24) return h + 'h ' + m + 'm';
    const d = Math.floor(h / 24); h = h % 24;
    return d + 'd ' + h + 'h';
  },

  fmtNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString();
  },

  fmtTime(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleTimeString(); } catch { return '—'; }
  },

  statusBadge(status) {
    const s = String(status || 'unknown');
    let cls = AdminUI.badge.default;
    if (s === 'Synced' || s === 'ok') cls = AdminUI.badge.success;
    else if (s === 'Syncing' || s === 'Connected') cls = AdminUI.badge.secondary;
    else if (s === 'Connecting' || s === 'bad_response' || s === 'degraded') cls = AdminUI.badge.warn;
    else if (s === 'unreachable') cls = AdminUI.badge.destructive;
    else if (s === 'mock') cls = AdminUI.badge.default;
    return '<span class="' + cls + '">' + AdminNode.esc(s) + '</span>';
  },

  _$(id) { return document.getElementById(id); },

  renderHeader(snap) {
    const esc = AdminNode.esc;
    const srv = snap.server || {};
    const nameEl = AdminNode._$('admin-node-server-name');
    if (nameEl) nameEl.textContent = srv.name || 'usernode-social-vibecoding';
    const bits = [];
    bits.push(srv.mode || '?');
    bits.push('up ' + AdminNode.fmtAge(srv.uptimeMs));
    if (srv.version && srv.version !== 'dev') {
      bits.push('build ' + esc(String(srv.version).slice(0, 7)));
    } else if (srv.version) {
      bits.push(esc(srv.version));
    }
    if (srv.nodeRpcUrl) bits.push('sidecar ' + esc(srv.nodeRpcUrl));
    if (srv.explorerHost) bits.push('explorer ' + esc(srv.explorerHost));
    const metaEl = AdminNode._$('admin-node-server-meta');
    if (metaEl) metaEl.textContent = bits.join(' · ');
    const updEl = AdminNode._$('admin-node-last-updated');
    if (updEl) updEl.textContent = AdminNode.fmtTime(snap.at);
  },

  renderNode(snap) {
    const esc = AdminNode.esc;
    const fmtNum = AdminNode.fmtNum;
    const n = snap.node;
    const body = AdminNode._$('admin-node-body');
    if (!body) return;
    if (!n) {
      body.className = NodeUI.empty;
      body.textContent = 'No node probe data.';
      return;
    }
    body.className = '';
    const rows = [];
    rows.push('<div class="' + NodeUI.kv + '">');
    rows.push('<div class="' + NodeUI.label + '">Status</div><div class="' + NodeUI.val + '">' + AdminNode.statusBadge(n.status) +
      (n.error ? ' <span class="' + NodeUI.errText + '">' + esc(n.error) + '</span>' : '') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Peers</div><div class="' + NodeUI.val + '">' + fmtNum(n.peers) + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Best tip</div><div class="' + NodeUI.val + '">' +
      (n.bestTipHeight != null ? fmtNum(n.bestTipHeight) : '—') +
      (n.peerBestTipHeight != null ? ' / ' + fmtNum(n.peerBestTipHeight) + ' (peers)' : '') + '</div>');
    let pct = null;
    if (n.bestTipHeight != null && n.peerBestTipHeight != null && n.peerBestTipHeight > 0) {
      pct = Math.max(0, Math.min(100, (n.bestTipHeight / n.peerBestTipHeight) * 100));
    }
    if (pct != null) {
      rows.push('<div class="' + NodeUI.label + '">Sync</div><div class="' + NodeUI.val + '">' + pct.toFixed(1) + '%' +
        '<div class="' + NodeUI.syncBar + '"><div class="' + (pct >= 99.9 ? NodeUI.syncFillFull : NodeUI.syncFill) + '" style="width:' + pct + '%"></div></div>' +
        '</div>');
    }
    rows.push('<div class="' + NodeUI.label + '">First-synced?</div><div class="' + NodeUI.val + '">' +
      (n.hasBeenSynced ? '<span class="' + AdminUI.badge.success + '">yes</span>' : '<span class="' + AdminUI.badge.warn + '">not yet</span>') + '</div>');
    if (n.hasFullUtxoDb === false) {
      // Verbatim from dapp-server.js — same explanation, same FIXME link.
      // Future readers: keep these two strings in sync if either changes.
      rows.push('<div class="' + NodeUI.label + '">UTXO mode</div><div class="' + NodeUI.val + '">' +
        '<span class="' + AdminUI.badge.destructive + '">PARTIAL</span> ' +
        '<span class="' + NodeUI.warnText + '">sidecar lacks HAS_FULL_UTXO_DB — incoming txs from non-tracked senders may be silently dropped</span>' +
        '<details class="' + NodeUI.details + '" style="margin-top:6px"><summary class="' + NodeUI.summary + '">Why? (likely cause)</summary>' +
        '<div class="' + NodeUI.small + '" style="margin-top:6px;line-height:1.5">' +
        'Most often this is a silent <code class="' + NodeUI.code + '">BlockchainSyncAction::Replace</code>: the candidate verifier picks a target chain that doesn&rsquo;t share enough ancestor with the current best chain, ' +
        '<code class="' + NodeUI.code + '">replace()</code> clears <code class="' + NodeUI.code + '">trees.utxo_root</code>, and from that point every block applies in <code class="' + NodeUI.code + '">partial</code> mode because the worker has no full UTXO tree at the new parent root. ' +
        '(Replace actions log at <code class="' + NodeUI.code + '">DEBUG</code> by default, so they don&rsquo;t appear in <code class="' + NodeUI.code + '">RUST_LOG=info</code>.)' +
        '<br><br>' +
        'A related contributing path is the <code class="' + NodeUI.code + '">BlocksApplyWithoutCandidateVerification</code> warning &mdash; peer-fetched blocks reaching the apply pipeline before candidate verification has signed off. ' +
        'Upstream <code class="' + NodeUI.code + '">FIXME</code> at ' +
        '<a href="https://github.com/Usernode-Labs/usernode/blob/main/crates/node/src/blockchain/sync/blockchain_sync_reducer.rs#L468" target="_blank" rel="noopener" class="' + NodeUI.link + '">' +
        'crates/node/src/blockchain/sync/blockchain_sync_reducer.rs:468</a>:' +
        '<br><em>&ldquo;ensure peer-origin intermediate sync blocks are ingested through candidate verification before they can enter the apply pipeline.&rdquo;</em>' +
        '<br><br>' +
        'Workaround: restart the sidecar with a fresh archive snapshot to get a fresh full-mode window. ' +
        'Confirm with <code class="' + NodeUI.code + '">RUST_LOG=&#x27;info,usernode_node::blockchain=debug&#x27;</code> to see <code class="' + NodeUI.code + '">BlockchainSyncReplace</code> events directly.' +
        '</div></details>' +
        '</div>');
    } else if (n.hasFullUtxoDb === true) {
      rows.push('<div class="' + NodeUI.label + '">UTXO mode</div><div class="' + NodeUI.val + '"><span class="' + AdminUI.badge.success + '">full</span></div>');
    }
    rows.push('<div class="' + NodeUI.label + '">Last refresh</div><div class="' + NodeUI.val + '">' + AdminNode.fmtTime(n.at) +
      ' <span class="' + NodeUI.small + '">(' + AdminNode.fmtAge(Date.now() - (n.at || Date.now())) + ' ago)</span></div>');
    rows.push('</div>');
    body.innerHTML = rows.join('');
  },

  renderExplorer(snap) {
    const esc = AdminNode.esc;
    const fmtNum = AdminNode.fmtNum;
    const ex = snap.explorer;
    const body = AdminNode._$('admin-node-explorer-body');
    if (!body) return;
    if (!ex) {
      body.className = NodeUI.empty;
      body.textContent = 'No explorer probe data.';
      return;
    }
    body.className = '';
    const rows = [];
    rows.push('<div class="' + NodeUI.kv + '">');
    rows.push('<div class="' + NodeUI.label + '">Status</div><div class="' + NodeUI.val + '">' + AdminNode.statusBadge(ex.status) +
      (ex.error ? ' <span class="' + NodeUI.errText + '">' + esc(ex.error) + '</span>' : '') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Host</div><div class="' + NodeUI.val + ' mono font-mono text-xs">' + esc(ex.host || '—') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Chain id</div><div class="' + NodeUI.val + ' mono font-mono text-xs">' + esc(ex.chainId || '—') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Latency</div><div class="' + NodeUI.val + '">' +
      (ex.latencyMs != null ? esc(String(ex.latencyMs)) + ' ms' : '—') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">First-ok?</div><div class="' + NodeUI.val + '">' +
      (ex.hasBeenOk ? '<span class="' + AdminUI.badge.success + '">yes</span>' : '<span class="' + AdminUI.badge.warn + '">not yet</span>') + '</div>');
    rows.push('<div class="' + NodeUI.label + '">Last refresh</div><div class="' + NodeUI.val + '">' + AdminNode.fmtTime(ex.at) +
      ' <span class="' + NodeUI.small + '">(' + AdminNode.fmtAge(Date.now() - (ex.at || Date.now())) + ' ago)</span></div>');
    // Outage shape — how long, and how many probes have failed in a row.
    // Without these a blip and a multi-hour outage look identical here.
    if (ex.downSince) {
      rows.push('<div class="' + NodeUI.label + '">Down since</div><div class="' + NodeUI.val + '">' + AdminNode.fmtTime(ex.downSince) +
        ' <span class="' + NodeUI.small + '">(' + AdminNode.fmtAge(Date.now() - ex.downSince) + ')</span></div>');
    }
    if (ex.consecutiveFailures) {
      rows.push('<div class="' + NodeUI.label + '">Failed probes</div><div class="' + NodeUI.val + '">' +
        fmtNum(ex.consecutiveFailures) + ' in a row</div>');
    }
    rows.push('</div>');
    // The consequence an operator can't infer from the fields above.
    if (ex.status && ex.status !== 'ok' && ex.status !== 'mock') {
      rows.push('<p class="' + NodeUI.errText + '" style="margin-top:10px">' +
        'Wallet linking is paused while the explorer is unreachable — the ' +
        'chain poller reads incoming link transactions from here, so ' +
        '&ldquo;Link wallet&rdquo; will not complete. Retries are backing off.' +
        '</p>');
    }
    body.innerHTML = rows.join('');
  },

  // Surfaces the two services that depend on the chain (chain-poller for
  // wallet linking, genesis-accounts for the gating list).
  renderServices(snap) {
    const esc = AdminNode.esc;
    const fmtNum = AdminNode.fmtNum;
    const fmtTime = AdminNode.fmtTime;
    const fmtAge = AdminNode.fmtAge;
    const svc = snap.services || {};
    const body = AdminNode._$('admin-node-services-body');
    if (!body) return;
    const rows = [];

    // Chain-poller (wallet-linking).
    const cp = svc.chainPoller;
    if (cp) {
      rows.push('<details open class="' + NodeUI.details + '"><summary class="' + NodeUI.summary + '">Chain-poller (wallet linker) ' +
        '<span class="' + NodeUI.small + '">' + (cp.enabled ? '<span class="' + AdminUI.badge.success + '">enabled</span>' : '<span class="' + AdminUI.badge.warn + '">disabled</span>') + '</span></summary>');
      rows.push('<div class="' + NodeUI.kv + '" style="margin-top:8px">');
      rows.push('<div class="' + NodeUI.label + '">Chain id</div><div class="' + NodeUI.val + ' mono font-mono text-xs">' + esc(cp.chainId || '—') + '</div>');
      rows.push('<div class="' + NodeUI.label + '">Last block height</div><div class="' + NodeUI.val + '">' + fmtNum(cp.lastBlockHeight) + '</div>');
      rows.push('<div class="' + NodeUI.label + '">Tx ids seen</div><div class="' + NodeUI.val + '">' + fmtNum(cp.seenTxCount) + '</div>');
      rows.push('<div class="' + NodeUI.label + '">Wallet links applied</div><div class="' + NodeUI.val + '">' + fmtNum(cp.walletLinkCount) + '</div>');
      rows.push('<div class="' + NodeUI.label + '">Last polled</div><div class="' + NodeUI.val + '">' +
        (cp.lastPolledAt
          ? fmtTime(cp.lastPolledAt) + ' <span class="' + NodeUI.small + '">(' + fmtAge(Date.now() - cp.lastPolledAt) + ' ago)</span>'
          : '—') + '</div>');
      // Retry cadence + failure streak: the poller backs off from 4s to
      // 60s while the explorer is down, so "last polled 40s ago" is
      // expected during an outage rather than a sign of a wedged loop.
      if (cp.pollIntervalMs != null) {
        rows.push('<div class="' + NodeUI.label + '">Retry interval</div><div class="' + NodeUI.val + '">' +
          fmtNum(Math.round(cp.pollIntervalMs / 1000)) + 's' +
          (cp.consecutiveFailures ? ' <span class="' + NodeUI.small + '">(backing off)</span>' : '') + '</div>');
      }
      if (cp.consecutiveFailures) {
        rows.push('<div class="' + NodeUI.label + '">Consecutive failures</div><div class="' + NodeUI.val + '">' +
          fmtNum(cp.consecutiveFailures) + '</div>');
      }
      if (cp.downSince) {
        rows.push('<div class="' + NodeUI.label + '">Failing since</div><div class="' + NodeUI.val + '">' + fmtTime(cp.downSince) +
          ' <span class="' + NodeUI.small + '">(' + fmtAge(Date.now() - cp.downSince) + ')</span></div>');
      }
      if (cp.lastError) {
        rows.push('<div class="' + NodeUI.label + '">Last error</div><div class="' + NodeUI.val + '"><span class="' + NodeUI.errText + '">' + esc(cp.lastError) + '</span></div>');
      }
      rows.push('</div></details>');
    }

    // Genesis-accounts loader.
    const ga = svc.genesisAccounts;
    if (ga) {
      rows.push('<details open class="' + NodeUI.details + '"><summary class="' + NodeUI.summary + '">Genesis-accounts ' +
        '<span class="' + NodeUI.small + '">' +
        (ga.loaded ? '<span class="' + AdminUI.badge.success + '">loaded</span>' : '<span class="' + AdminUI.badge.warn + '">loading</span>') +
        '</span></summary>');
      rows.push('<div class="' + NodeUI.kv + '" style="margin-top:8px">');
      rows.push('<div class="' + NodeUI.label + '">Loaded?</div><div class="' + NodeUI.val + '">' +
        (ga.loaded ? '<span class="' + AdminUI.badge.success + '">yes</span>' : '<span class="' + AdminUI.badge.warn + '">not yet</span>') + '</div>');
      rows.push('<div class="' + NodeUI.label + '">Account count</div><div class="' + NodeUI.val + '">' + fmtNum(ga.count) + '</div>');
      if (ga.consecutiveFailures) {
        rows.push('<div class="' + NodeUI.label + '">Consecutive failures</div><div class="' + NodeUI.val + '">' +
          fmtNum(ga.consecutiveFailures) + '</div>');
      }
      if (ga.downSince) {
        rows.push('<div class="' + NodeUI.label + '">Failing since</div><div class="' + NodeUI.val + '">' + fmtTime(ga.downSince) +
          ' <span class="' + NodeUI.small + '">(' + fmtAge(Date.now() - ga.downSince) + ')</span></div>');
      }
      if (ga.lastError) {
        rows.push('<div class="' + NodeUI.label + '">Last error</div><div class="' + NodeUI.val + '"><span class="' + NodeUI.errText + '">' + esc(ga.lastError) + '</span></div>');
      }
      rows.push('</div></details>');
    }

    if (!rows.length) {
      body.className = NodeUI.empty;
      body.textContent = 'No services registered.';
      return;
    }
    body.className = '';
    body.innerHTML = rows.join('');
  },

  _render(snap) {
    try {
      AdminNode.renderHeader(snap);
      AdminNode.renderNode(snap);
      AdminNode.renderExplorer(snap);
      AdminNode.renderServices(snap);
    } catch (e) {
      console.error('[node-status] render failed:', e);
    }
  },

  _setConn(state) {
    const led = AdminNode._$('admin-node-led');
    const t = AdminNode._$('admin-node-conn-text');
    if (!led || !t) return;
    if (state === 'live') {
      led.className = 'inline-block h-2 w-2 rounded-full bg-emerald-500';
      t.textContent = 'live (2s poll)';
    } else if (state === 'dead') {
      led.className = 'inline-block h-2 w-2 rounded-full bg-red-500';
      t.textContent = 'disconnected';
    } else {
      led.className = 'inline-block h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600';
      t.textContent = 'connecting…';
    }
  },

  async _fetchOnce() {
    // Section may have been swapped out mid-flight; bail rather than
    // writing into a detached tree.
    try {
      const r = await fetch('/api/node-status/full', { cache: 'no-store' });
      if (!AdminNode._$('admin-node-root')) return;
      const snap = r.ok ? await r.json() : null;
      if (!AdminNode._$('admin-node-root')) return;
      if (snap) {
        AdminNode._setConn('live');
        AdminNode._render(snap);
      } else {
        AdminNode._setConn('dead');
      }
    } catch (err) {
      if (!AdminNode._$('admin-node-root')) return;
      AdminNode._setConn('dead');
      console.warn('[node-status] poll failed:', err && err.message ? err.message : err);
    }
  },

  // ── Section lifecycle ────────────────────────────────────────────────

  render(host) {
    host.innerHTML = `
      <div id="admin-node-root">
        <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="admin-node-server-name" class="text-2xl font-bold text-gray-900 dark:text-gray-100">Loading…</h2>
            <div class="mb-6 text-[13px] text-gray-500 dark:text-gray-400" id="admin-node-server-meta"></div>
          </div>
          <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400" id="admin-node-conn"><span id="admin-node-led" class="inline-block h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600"></span><span id="admin-node-conn-text">connecting…</span></div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Node</h3>
          <div id="admin-node-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Explorer</h3>
          <div id="admin-node-explorer-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Chain-dependent services</h3>
          <div id="admin-node-services-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${NodeUI.small} mt-[18px] text-center">
          Updated <span id="admin-node-last-updated">—</span> · polling
          <code class="${NodeUI.code}">/api/node-status/full</code> every 2s ·
          JSON snapshot at <a href="/api/node-status/full" target="_blank" rel="noopener" class="${NodeUI.link}">/api/node-status/full</a>
        </div>
      </div>`;

    AdminNode._fetchOnce();
    clearInterval(AdminNode._timer);
    AdminNode._timer = setInterval(AdminNode._fetchOnce, AdminNode.POLL_MS);
  },

  destroy() {
    clearInterval(AdminNode._timer);
    AdminNode._timer = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminNode = AdminNode;
