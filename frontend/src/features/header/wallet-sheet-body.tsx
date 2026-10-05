import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * The wallet sheet's body.
 * See ./wallet-sheet-store.ts for what the seam carries.
 *
 * ── The kit owns the panel; React owns what is in it ──────────────────
 *
 * Same seam as ./node-pill-sheet.tsx: `PlatformUI.sheet({ contentEl })`
 * reparents the element it is handed, so the panel stays the module's and the
 * BODY is a portal. What that folds away here is larger — roughly forty
 * `createElement` calls rebuilt from scratch on every repaint, and there are
 * many: the 60s refresh, the admission reset, `_manageStaking`'s three, and
 * the send flow's.
 *
 * ── Send and Receive keep their state HERE ────────────────────────────
 *
 * `_showSend`/`_showReceive` wrote into a `#wallet-sheet-expand` div and
 * `_clearExpand()` blanked it — so a wallet refresh landing mid-typing threw
 * away a half-entered address. The expand is a `useState` now and survives a
 * repaint, which is the same fix the dev chat's share popover got.
 *
 * Send calls `window.sendTransaction`, which maps to the exact admitted native
 * `submitTransaction` operation. Social owns the returned txId and receipt.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { walletSheetStore, type StakingView, type WalletSheetState } from './wallet-sheet-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).WalletSheet : null) || null;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

const FIELD
  = 'w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700'
  + ' bg-transparent text-sm';

const ROW_LINE = 'flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800 text-sm';

// ── the block-production card ──────────────────────────────────────────

/**
 * Android only (#3059): while this phone produces blocks, the app keeps a
 * background service running with a persistent notification. Say so in plain
 * words, and say it is off when production is delegated or not set up yet.
 * The Android permission's own name never appears here.
 */
export const BACKGROUND_SERVICE_ACTIVE
  = () => (tr("account:a_background_service_keeps_running_so_this_phone_ed5d648f"));
export const BACKGROUND_SERVICE_INACTIVE
  = () => (tr("account:the_background_service_is_not_active_this_phone__e48315db"));

/** Drawn as the soft warning box, the Node sheet's health notice. */
function BackgroundServiceNote({ active }: { active: boolean }): ReactNode {
  return (
    <Alert
      variant="notice" density="compact"
      data-background-service={active ? 'active' : 'inactive'}
    >
      {active ? BACKGROUND_SERVICE_ACTIVE() : BACKGROUND_SERVICE_INACTIVE()}
    </Alert>
  );
}

export const DELEGATION_DISCLOSURE
  = () => tr("account:when_delegated_you_receive_half_the_points_you_w_ddcada4e");
export const SELF_HOSTED_NODE
  = 'Want to run a node on your own laptop or server and monitor it from your phone?'
  + ' Start the node there using the same account you use on this phone.';

/** The plain card every non-warning box in this section uses. */
const CARD = 'rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm';
const MUTED = 'mt-1 text-sm text-zinc-500 dark:text-zinc-400';

