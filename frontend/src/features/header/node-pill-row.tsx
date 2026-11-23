/**
 * `#account-row-node` — the node status row in the Profile screen's account group.
 * See ./node-pill-store.ts for what the seam carries.
 *
 * ── Every class here is a complete literal, and that is load-bearing ──
 *
 * The module built the status ink by SUBTRACTION:
 *
 *   statusEl.className = 'ms-auto text-xs font-medium ' +
 *     style.tone.split(' ').filter((c) => !c.startsWith('border')).join(' ');
 *
 * — a `tone` string carrying both a border colour and an ink, with the border
 * stripped at runtime because this surface never wanted it. Tailwind's
 * extractor is a regex over source text, so that only ever compiled because
 * the whole `tone` literal sat in a file the extractor scans. Splitting the
 * table into `dot` and `ink`, each a complete literal, is the same rendered
 * output with nothing computed.
 */

import { type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { nodePillStore, type NodeStatusKind } from './node-pill-store';
import { ACCOUNT_ROW, ACCOUNT_ROW_TITLE } from './account-row';

export const STATUS_STYLES: Record<NodeStatusKind, {
  dot: string; labelId: string; ink: string;
}> = {
  synced: {
    dot: 'bg-emerald-500',
    labelId: 'wallet:node.status.synced',
    ink: 'text-emerald-700 dark:text-emerald-400',
  },
  syncing: {
    dot: 'bg-amber-500',
    labelId: 'wallet:node.status.syncing',
    ink: 'text-amber-800 dark:text-amber-400',
  },
  connecting: {
    dot: 'bg-zinc-400 animate-pulse',
    labelId: 'wallet:node.status.connecting',
    ink: 'text-zinc-500 dark:text-zinc-400',
  },
  offline: {
    dot: 'bg-red-500',
    labelId: 'wallet:node.status.offline',
    ink: 'text-red-700 dark:text-red-400',
  },
  unavailable: {
    dot: 'bg-zinc-400',
    labelId: 'wallet:node.status.unavailable',
    ink: 'text-zinc-500 dark:text-zinc-400',
  },
};

export function styleFor(status: string | null | undefined) {
  return STATUS_STYLES[status as NodeStatusKind] || STATUS_STYLES.unavailable;
}

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).NodePill : null) || null;
}

export function NodePillRow(): ReactNode {
  const s = useStoreState(nodePillStore);
  const t = useMessages('wallet');
  const style = styleFor(s.status);
  return (
    <button
      id="account-row-node"
      className={s.visible ? ACCOUNT_ROW : `hidden ${ACCOUNT_ROW}`}
      onClick={() => controller()?.openFromRow?.()}
    >
      <span
        id="account-node-dot"
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${style.dot}`}
        aria-hidden="true"
      >
      </span>
      <span className={ACCOUNT_ROW_TITLE}>
        {t('wallet:node.row.label')}
      </span>
      {/* Empty until the module has something to say — the hand-written row
          shipped this span blank, and the prerender has to agree. */}
      <span
        id="account-node-status"
        data-node-status={s.status}
        className={s.visible ? `ms-auto text-[0.8125rem] font-medium ${style.ink}` : 'ms-auto text-[0.8125rem] font-medium text-zinc-500 dark:text-zinc-400'}
      >{s.visible ? t(style.labelId) : ''}</span>
    </button>
  );
}
