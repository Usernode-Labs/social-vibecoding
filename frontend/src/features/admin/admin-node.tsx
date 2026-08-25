'use strict';

import { useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Node & chain section of the admin console (#860) — the retired
// standalone /node-status viewer, ported into #admin/node.
//
// Same three cards (Node, Explorer, Chain-dependent services) and the
// same 2s poll of /api/node-status/full.
//
// PERMISSIONS: one of the two `public` console sections.
// /api/node-status/full is mounted before authMiddleware (server.js) and
// carries only on-chain / sidecar info, which is public by nature — no
// progressive disclosure needed, same as the standalone page.
//
// ── React-owned (#1120 slice 8) ───────────────────────────────────────
//
// Third section through the seam admin-e2e.tsx established, and the one that
// makes the case for the lifecycle half of it. This section polls every two
// seconds, and the old shape spent four `document.getElementById` lookups per
// tick writing into a tree the same module had built — plus a
// `if (!$('admin-node-root')) return;` in three places, standing in for "am I
// still the section on screen?".
//
// The poll is a `useEffect` now, so its cleanup is the teardown: `destroy()`
// drops the portal, React unmounts, the interval is cleared and a response
// still in flight resolves into a component that no longer exists. The three
// existence guards and the `_timer` module global are both gone, and the
// answer they were approximating is now structural.
//
// One thing that did NOT change: the section renders exactly the markup it
// did before, ids included. `#admin-node-root` is named by a declared dapp
// check (tests/admin-heavy-sections-island.test.js pins it), and the rest are
// kept for the same reason the e2e conversion kept its four — so this diff
// stays a renderer swap rather than a rewrite.

const POLL_MS = 2000;

// Local class recipes for this section — complete literals (Tailwind's
// extractor scans this file; see the AdminUI note in admin-console.js).
// The section previously kept the dapp-server.js status-page look via
// scoped --un-ns-* CSS variables in app.css; it now shares the console's
// topochain-style vocabulary.
const NodeUI = Object.freeze({
  kv: 'grid grid-cols-[max-content_1fr] items-baseline gap-x-6 gap-y-1.5 text-sm',
  label: 'text-zinc-500 dark:text-zinc-400',
  val: 'break-all text-zinc-900 dark:text-zinc-100',
  small: 'text-[11px] text-zinc-500 dark:text-zinc-400',
  empty: 'py-1.5 text-xs italic text-zinc-500 dark:text-zinc-400',
  errText: 'text-xs text-red-600 dark:text-red-400',
  warnText: 'text-xs text-amber-600 dark:text-amber-400',
  code: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 font-mono text-xs',
  link: 'text-violet-600 hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300 hover:underline',
  details: 'rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-3 py-1.5 my-2',
  summary: 'cursor-pointer select-none py-1 text-[13px] font-medium text-zinc-700 dark:text-zinc-300',
  syncBar: 'mt-1 h-1.5 w-full max-w-[240px] overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800',
  syncFill: 'h-full rounded-full bg-violet-600 transition-all duration-300',
  syncFillFull: 'h-full rounded-full bg-emerald-500 transition-all duration-300',
});

interface Snapshot {
  at?: number;
  server?: Record<string, any>;
  node?: Record<string, any> | null;
  explorer?: Record<string, any> | null;
  services?: Record<string, any>;
}

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '—';
  let s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60); s %= 60;
  if (m < 60) return `${m}m ${s}s`;
  let h = Math.floor(m / 60); m %= 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24); h %= 24;
  return `${d}d ${h}h`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleTimeString(); } catch { return '—'; }
}

function StatusBadge({ status }: { status?: string }) {
  const s = String(status || 'unknown');
  // Annotated, not inferred: without it TypeScript narrows `cls` to the
  // `default` recipe's literal string and every branch below is an error.
  let cls: string = AdminUI.badge.default;
  if (s === 'Synced' || s === 'ok') cls = AdminUI.badge.success;
  else if (s === 'Syncing' || s === 'Connected') cls = AdminUI.badge.secondary;
  else if (s === 'Connecting' || s === 'bad_response' || s === 'degraded') cls = AdminUI.badge.warn;
  else if (s === 'unreachable') cls = AdminUI.badge.destructive;
  else if (s === 'mock') cls = AdminUI.badge.default;
  return <span className={cls}>{s}</span>;
}

function YesNo({ ok, yes = 'yes', no = 'not yet' }: { ok?: boolean; yes?: string; no?: string }) {
  return ok
    ? <span className={AdminUI.badge.success}>{yes}</span>
    : <span className={AdminUI.badge.warn}>{no}</span>;
}

