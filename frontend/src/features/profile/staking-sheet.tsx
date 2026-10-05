import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { StakingIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { walletSheetStore, WALLET_EMPTY, type WalletSheetState } from '../header/wallet-sheet-store';
import { createStakingHistory } from './staking-history.js';

const controller = () => (window as any).WalletSheet;

export function StakingRow() {
  useUiLanguage();
  const liveWallet = useStoreState(walletSheetStore);
  const [preview, setPreview] = useState<WalletSheetState | null>(null);
  useEffect(() => {
    const demo = new URLSearchParams(location.search).get('demo');
    if (demo !== 'staking-active' && demo !== 'staking-delegated') return;
    const abort = new AbortController();
    fetch(`/api/me/staking/demo?state=${demo === 'staking-delegated' ? 'delegated' : 'active'}`, {
      credentials: 'same-origin', signal: abort.signal,
    }).then(async (r) => {
      if (!r.ok) return;
      const data = await r.json();
      if (abort.signal.aborted) return;
      setPreview({ ...WALLET_EMPTY, visible: true, walletSupported: true, ...data });
      setOpen(true);
    }).catch(() => {});
    return () => abort.abort();
  }, []);
  const wallet = preview || liveWallet;
  const [open, setOpen] = useState(false);
  const visible = wallet.visible && wallet.staking.kind !== 'absent';
  const delegated = wallet.staking.kind === 'delegated';
  const ready = wallet.staking.kind === 'local' || delegated;
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  if (!visible) return null;
  return <>
    <button type="button" data-staking-row
      className="flex items-center gap-3 px-4 min-h-[44px] w-full text-left text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
      onClick={() => setOpen(true)}>
      <StakingIcon aria-hidden="true" className="w-5 h-5 shrink-0" />
      <span className="text-sm font-medium"><Message id="account:staking_5190ff48" /></span>
      <span className={delegated ? 'ml-auto text-xs font-semibold text-violet-700 dark:text-violet-400'
        : ready ? 'ml-auto text-xs font-semibold text-emerald-700 dark:text-emerald-400'
          : 'ml-auto text-xs text-zinc-500 dark:text-zinc-400'}><LocalizedValue render={() => (ready ? (delegated ? tr("account:delegated_dd341e5d") : tr("account:active_92340695")) : tr("account:checking_ec963ffc"))} /></span>
      <span aria-hidden="true">›</span>
    </button>
    {open ? <StakingSheet preview={preview} onClose={() => setOpen(false)} /> : null}
  </>;
}

function StakingSheet({ onClose, preview }: { onClose: () => void; preview: WalletSheetState | null }) {
  useUiLanguage();
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onClose); dismiss.current = onClose;
  const [adopted, setAdopted] = useState(false);
  const wallet = useStoreState(walletSheetStore);
  useIsomorphicLayoutEffect(() => {
    if (!panel.current) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'sheet', contentEl: panel.current, home: 'placeholder', gate: 'kit',
      onDismiss: () => { adoption = null; dismiss.current(); },
    });
    setAdopted(!!adoption);
    panel.current.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (adoption) adoption.release();
      previousFocus?.focus?.();
    };
  }, []);
  return <div className={adopted ? 'contents' : 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-3'}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <Localized element={<div ref={panel} data-staking-sheet role="dialog" aria-modal="true" aria-label={catalogText("account:staking_5190ff48")}
      className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl p-4 flex-col max-h-[85dvh] overflow-y-auto"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) return;
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold"><Message id="account:staking_5190ff48" /></h2>
        <Localized element={<Button aria-label={catalogText("account:close_staking_79ed4531")} variant="neutral" size="sm" onClick={onClose}>×</Button>} messages={{"aria-label":"account:close_staking_79ed4531"}} />
      </div>
      <StakingContent wallet={preview || wallet} demo={!!preview} />
    </div>} messages={{"aria-label":"account:staking_5190ff48"}} />
  </div>;
}

