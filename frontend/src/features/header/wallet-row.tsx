/**
 * `#account-row-wallet` — the balance readout in the Profile screen's account group.
 * See ./wallet-sheet-store.ts for what the seam carries.
 */

import { type ReactNode } from 'react';

import { WalletIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { useMessages } from '../../lib/i18n/react';
import { walletSheetStore } from './wallet-sheet-store';
import { nodePillStore } from './node-pill-store';
import { styleFor } from './node-pill-row';
import { ACCOUNT_ROW, ACCOUNT_ROW_MUTED, ACCOUNT_ROW_TITLE, NODE_DOWN } from './account-row';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).WalletSheet : null) || null;
}

export function WalletRow(): ReactNode {
  const s = useStoreState(walletSheetStore);
  const node = useStoreState(nodePillStore) as { visible: boolean; status: string };
  const t = useMessages('wallet');
  // With no balance to show and the node down, the row says the node's word
  // ("Unavailable") rather than "— UT" (phone review #120).
  const down = !s.balanceKnown && node.visible && NODE_DOWN.has(node.status);
  return (
    <button
      id="account-row-wallet"
      className={s.visible ? ACCOUNT_ROW : `hidden ${ACCOUNT_ROW}`}
      onClick={() => controller()?.openFromRow?.()}
    >
      <WalletIcon className="w-5 h-5 shrink-0" />
      <span className={ACCOUNT_ROW_TITLE}>
        {t('wallet:row.label')}
      </span>
      {/* Blank until the module has a snapshot — the hand-written row shipped
          this span empty and the prerender has to agree. */}
      <span
        id="account-wallet-balance"
        data-wallet-balance={down ? 'unavailable' : undefined}
        className={down ? ACCOUNT_ROW_MUTED : 'ms-auto text-[0.8125rem] font-semibold text-violet-700 dark:text-violet-400'}
      >{down ? t(styleFor(node.status).labelId) : s.balanceLabel}</span>
    </button>
  );
}