/** One `label / value` pair of the two-column grid. */
function Row({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <>
      <div className={NodeUI.label}>{label}</div>
      <div className={mono ? `${NodeUI.val} mono font-mono text-xs` : NodeUI.val}>{children}</div>
    </>
  );
}

function Refreshed({ at }: { at?: number }) {
  return (
    <>
      {fmtTime(at)} <span className={NodeUI.small}>({fmtAge(Date.now() - (at || Date.now()))} ago)</span>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className={NodeUI.code}>{children}</code>;
}

/**
 * Verbatim from dapp-server.js — same explanation, same FIXME link.
 * Future readers: keep these two strings in sync if either changes.
 */
function PartialUtxoExplainer() {
  return (
    <>
      <span className={AdminUI.badge.destructive}>PARTIAL</span>
      <span className={NodeUI.warnText}>
        {' sidecar lacks HAS_FULL_UTXO_DB — incoming txs from non-tracked senders may be silently dropped'}
      </span>
      <details className={NodeUI.details} style={{ marginTop: '6px' }}>
        <summary className={NodeUI.summary}>Why? (likely cause)</summary>
        <div className={NodeUI.small} style={{ marginTop: '6px', lineHeight: 1.5 }}>
          {'Most often this is a silent '}<Code>BlockchainSyncAction::Replace</Code>
          {': the candidate verifier picks a target chain that doesn’t share enough ancestor with the current best chain, '}
          <Code>replace()</Code>{' clears '}<Code>trees.utxo_root</Code>
          {', and from that point every block applies in '}<Code>partial</Code>
          {' mode because the worker has no full UTXO tree at the new parent root. (Replace actions log at '}
          <Code>DEBUG</Code>{' by default, so they don’t appear in '}<Code>RUST_LOG=info</Code>{'.)'}
          <br /><br />
          {'A related contributing path is the '}<Code>BlocksApplyWithoutCandidateVerification</Code>
          {' warning — peer-fetched blocks reaching the apply pipeline before candidate verification has signed off. Upstream '}
          <Code>FIXME</Code>{' at '}
          <a
            href="https://github.com/Usernode-Labs/usernode/blob/main/crates/node/src/blockchain/sync/blockchain_sync_reducer.rs#L468"
            target="_blank" rel="noopener" className={NodeUI.link}
          >crates/node/src/blockchain/sync/blockchain_sync_reducer.rs:468</a>{':'}
          <br />
          <em>“ensure peer-origin intermediate sync blocks are ingested through candidate verification before they can enter the apply pipeline.”</em>
          <br /><br />
          {'Workaround: restart the sidecar with a fresh archive snapshot to get a fresh full-mode window. Confirm with '}
          <Code>{"RUST_LOG='info,usernode_node::blockchain=debug'"}</Code>{' to see '}
          <Code>BlockchainSyncReplace</Code>{' events directly.'}
        </div>
      </details>
    </>
  );
}

function NodeCard({ n }: { n?: Record<string, any> | null }) {
  if (!n) return <div id="admin-node-body" className={NodeUI.empty}>No node probe data.</div>;
  let pct: number | null = null;
  if (n.bestTipHeight != null && n.peerBestTipHeight != null && n.peerBestTipHeight > 0) {
    pct = Math.max(0, Math.min(100, (n.bestTipHeight / n.peerBestTipHeight) * 100));
  }
  return (
    <div id="admin-node-body">
      <div className={NodeUI.kv}>
        <Row label="Status">
          <StatusBadge status={n.status} />
          {n.error ? <> <span className={NodeUI.errText}>{n.error}</span></> : null}
        </Row>
        <Row label="Peers">{fmtNum(n.peers)}</Row>
        <Row label="Best tip">
          {n.bestTipHeight != null ? fmtNum(n.bestTipHeight) : '—'}
          {n.peerBestTipHeight != null ? ` / ${fmtNum(n.peerBestTipHeight)} (peers)` : ''}
        </Row>
        {pct != null ? (
          <Row label="Sync">
            {`${pct.toFixed(1)}%`}
            <div className={NodeUI.syncBar}>
              <div className={pct >= 99.9 ? NodeUI.syncFillFull : NodeUI.syncFill} style={{ width: `${pct}%` }} />
            </div>
          </Row>
        ) : null}
        <Row label="First-synced?"><YesNo ok={!!n.hasBeenSynced} /></Row>
        {n.hasFullUtxoDb === false ? <Row label="UTXO mode"><PartialUtxoExplainer /></Row> : null}
        {n.hasFullUtxoDb === true
          ? <Row label="UTXO mode"><span className={AdminUI.badge.success}>full</span></Row>
          : null}
        <Row label="Last refresh"><Refreshed at={n.at} /></Row>
      </div>
    </div>
  );
}

function ExplorerCard({ ex }: { ex?: Record<string, any> | null }) {
  if (!ex) return <div id="admin-node-explorer-body" className={NodeUI.empty}>No explorer probe data.</div>;
  return (
    <div id="admin-node-explorer-body">
      <div className={NodeUI.kv}>
        <Row label="Status">
          <StatusBadge status={ex.status} />
          {ex.error ? <> <span className={NodeUI.errText}>{ex.error}</span></> : null}
        </Row>
        <Row label="Host" mono>{ex.host || '—'}</Row>
        <Row label="Chain id" mono>{ex.chainId || '—'}</Row>
        <Row label="Latency">{ex.latencyMs != null ? `${ex.latencyMs} ms` : '—'}</Row>
        <Row label="First-ok?"><YesNo ok={!!ex.hasBeenOk} /></Row>
        <Row label="Last refresh"><Refreshed at={ex.at} /></Row>
        {/* Outage shape — how long, and how many probes have failed in a row.
            Without these a blip and a multi-hour outage look identical here. */}
        {ex.downSince ? (
          <Row label="Down since">
            {fmtTime(ex.downSince)} <span className={NodeUI.small}>({fmtAge(Date.now() - ex.downSince)})</span>
          </Row>
        ) : null}
        {ex.consecutiveFailures ? (
          <Row label="Failed probes">{`${fmtNum(ex.consecutiveFailures)} in a row`}</Row>
        ) : null}
      </div>
      {/* The consequence an operator can't infer from the fields above. */}
      {ex.status && ex.status !== 'ok' && ex.status !== 'mock' ? (
        <p className={NodeUI.errText} style={{ marginTop: '10px' }}>
          Wallet linking is paused while the explorer is unreachable — the
          chain poller reads incoming link transactions from here, so
          “Link wallet” will not complete. Retries are backing off.
        </p>
      ) : null}
    </div>
  );
}

// Surfaces the two services that depend on the chain (chain-poller for
// wallet linking, genesis-accounts for the gating list).
function ServicesCard({ svc }: { svc: Record<string, any> }) {
  const cp = svc.chainPoller;
  const ga = svc.genesisAccounts;
  if (!cp && !ga) return <div id="admin-node-services-body" className={NodeUI.empty}>No services registered.</div>;
  return (
    <div id="admin-node-services-body">
      {cp ? (
        <details open className={NodeUI.details}>
          <summary className={NodeUI.summary}>
            {'Chain-poller (wallet linker) '}
            <span className={NodeUI.small}><YesNo ok={!!cp.enabled} yes="enabled" no="disabled" /></span>
          </summary>
          <div className={NodeUI.kv} style={{ marginTop: '8px' }}>
            <Row label="Chain id" mono>{cp.chainId || '—'}</Row>
            <Row label="Last block height">{fmtNum(cp.lastBlockHeight)}</Row>
            <Row label="Tx ids seen">{fmtNum(cp.seenTxCount)}</Row>
            <Row label="Wallet links applied">{fmtNum(cp.walletLinkCount)}</Row>
            <Row label="Last polled">{cp.lastPolledAt ? <Refreshed at={cp.lastPolledAt} /> : '—'}</Row>
            {/* Retry cadence + failure streak: the poller backs off from 4s to
                60s while the explorer is down, so "last polled 40s ago" is
                expected during an outage rather than a sign of a wedged loop. */}
            {cp.pollIntervalMs != null ? (
              <Row label="Retry interval">
                {`${fmtNum(Math.round(cp.pollIntervalMs / 1000))}s`}
                {cp.consecutiveFailures ? <> <span className={NodeUI.small}>(backing off)</span></> : null}
              </Row>
            ) : null}
            {cp.consecutiveFailures ? <Row label="Consecutive failures">{fmtNum(cp.consecutiveFailures)}</Row> : null}
            {cp.downSince ? (
              <Row label="Failing since">
                {fmtTime(cp.downSince)} <span className={NodeUI.small}>({fmtAge(Date.now() - cp.downSince)})</span>
              </Row>
            ) : null}
            {cp.lastError ? <Row label="Last error"><span className={NodeUI.errText}>{cp.lastError}</span></Row> : null}
          </div>
        </details>
      ) : null}

      {ga ? (
        <details open className={NodeUI.details}>
          <summary className={NodeUI.summary}>
            {'Genesis-accounts '}
            <span className={NodeUI.small}><YesNo ok={!!ga.loaded} yes="loaded" no="loading" /></span>
          </summary>
          <div className={NodeUI.kv} style={{ marginTop: '8px' }}>
            <Row label="Loaded?"><YesNo ok={!!ga.loaded} /></Row>
            <Row label="Account count">{fmtNum(ga.count)}</Row>
            {ga.consecutiveFailures ? <Row label="Consecutive failures">{fmtNum(ga.consecutiveFailures)}</Row> : null}
            {ga.downSince ? (
              <Row label="Failing since">
                {fmtTime(ga.downSince)} <span className={NodeUI.small}>({fmtAge(Date.now() - ga.downSince)})</span>
              </Row>
            ) : null}
            {ga.lastError ? <Row label="Last error"><span className={NodeUI.errText}>{ga.lastError}</span></Row> : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const LED: Record<string, string> = {
  live: 'inline-block h-2 w-2 rounded-full bg-emerald-500',
  dead: 'inline-block h-2 w-2 rounded-full bg-red-500',
  connecting: 'inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600',
};
const CONN_TEXT: Record<string, string> = {
  live: 'live (2s poll)',
  dead: 'disconnected',
  connecting: 'connecting…',
};

function NodeSection() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<'live' | 'dead' | 'connecting'>('connecting');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/node-status/full', { cache: 'no-store' });
        // The section may have been swapped out mid-flight. This used to be
        // three `if (!$('admin-node-root')) return;` guards; the ref answers
        // the same question about THIS mount rather than about whichever
        // section currently owns that id.
        if (!alive.current) return;
        const next = r.ok ? await r.json() : null;
        if (!alive.current) return;
        if (next) { setConn('live'); setSnap(next); } else { setConn('dead'); }
      } catch (err: any) {
        if (!alive.current) return;
        setConn('dead');
        console.warn('[node-status] poll failed:', err && err.message ? err.message : err);
      }
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_MS);
    // THE teardown. destroy() drops the portal, React unmounts, this runs —
    // which is what stops a section left behind from polling every 2s for the
    // life of the tab (#860).
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  const srv = (snap && snap.server) || {};
  const bits: string[] = [];
  bits.push(srv.mode || '?');
  bits.push(`up ${fmtAge(srv.uptimeMs)}`);
  if (srv.version && srv.version !== 'dev') bits.push(`build ${String(srv.version).slice(0, 7)}`);
  else if (srv.version) bits.push(String(srv.version));
  if (srv.nodeRpcUrl) bits.push(`sidecar ${srv.nodeRpcUrl}`);
  if (srv.explorerHost) bits.push(`explorer ${srv.explorerHost}`);

  return (
    <div id="admin-node-root">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="admin-node-server-name" className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {snap ? (srv.name || 'usernode-social-vibecoding') : 'Loading…'}
          </h2>
          <div className="mb-6 text-[13px] text-zinc-500 dark:text-zinc-400" id="admin-node-server-meta">
            {snap ? bits.join(' · ') : ''}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400" id="admin-node-conn">
          <span id="admin-node-led" className={LED[conn]} />
          <span id="admin-node-conn-text">{CONN_TEXT[conn]}</span>
        </div>
      </div>

      <div className={`${AdminUI.card} p-6 mb-4`}>
        <h3 className={`${AdminUI.cardTitle} mb-3`}>Node</h3>
        {snap ? <NodeCard n={snap.node} /> : <div id="admin-node-body" className={NodeUI.empty}>Loading…</div>}
      </div>

      <div className={`${AdminUI.card} p-6 mb-4`}>
        <h3 className={`${AdminUI.cardTitle} mb-3`}>Explorer</h3>
        {snap ? <ExplorerCard ex={snap.explorer} /> : <div id="admin-node-explorer-body" className={NodeUI.empty}>Loading…</div>}
      </div>

      <div className={`${AdminUI.card} p-6 mb-4`}>
        <h3 className={`${AdminUI.cardTitle} mb-3`}>Chain-dependent services</h3>
        {snap ? <ServicesCard svc={snap.services || {}} /> : <div id="admin-node-services-body" className={NodeUI.empty}>Loading…</div>}
      </div>

      <div className={`${NodeUI.small} mt-[18px] text-center`}>
        {'Updated '}<span id="admin-node-last-updated">{snap ? fmtTime(snap.at) : '—'}</span>{' · polling '}
        <Code>/api/node-status/full</Code>{' every 2s · JSON snapshot at '}
        <a href="/api/node-status/full" target="_blank" rel="noopener" className={NodeUI.link}>/api/node-status/full</a>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminNode = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <NodeSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminNode = AdminNode;

export { AdminNode };