// Delegated is an early return: no status card, explanatory copy, epoch hook
// or network request is mounted in that state.
export function StakingContent({ wallet, demo = false }: { wallet: WalletSheetState; demo?: boolean }) {
  const manage = async () => {
    if (demo) { (window as any).PlatformUI?.toast?.(tr("account:open_the_homeroom_app_to_manage_delegation_7eab752b")); return; }
    await controller()?._manageStaking?.();
    const error = walletSheetStore.get().stateError;
    if (error) (window as any).PlatformUI?.toast?.(error, { error: true });
  };
  if (wallet.staking.kind === 'delegated') return <Button layout="full" size="narrowBold"
    disabled={wallet.stakingPending} onClick={() => { void manage(); }}>
    <LocalizedValue render={() => (wallet.stakingPending ? tr("account:opening_c926c2c5") : tr("account:undelegate_d151bd27"))} />
  </Button>;
  if (wallet.staking.kind !== 'local' || !wallet.address) return <div>
    <p className="text-sm text-zinc-500 dark:text-zinc-400"><Message id="account:staking_status_is_not_available_yet_14c3ec26" /></p>
    <Button layout="full" size="narrowBold" className="mt-3" disabled={wallet.refreshPending}
      onClick={() => controller()?.retryState?.()}><LocalizedValue render={() => (wallet.refreshPending ? tr("account:checking_ec963ffc") : tr("account:retry_942087cc"))} /></Button>
  </div>;
  return <>
    <div className="mb-4 text-sm font-semibold text-emerald-700 dark:text-emerald-400"><Message id="account:active_597137f2" /></div>
    <Button layout="full" size="narrowBold" disabled={wallet.stakingPending}
      onClick={() => { void manage(); }}><LocalizedValue render={() => (wallet.stakingPending ? tr("account:opening_c926c2c5") : tr("account:delegate_760ed960"))} /></Button>
    <ActiveEpochs key={wallet.address} wallet={wallet.address} demo={demo} />
  </>;
}

async function readPreview(path: string, signal: AbortSignal) {
  const response = await fetch(path + (path.includes('?') ? '&' : '?') + 'demo=staking', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(tr("account:could_not_load_the_preview_8dadb1e0"));
  return response.json();
}

function ActiveEpochs({ wallet, demo }: { wallet: string; demo: boolean }) {
  useUiLanguage();
  const [history] = useState(() => createStakingHistory(wallet, demo ? {
    read: readPreview,
    readEpoch: ({ epoch }: { epoch: string }, signal: AbortSignal) =>
      readPreview('/api/me/staking/epochs?epoch=' + encodeURIComponent(epoch), signal),
  } : {}));
  const state = useStoreState(history.store);
  useEffect(() => {
    void history.refresh();
    const refresh = () => { if (document.visibilityState !== 'hidden') void history.refresh(); };
    const timer = setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); history.dispose(); };
  }, [history]);
  if (state.selectedEpoch === null) return <div className="mt-5" role="status">
    <p className="text-sm text-zinc-500 dark:text-zinc-400"><LocalizedValue render={() => (state.error || tr("account:loading_epoch_data_b4d22786"))} /></p>
    {state.error ? <Button className="mt-3" size="sm" onClick={() => { void history.refresh(); }}><Message id="account:retry_942087cc" /></Button> : null}
  </div>;
  return <div className="mt-5">
    <EpochCarousel state={state} select={(epoch: number) => { void history.select(epoch); }} retry={() => { void history.retry(); }} />
    {state.error ? <p role="status" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{state.error}</p> : null}
  </div>;
}

