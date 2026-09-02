/**
 * The native wallet's drawer row and detail sheet, as one view model.
 *
 * ── One store, two surfaces, for the reason node-pill's is one ────────
 *
 * `_renderChip` and `_renderSheetBody` read the same `_state` snapshot, and
 * every path that changed it called both — the 60s refresh, the admission
 * reset, `_manageStaking`'s three calls, the send flow. Two stores would have
 * been two copies of "what does the wallet hold".
 *
 * ── What stays the module's ───────────────────────────────────────────
 *
 * Native bridge calls are `getWalletState`, `manageStaking` and the admitted
 * `submitTransaction` behind the public `sendTransaction` wrapper. Receipts
 * are persisted and observed by Social; they never come back from native.
 *
 * ── The strings are resolved before they get here ─────────────────────
 *
 * `balanceLabel`, `shortAddress` and each receipt's two lines are formatted by
 * the module, which owns the symbol, the address elision and the confirmed /
 * pending / unknown ladder. Same "resolved data in, markup out" seam the dev
 * chat's transcript uses: the component decides shape, never wording.
 */

import { createStore } from '../../lib/plain-store.js';

/** One transaction receipt, already worded. */
export interface WalletReceipt {
  key: string;
  line1: string;
  line2: string;
}

/**
 * The block-production card's four states.
 *
 * `pending` is the one worth naming: `staking == null` means wallet setup has
 * not finished, which is NOT the same as "not delegated" and must not render
 * as it — it offers a Retry instead.
 */
export type StakingView =
  | { kind: 'absent' }
  | { kind: 'pending' }
  | { kind: 'local' }
  | { kind: 'delegated'; delegate: string; since: string };

export interface WalletSheetState {
  /** The drawer row. Present for every native top frame. */
  visible: boolean;
  balanceLabel: string;
  address: string | null;
  shortAddress: string;
  /** False on app versions without `getWalletState` — an inline note, not a hole. */
  walletSupported: boolean;
  /** Exact capability gate for the admitted native submission operation. */
  submissionSupported: boolean;
  /** Inline and non-blocking: Send, Receive and navigation stay usable. */
  stateError: string | null;
  staking: StakingView;
  stakingPending: boolean;
  refreshPending: boolean;
  /** Null is LOADING; an empty array is "none yet". Different sentences. */
  receipts: WalletReceipt[] | null;
}

export const WALLET_EMPTY: WalletSheetState = {
  visible: false,
  balanceLabel: '',
  address: null,
  shortAddress: '—',
  walletSupported: false,
  submissionSupported: false,
  stateError: null,
  staking: { kind: 'absent' },
  stakingPending: false,
  refreshPending: false,
  receipts: null,
};

export const walletSheetStore = createStore<WalletSheetState>(WALLET_EMPTY);