function StakingCard({ s }: { s: WalletSheetState }): ReactNode {
  const staking: StakingView = s.staking;
  if (staking.kind === 'absent') return null;
  // Order (#3059 follow-up): the phone's status, with the delegation
  // disclosure inside it; then the self-hosted node card; then, on Android,
  // the background service warning; then the action. Warnings use
  // `Alert notice`; every other box is the plain CARD.
  return (
    <section data-block-production className="mb-4 space-y-3">
      <div className="text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400"><Message id="account:block_production_240dbb91" /></div>
      <div data-block-production-card="status" className={CARD}>
        {staking.kind === 'pending' ? (
          // Setup unfinished is NOT "not delegated": it offers a retry.
          <div className="text-base font-semibold"><Message id="account:wallet_setup_is_still_in_progress_2005085e" /></div>
        ) : (
          <>
            <div className="text-base font-semibold">
              <LocalizedValue render={() => (staking.kind === 'delegated' ? tr("account:delegated_dd341e5d") : tr("account:producing_blocks_on_this_phone_6d7375a7"))} />
            </div>
            <div className={MUTED}>
              <LocalizedValue render={() => (staking.kind === 'delegated'
                ? tr("account:block_production_on_this_phone_is_disabled_d42a865a")
                : tr("account:producing_blocks_directly_on_this_phone_earns_fu_2cc45c90"))} />
            </div>
            {staking.kind === 'delegated' ? (
              <>
                <div className="mt-2 font-mono text-xs">{staking.delegate}</div>
                {staking.since ? (
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <LocalizedValue render={() => (tr("account:delegated_since_value1_f884d697", { value1: staking.since }))} />
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
        <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {DELEGATION_DISCLOSURE()}
        </div>
      </div>
      <div data-block-production-card="self-hosted" className={CARD}>
        {SELF_HOSTED_NODE}
      </div>
      {s.isAndroid
        ? <BackgroundServiceNote active={staking.kind === 'local'} />
        : null}
      {staking.kind === 'pending' ? (
        <Button
          layout="full" size="narrowBold"
          disabled={s.refreshPending}
          onClick={() => controller()?.retryState?.()}
        ><LocalizedValue render={() => (s.refreshPending ? tr("account:retrying_a16c8b1c") : tr("account:retry_942087cc"))} /></Button>
      ) : (
        <Button
          layout="full" size="narrowBold"
          disabled={s.stakingPending}
          onClick={() => controller()?._manageStaking?.()}
        ><LocalizedValue render={() => (s.stakingPending ? tr("account:opening_c926c2c5") : tr("account:manage_delegation_0f6f168b"))} /></Button>
      )}
    </section>
  );
}

// ── send / receive ─────────────────────────────────────────────────────

function ReceivePanel({ address }: { address: string }): ReactNode {
  const qrRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = qrRef.current;
    const QR = (window as any).QRCode;
    if (!el || !QR) return;
    el.textContent = '';
    // The QR library writes its own canvas/img into this node. It is the one
    // element in this subtree React does not own, which is why it is empty in
    // render and filled from an effect on a ref.
    // eslint-disable-next-line no-new
    new QR(el, { text: address, width: 160, height: 160 });
  }, [address]);
  return (
    <div className="flex flex-col items-center gap-2 p-4 mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div ref={qrRef} className="bg-white p-2 rounded"></div>
      <div className="font-mono text-xs break-all text-center text-zinc-500 dark:text-zinc-400">
        {address}
      </div>
    </div>
  );
}

function SendForm({ onSent }: { onSent: () => void }): ReactNode {
  useUiLanguage();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const toRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { toRef.current?.focus(); }, []);

  const submit = async () => {
    const addr = to.trim();
    const n = parseInt(amount.trim(), 10);
    if (!addr || !addr.startsWith('ut1')) { ui()?.toast?.(tr("account:enter_a_valid_ut1_address_5f32c4a4")); return; }
    if (!Number.isFinite(n) || n <= 0) { ui()?.toast?.(tr("account:enter_a_positive_amount_b3284370")); return; }
    setSending(true);
    const ok = await controller()?.sendFromSheet?.(addr, n);
    if (ok) onSent(); else setSending(false);
  };

  return (
    <div className="flex flex-col gap-2 p-4 mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <Localized element={<input
        ref={toRef} placeholder={catalogText("account:recipient_address_ut1_109cc6d5")} aria-label={catalogText("account:recipient_address_454d0391")}
        className={`${FIELD} font-mono`}
        value={to} onChange={(e) => setTo(e.target.value)}
      />} messages={{"placeholder":"account:recipient_address_ut1_109cc6d5","aria-label":"account:recipient_address_454d0391"}} />
      <Localized element={<input placeholder={catalogText("account:amount_49e96d7c")} aria-label={catalogText("account:amount_49e96d7c")} inputMode="numeric" className={FIELD}
        value={amount} onChange={(e) => setAmount(e.target.value)}
      />} messages={{"placeholder":"account:amount_49e96d7c","aria-label":"account:amount_49e96d7c"}} />
      <Button size="flushBold" disabled={sending} onClick={submit}><Message id="account:send_f6f4688f" /></Button>
      <div className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:you_will_confirm_this_transaction_on_the_next_sc_f4cff83e" /></div>
    </div>
  );
}

// ── the body ───────────────────────────────────────────────────────────

export function WalletSheetBody(): ReactNode {
  useUiLanguage();
  const s = useStoreState(walletSheetStore);
  const [expand, setExpand] = useState<'none' | 'send' | 'receive'>('none');
  return (
    <>
      <div className="text-3xl font-bold mb-1">{s.balanceLabel}</div>
      <div className="flex items-center gap-2 mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="font-mono">{s.shortAddress}</span>
        {s.address ? (
          <button
            className="text-violet-700 hover:text-violet-400 text-xs font-medium dark:text-violet-400"
            onClick={() => controller()?.copyAddress?.()}
          ><Message id="account:copy_e21f935f" /></button>
        ) : null}
      </div>
      <div className="flex gap-2 mb-4">
        <Button
          layout="flex" size="flushBold" disabled={!s.submissionSupported}
          onClick={() => setExpand('send')}
        ><Message id="account:send_f6f4688f" /></Button>
        <button
          className="flex-1 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => setExpand('receive')}
        ><Message id="account:receive_bac9d15a" /></button>
      </div>
      {!s.walletSupported ? (
        <div className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-500 dark:text-zinc-400"><Message id="account:wallet_state_is_unavailable_in_this_app_version_33942b8b" /></div>
      ) : null}
      {!s.submissionSupported ? (
        <div className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-500 dark:text-zinc-400"><Message id="account:transaction_submission_is_unavailable_in_this_ap_912ac960" /></div>
      ) : null}
      {s.stateError ? (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {s.stateError}
        </div>
      ) : null}
      <StakingCard s={s} />
      <div id="wallet-sheet-expand">
        {expand === 'receive' && s.address ? <ReceivePanel address={s.address} /> : null}
        {expand === 'send' ? <SendForm onSent={() => setExpand('none')} /> : null}
      </div>
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-2 mb-1"><Message id="account:recent_690dbe9d" /></div>
      <div>
        {s.receipts == null
          ? <div className="text-sm text-zinc-500 py-2 dark:text-zinc-400"><Message id="account:loading_ba3bbbe1" /></div>
          : s.receipts.length === 0
            ? <div className="text-sm text-zinc-500 py-2 dark:text-zinc-400"><Message id="account:no_recent_transactions_yet_33e015b2" /></div>
            : s.receipts.slice(0, 20).map((r) => (
              <div key={r.key} className={ROW_LINE}>
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.line1}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{r.line2}</div>
                </div>
              </div>
            ))}
      </div>
    </>
  );
}

/** Mount helpers, so ./wallet-sheet.js needs no `createElement` of its own. */
export function mountWalletSheet(host: Element | null): void {
  mountLegacyPortal(host, <WalletSheetBody />);
}

export function unmountWalletSheet(host: Element | null): void {
  unmountLegacyPortal(host);
}