export function EpochCard({ epoch, record, current, error, retry }: any) {
  return <section data-staking-epoch={epoch} className="rounded-2xl border border-zinc-200 dark:border-zinc-700 p-5 h-full">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-lg font-bold"><RichMessage id="account:sentence_b547457bf7e3" values={{ value1: epoch }} /></h3>
      {current || record?.complete ? <span className="text-xs text-zinc-500 dark:text-zinc-400"><LocalizedValue render={() => (current ? tr("account:current_e0d1b682") : tr("account:completed_22a970d2"))} /></span> : null}
    </div>
    {record?.counts ? <>
      <div className="mt-5 text-sm text-zinc-500 dark:text-zinc-400"><Message id="account:won_slots_32dbf5c2" /></div>
      <div className="mt-1 text-4xl font-bold tabular-nums">{record.counts.won}</div>
      <div className="mt-5 pt-4 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-3 gap-2 text-center">
        {[
          [tr("account:upcoming_5f1a2542"), record.counts.upcoming, 'text-amber-700 dark:text-amber-300'],
          [tr("account:produced_3b22f22b"), record.counts.produced, 'text-emerald-700 dark:text-emerald-400'],
          [tr("account:missed_3d86eb08"), record.counts.missed, 'text-red-700 dark:text-red-400'],
        ].map(([label, count, color], index) => <div key={index} className={color}>
          <div className="text-2xl font-bold tabular-nums">{count}</div><div className="mt-1 text-xs">{label}</div>
        </div>)}
      </div>
      {record.counts.unobserved > 0 ? <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:some_slots_have_no_confirmed_observation_f8aef0bc" /></p> : null}
    </> : <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400" role="status"><LocalizedValue render={() => (error || (record ? tr("account:epoch_data_is_still_being_collected_2db0cb85") : tr("account:loading_epoch_data_b4d22786")))} /></p>}
    {error ? <Button size="sm" className="mt-3" onClick={retry}><Message id="account:retry_942087cc" /></Button> : null}
  </section>;
}

export function EpochCarousel({ state, select, retry }: any) {
  const rail = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const centering = useRef(false);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const epoch = state.selectedEpoch;
  const epochs = [epoch - 1, epoch, epoch + 1].filter((e) => e >= 0 && e <= state.currentEpoch);
  useIsomorphicLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    centering.current = true;
    el.scrollLeft = epochs.indexOf(epoch) * (el.clientWidth - 12);
    const frame = requestAnimationFrame(() => { centering.current = false; });
    return () => { cancelAnimationFrame(frame); clearTimeout(settle.current); };
  }, [epoch, state.currentEpoch]);
  function finishScroll() {
    const el = rail.current;
    if (!el || centering.current || drag.current) return;
    const index = Math.max(0, Math.min(epochs.length - 1, Math.round(el.scrollLeft / (el.clientWidth - 12))));
    if (epochs[index] !== epoch) select(epochs[index]);
  }
  return <>
    <Localized element={<div ref={rail} data-staking-epochs aria-label={catalogText("account:epoch_history_8ee90f94")}
      className="flex gap-3 overflow-x-auto overscroll-x-contain snap-x snap-mandatory pb-2 select-none"
      style={{ scrollbarWidth: 'none', touchAction: 'pan-x' }}
      onScroll={() => { clearTimeout(settle.current); settle.current = setTimeout(finishScroll, 140); }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.style.scrollSnapType = 'none';
      }}
      onPointerMove={(event) => { if (drag.current) event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finishScroll(); event.currentTarget.style.scrollSnapType = '';
      }}
      onPointerCancel={(event) => { drag.current = null; event.currentTarget.style.scrollSnapType = ''; }}>
      {epochs.map((e) => <div key={e} className="shrink-0 snap-start" style={{ width: 'calc(100% - 24px)' }}>
        <EpochCard epoch={e} record={state.records[e]} current={e === state.currentEpoch} error={state.errors[e]} retry={retry} />
      </div>)}
    </div>} messages={{"aria-label":"account:epoch_history_8ee90f94"}} />
    <div className="flex items-center justify-between gap-2 mt-3">
      <Localized element={<Button aria-label={catalogText("account:previous_epoch_c7451870")} variant="neutral" size="sm" disabled={epoch === 0} onClick={() => select(epoch - 1)}>‹</Button>} messages={{"aria-label":"account:previous_epoch_c7451870"}} />
      <span className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:swipe_to_browse_epochs_f2b51e33" /></span>
      <Localized element={<Button aria-label={catalogText("account:next_epoch_49deb5cc")} variant="neutral" size="sm" disabled={epoch === state.currentEpoch} onClick={() => select(epoch + 1)}>›</Button>} messages={{"aria-label":"account:next_epoch_49deb5cc"}} />
    </div>
  </>;
}
