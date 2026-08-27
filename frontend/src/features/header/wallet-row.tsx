/**
 * `#account-row-wallet` — the balance readout in the Profile screen's account group.
 * See ./wallet-sheet-store.ts for what the seam carries.
 */

import { type ReactNode } from 'react';

import { WalletIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { walletSheetStore } from './wallet-sheet-store';

/** The row's class run; the `hidden` in front of it is the model's. */
const ROW
  = 'flex items-center gap-3 px-4 min-h-[44px] w-full text-left relative'
  + " after:absolute after:bottom-0 after:left-12 after:right-0 after:h-px"
  + " after:bg-zinc-100 dark:after:bg-zinc-800 after:content-['']"
  + ' text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).WalletSheet : null) || null;
}

export function WalletRow(): ReactNode {
  const s = useStoreState(walletSheetStore);
  return (
    <button
      id="account-row-wallet"
      className={s.visible ? ROW : `hidden ${ROW}`}
      onClick={() => controller()?.openFromRow?.()}
    >
      <WalletIcon className="w-5 h-5 shrink-0" />
      <span className="text-sm font-medium">
        Wallet
      </span>
      {/* Blank until the module has a snapshot — the hand-written row shipped
          this span empty and the prerender has to agree. */}
      <span
        id="account-wallet-balance"
        className="ml-auto text-xs font-semibold text-violet-700 dark:text-violet-400"
      >{s.balanceLabel}</span>
    </button>
  );
}
