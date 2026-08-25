/**
 * The node detail sheet's body.
 * See ./node-pill-store.ts for what the seam carries.
 *
 * ── The kit still owns the sheet; React owns what is inside it ────────
 *
 * `PlatformUI.sheet({ contentEl })` reparents the element it is handed and
 * writes its own classes onto it, so the PANEL stays the module's — built with
 * `createElement`, handed over, dismissed by the kit. What was rebuilt from
 * scratch on every status event is the BODY: `body.textContent = ''` followed
 * by six imperative nodes, three of them from a `_sheetRow` factory that is
 * just a row of two spans.
 *
 * That body is a portal now, mounted when the sheet opens and unmounted when
 * the kit dismisses it. The store drives its contents, so a `node-status`
 * event arriving while the sheet is open repaints the numbers instead of
 * discarding and rebuilding the subtree under the user's finger.
 */

import { type ReactNode } from 'react';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { useStoreState } from '../../lib/use-store-state';
import { nodePillStore } from './node-pill-store';
import { styleFor } from './node-pill-row';

const ROW = 'flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800 text-sm';

/** `—`, not `0`: an unknown height and a height of zero are different facts. */
const fmt = (n: number | null): string => (n == null ? '—' : Number(n).toLocaleString());

function SheetRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={ROW}>
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="font-medium text-zinc-800 dark:text-zinc-100">{value}</span>
    </div>
  );
}

function peersLabel(connected: number | null, total: number | null): string {
  if (connected == null) return '—';
  return `${fmt(connected)} connected${total != null ? ` / ${fmt(total)} known` : ''}`;
}

export function NodeSheetBody(): ReactNode {
  const s = useStoreState(nodePillStore);
  const style = styleFor(s.status);
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`}></span>
        <span className="text-base font-semibold">{style.label}</span>
      </div>
      <SheetRow label="Your block height" value={fmt(s.localBestHeight)} />
      <SheetRow label="Network block height" value={fmt(s.networkBestHeight)} />
      <SheetRow label="Peers" value={peersLabel(s.connectedPeers, s.totalPeers)} />
    </>
  );
}

/**
 * Mount/unmount helpers, so ./node-pill.js — which is plain JS with no JSX —
 * does not have to reach for `createElement` itself.
 */
export function mountNodeSheet(host: Element | null): void {
  mountLegacyPortal(host, <NodeSheetBody />);
}

export function unmountNodeSheet(host: Element | null): void {
  unmountLegacyPortal(host);
}
