'use strict';

// Node & chain section of the admin console (#860) — the retired
// standalone /node-status viewer, ported into #admin/node.
//
// Same three cards (Node, Explorer, Chain-dependent services) and the
// same 2s poll of /api/node-status/full. Changes from the standalone
// page:
//
//   - `render(host)` / `destroy()` so AdminConsole owns the poll's
//     lifetime instead of it running for the life of the tab;
//   - the page's self-contained CSS (its own :root palette, .card, .kv,
//     .badge, .sync-bar, details/summary styling) moved into
//     public/css/app.css scoped under #admin-node-root, so it can't leak
//     into the rest of the SPA. The palette is unchanged — this section
//     deliberately keeps the dapp-server.js status-page look rather than
//     being restyled into Tailwind, so the two stay comparable.
//
// PERMISSIONS: one of the two `public` console sections.
// /api/node-status/full is mounted before authMiddleware (server.js) and
// carries only on-chain / sidecar info, which is public by nature — no
// progressive disclosure needed, same as the standalone page.

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
    let cls = 'muted';
    if (s === 'Synced' || s === 'ok') cls = 'ok';
    else if (s === 'Syncing' || s === 'Connected') cls = 'accent';
    else if (s === 'Connecting' || s === 'bad_response' || s === 'degraded') cls = 'warn';
    else if (s === 'unreachable') cls = 'err';
    else if (s === 'mock') cls = 'muted';
    return '<span class="badge ' + cls + '">' + AdminNode.esc(s) + '</span>';
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
      body.className = 'empty';
      body.textContent = 'No node probe data.';
      return;
    }
    body.className = '';
    const rows = [];
    rows.push('<div class="kv">');
    rows.push('<div class="label">Status</div><div class="val">' + AdminNode.statusBadge(n.status) +
      (n.error ? ' <span class="err-text">' + esc(n.error) + '</span>' : '') + '</div>');
    rows.push('<div class="label">Peers</div><div class="val">' + fmtNum(n.peers) + '</div>');
    rows.push('<div class="label">Best tip</div><div class="val">' +
      (n.bestTipHeight != null ? fmtNum(n.bestTipHeight) : '—') +
      (n.peerBestTipHeight != null ? ' / ' + fmtNum(n.peerBestTipHeight) + ' (peers)' : '') + '</div>');
    let pct = null;
    if (n.bestTipHeight != null && n.peerBestTipHeight != null && n.peerBestTipHeight > 0) {
      pct = Math.max(0, Math.min(100, (n.bestTipHeight / n.peerBestTipHeight) * 100));
    }
    if (pct != null) {
      rows.push('<div class="label">Sync</div><div class="val">' + pct.toFixed(1) + '%' +
        '<div class="sync-bar"><div class="sync-fill' + (pct >= 99.9 ? ' full' : '') + '" style="width:' + pct + '%"></div></div>' +
        '</div>');
    }
    rows.push('<div class="label">First-synced?</div><div class="val">' +
      (n.hasBeenSynced ? '<span class="badge ok">yes</span>' : '<span class="badge warn">not yet</span>') + '</div>');
    if (n.hasFullUtxoDb === false) {
      // Verbatim from dapp-server.js — same explanation, same FIXME link.
      // Future readers: keep these two strings in sync if either changes.
      rows.push('<div class="label">UTXO mode</div><div class="val">' +
        '<span class="badge err">PARTIAL</span> ' +
        '<span class="warn-text">sidecar lacks HAS_FULL_UTXO_DB — incoming txs from non-tracked senders may be silently dropped</span>' +
        '<details style="margin-top:6px"><summary class="small">Why? (likely cause)</summary>' +
        '<div class="small" style="margin-top:6px;line-height:1.5">' +
        'Most often this is a silent <code>BlockchainSyncAction::Replace</code>: the candidate verifier picks a target chain that doesn&rsquo;t share enough ancestor with the current best chain, ' +
        '<code>replace()</code> clears <code>trees.utxo_root</code>, and from that point every block applies in <code>partial</code> mode because the worker has no full UTXO tree at the new parent root. ' +
        '(Replace actions log at <code>DEBUG</code> by default, so they don&rsquo;t appear in <code>RUST_LOG=info</code>.)' +
        '<br><br>' +
        'A related contributing path is the <code>BlocksApplyWithoutCandidateVerification</code> warning &mdash; peer-fetched blocks reaching the apply pipeline before candidate verification has signed off. ' +
        'Upstream <code>FIXME</code> at ' +
        '<a href="https://github.com/Usernode-Labs/usernode/blob/main/crates/node/src/blockchain/sync/blockchain_sync_reducer.rs#L468" target="_blank" rel="noopener" style="color:var(--un-ns-accent)">' +
        'crates/node/src/blockchain/sync/blockchain_sync_reducer.rs:468</a>:' +
        '<br><em>&ldquo;ensure peer-origin intermediate sync blocks are ingested through candidate verification before they can enter the apply pipeline.&rdquo;</em>' +
        '<br><br>' +
        'Workaround: restart the sidecar with a fresh archive snapshot to get a fresh full-mode window. ' +
        'Confirm with <code>RUST_LOG=&#x27;info,usernode_node::blockchain=debug&#x27;</code> to see <code>BlockchainSyncReplace</code> events directly.' +
        '</div></details>' +
        '</div>');
    } else if (n.hasFullUtxoDb === true) {
      rows.push('<div class="label">UTXO mode</div><div class="val"><span class="badge ok">full</span></div>');
    }
    rows.push('<div class="label">Last refresh</div><div class="val">' + AdminNode.fmtTime(n.at) +
      ' <span class="small">(' + AdminNode.fmtAge(Date.now() - (n.at || Date.now())) + ' ago)</span></div>');
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
      body.className = 'empty';
      body.textContent = 'No explorer probe data.';
      return;
    }
    body.className = '';
    const rows = [];
    rows.push('<div class="kv">');
    rows.push('<div class="label">Status</div><div class="val">' + AdminNode.statusBadge(ex.status) +
      (ex.error ? ' <span class="err-text">' + esc(ex.error) + '</span>' : '') + '</div>');
    rows.push('<div class="label">Host</div><div class="val mono">' + esc(ex.host || '—') + '</div>');
    rows.push('<div class="label">Chain id</div><div class="val mono">' + esc(ex.chainId || '—') + '</div>');
    rows.push('<div class="label">Latency</div><div class="val">' +
      (ex.latencyMs != null ? esc(String(ex.latencyMs)) + ' ms' : '—') + '</div>');
    rows.push('<div class="label">First-ok?</div><div class="val">' +
      (ex.hasBeenOk ? '<span class="badge ok">yes</span>' : '<span class="badge warn">not yet</span>') + '</div>');
    rows.push('<div class="label">Last refresh</div><div class="val">' + AdminNode.fmtTime(ex.at) +
      ' <span class="small">(' + AdminNode.fmtAge(Date.now() - (ex.at || Date.now())) + ' ago)</span></div>');
    // Outage shape — how long, and how many probes have failed in a row.
    // Without these a blip and a multi-hour outage look identical here.
    if (ex.downSince) {
      rows.push('<div class="label">Down since</div><div class="val">' + AdminNode.fmtTime(ex.downSince) +
        ' <span class="small">(' + AdminNode.fmtAge(Date.now() - ex.downSince) + ')</span></div>');
    }
    if (ex.consecutiveFailures) {
      rows.push('<div class="label">Failed probes</div><div class="val">' +
        fmtNum(ex.consecutiveFailures) + ' in a row</div>');
    }
    rows.push('</div>');
    // The consequence an operator can't infer from the fields above.
    if (ex.status && ex.status !== 'ok' && ex.status !== 'mock') {
      rows.push('<p class="err-text" style="margin-top:10px">' +
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
      rows.push('<details open><summary>Chain-poller (wallet linker) ' +
        '<span class="small">' + (cp.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">disabled</span>') + '</span></summary>');
      rows.push('<div class="kv" style="margin-top:8px">');
      rows.push('<div class="label">Chain id</div><div class="val mono">' + esc(cp.chainId || '—') + '</div>');
      rows.push('<div class="label">Last block height</div><div class="val">' + fmtNum(cp.lastBlockHeight) + '</div>');
      rows.push('<div class="label">Tx ids seen</div><div class="val">' + fmtNum(cp.seenTxCount) + '</div>');
      rows.push('<div class="label">Wallet links applied</div><div class="val">' + fmtNum(cp.walletLinkCount) + '</div>');
      rows.push('<div class="label">Last polled</div><div class="val">' +
        (cp.lastPolledAt
          ? fmtTime(cp.lastPolledAt) + ' <span class="small">(' + fmtAge(Date.now() - cp.lastPolledAt) + ' ago)</span>'
          : '—') + '</div>');
      // Retry cadence + failure streak: the poller backs off from 4s to
      // 60s while the explorer is down, so "last polled 40s ago" is
      // expected during an outage rather than a sign of a wedged loop.
      if (cp.pollIntervalMs != null) {
        rows.push('<div class="label">Retry interval</div><div class="val">' +
          fmtNum(Math.round(cp.pollIntervalMs / 1000)) + 's' +
          (cp.consecutiveFailures ? ' <span class="small">(backing off)</span>' : '') + '</div>');
      }
      if (cp.consecutiveFailures) {
        rows.push('<div class="label">Consecutive failures</div><div class="val">' +
          fmtNum(cp.consecutiveFailures) + '</div>');
      }
      if (cp.downSince) {
        rows.push('<div class="label">Failing since</div><div class="val">' + fmtTime(cp.downSince) +
          ' <span class="small">(' + fmtAge(Date.now() - cp.downSince) + ')</span></div>');
      }
      if (cp.lastError) {
        rows.push('<div class="label">Last error</div><div class="val"><span class="err-text">' + esc(cp.lastError) + '</span></div>');
      }
      rows.push('</div></details>');
    }

    // Genesis-accounts loader.
    const ga = svc.genesisAccounts;
    if (ga) {
      rows.push('<details open><summary>Genesis-accounts ' +
        '<span class="small">' +
        (ga.loaded ? '<span class="badge ok">loaded</span>' : '<span class="badge warn">loading</span>') +
        '</span></summary>');
      rows.push('<div class="kv" style="margin-top:8px">');
      rows.push('<div class="label">Loaded?</div><div class="val">' +
        (ga.loaded ? '<span class="badge ok">yes</span>' : '<span class="badge warn">not yet</span>') + '</div>');
      rows.push('<div class="label">Account count</div><div class="val">' + fmtNum(ga.count) + '</div>');
      if (ga.consecutiveFailures) {
        rows.push('<div class="label">Consecutive failures</div><div class="val">' +
          fmtNum(ga.consecutiveFailures) + '</div>');
      }
      if (ga.downSince) {
        rows.push('<div class="label">Failing since</div><div class="val">' + fmtTime(ga.downSince) +
          ' <span class="small">(' + fmtAge(Date.now() - ga.downSince) + ')</span></div>');
      }
      if (ga.lastError) {
        rows.push('<div class="label">Last error</div><div class="val"><span class="err-text">' + esc(ga.lastError) + '</span></div>');
      }
      rows.push('</div></details>');
    }

    if (!rows.length) {
      body.className = 'empty';
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
    const el = AdminNode._$('admin-node-conn');
    const t = AdminNode._$('admin-node-conn-text');
    if (!el || !t) return;
    el.className = 'conn ' + state;
    if (state === 'live') t.textContent = 'live (2s poll)';
    else if (state === 'dead') t.textContent = 'disconnected';
    else t.textContent = 'connecting…';
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
        <div class="header">
          <div>
            <h2 id="admin-node-server-name">Loading…</h2>
            <div class="header-pill" id="admin-node-server-meta"></div>
          </div>
          <div class="conn" id="admin-node-conn"><span class="led"></span><span id="admin-node-conn-text">connecting…</span></div>
        </div>

        <div class="card">
          <h3>Node</h3>
          <div id="admin-node-body" class="empty">Loading…</div>
        </div>

        <div class="card">
          <h3>Explorer</h3>
          <div id="admin-node-explorer-body" class="empty">Loading…</div>
        </div>

        <div class="card">
          <h3>Chain-dependent services</h3>
          <div id="admin-node-services-body" class="empty">Loading…</div>
        </div>

        <div class="small" style="text-align:center;margin-top:18px">
          Updated <span id="admin-node-last-updated">—</span> · polling
          <code>/api/node-status/full</code> every 2s ·
          JSON snapshot at <a href="/api/node-status/full" target="_blank" rel="noopener">/api/node-status/full</a>
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

window.AdminNode = AdminNode;
