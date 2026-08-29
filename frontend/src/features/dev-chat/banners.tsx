/**
 * `#dc-banners`' children — the four strips between the dev chat's session
 * header and its panes. See ./banners-store.ts for the split and for why the
 * host generates no box.
 */

import { useCallback, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  CheckIcon,
  ClockIcon,
  PlusIcon,
  SpinnerArcIcon,
  UserCircleIcon,
  WarningTriangleIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import {
  bannersStore,
  type CreditsBannerView,
  type NewChangeBannerView,
  type SyncBannerView,
} from './banners-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

const BUSY_TITLE = 'Claude is busy with a turn. Sync will be available when it finishes';

const SYNC_BTN
  = 'rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-60 disabled:cursor-not-allowed'
  + ' px-3 py-1 text-xs font-medium text-white transition-colors shrink-0';

/**
 * The four banner shells differ only in their tint, so the class strings are a
 * table rather than four hand-copied literals — the same reason the topic
 * head's note box is one shape. Every entry is a COMPLETE literal: Tailwind's
 * extractor is a regex over source text, so a class assembled from a variable
 * is a class that never gets compiled.
 */
const SHELL = {
  amber: 'flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs',
  emerald: 'flex items-center gap-2 px-3 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-900/50 text-xs',
  violet: 'flex items-center gap-2 px-3 py-2 bg-violet-50 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-900/50 text-xs',
  creditsAmber: 'flex flex-wrap items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs',
  creditsRed: 'flex flex-wrap items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900/50 text-xs',
} as const;

/** The credits banners' glyph, keyed by the reason the banner is up. */
const CREDITS_ICON = {
  person: UserCircleIcon,
  warn: WarningTriangleIcon,
  clock: ClockIcon,
} as const;

function SyncBanner({ b }: { b: SyncBannerView }): ReactNode {
  const onSync = () => controller()?.startSyncWithMain?.();
  if (b.kind === 'inflight') {
    return (
      <div id="dc-sync-banner" className={SHELL.amber}>
        <SpinnerArcIcon className="w-4 h-4 animate-spin text-amber-800 dark:text-amber-400 shrink-0" />
        <span className="text-amber-800 dark:text-amber-200 flex-1">{b.message}</span>
        <button id="dc-sync-btn" type="button" disabled className={SYNC_BTN}>Syncing…</button>
      </div>
    );
  }
  if (b.kind === 'ok') {
    return (
      <div id="dc-sync-banner" className={SHELL.emerald}>
        <CheckIcon className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <span className="text-emerald-800 dark:text-emerald-200 flex-1">{b.message}</span>
      </div>
    );
  }
  const warn = <WarningTriangleIcon className="w-4 h-4 text-amber-800 dark:text-amber-400 shrink-0" />;
  if (b.kind === 'failed') {
    return (
      <div id="dc-sync-banner" className={SHELL.amber}>
        {warn}
        <span className="text-amber-800 dark:text-amber-200 flex-1">{b.message}</span>
        <button
          id="dc-sync-btn" type="button" className={SYNC_BTN}
          disabled={b.busy} title={b.busy ? BUSY_TITLE : undefined} onClick={onSync}
        >Try again</button>
      </div>
    );
  }
  return (
    <div id="dc-sync-banner" className={SHELL.amber}>
      {warn}
      {/* One text node with a bold count inside it, as the template wrote it. */}
      <span className="text-amber-800 dark:text-amber-200 flex-1">
        {'main has moved '}
        <span className="font-semibold">{b.behind}</span>
        {` ${b.behind === 1 ? 'commit' : 'commits'} ahead of this branch.`}
      </span>
      <button
        id="dc-sync-btn" type="button" className={SYNC_BTN}
        disabled={b.busy} title={b.busy ? BUSY_TITLE : undefined} onClick={onSync}
      >Sync with main</button>
    </div>
  );
}

function NewChangeBanner({ b }: { b: NewChangeBannerView }): ReactNode {
  return (
    <div id="dc-new-change-banner" className={SHELL.violet}>
      <PlusIcon className="w-4 h-4 text-violet-700 dark:text-violet-400 shrink-0" />
      <span className="text-violet-800 dark:text-violet-200 flex-1">
        {`This change has been ${b.stateLabel}. New work in this chat is added to the same PR, so start a new change to keep PRs focused.`}
      </span>
      {/* The one primary-filled button on these four strips, so it routes
          through the shell's <Button> — `pill` + `dim60` + `xsText` + `solid`
          spells the hand-written string it replaces, in that order, with
          `shrink-0` arriving last through className exactly as it did. */}
      <Button
        id="dc-new-change-btn" type="button"
        variant="pill" disabledStyle="dim60" size="xsText" ink="solid"
        className="shrink-0"
        disabled={b.pending}
        onClick={() => controller()?.startNewChange?.()}
      >
        {b.pending ? 'Starting…' : 'Start a new change'}
      </Button>
    </div>
  );
}

const ICON_CLASS = {
  amber: 'w-4 h-4 text-amber-800 dark:text-amber-400 shrink-0',
  red: 'w-4 h-4 text-red-700 dark:text-red-400 shrink-0',
} as const;

const TEXT_CLASS = {
  amber: 'text-amber-900 dark:text-amber-200 flex-1 min-w-[14rem]',
  red: 'text-red-800 dark:text-red-200 flex-1 min-w-[14rem]',
} as const;

function CreditsBanner({ b }: { b: CreditsBannerView }): ReactNode {
  // `CreditOptions.wire` binds one delegated click per element and guards
  // itself with `__creditOptionsWired`, so a ref that runs on every mount is
  // exactly right — and adding a listener is not a DOM write, so the buttons
  // it drives stay this component's markup with no second author.
  const wireRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const CO = (window as any).CreditOptions;
    const N = controller();
    CO?.wire?.(el, {
      onFlow: (flow: string) => N?._devFlowFromCredits?.(flow),
      // Blocked only on the RED banner: credits are low, not gone, on the
      // amber one, and marking the in-chat venue unavailable there would be
      // a lie told early.
      onVenue: (button: HTMLElement) => (b.blockedVenue
        ? N?.openVenueSheet?.(button, { blocked: true })
        : N?.openVenueSheet?.(button)),
    });
  }, [b.blockedVenue]);

  const Icon = b.icon ? CREDITS_ICON[b.icon] : null;
  return (
    <div id={b.id} className={b.tone === 'red' ? SHELL.creditsRed : SHELL.creditsAmber} ref={wireRef}>
      {Icon ? <Icon className={ICON_CLASS[b.tone]} /> : null}
      <span className={TEXT_CLASS[b.tone]}>
        <span className="font-semibold" {...(b.leadTagged ? { 'data-credits-low-lead': '1' } : null)}>{b.lead}</span>
        {b.reset === null ? b.tail : (
          <>
            <span data-credits-reset="1">{` ${b.reset}`}</span>
            {b.tail}
          </>
        )}
      </span>
      {/* Another module's markup, and a declared check selects into it — so it
          arrives whole, through a host that generates no box so the actions
          block stays the banner's own flex child. */}
      <span className="contents" dangerouslySetInnerHTML={{ __html: b.actionsHtml }} />
    </div>
  );
}

export function DevChatBanners(): ReactNode {
  const s = useStoreState(bannersStore);
  return (
    <>
      {s.sync ? <SyncBanner b={s.sync} /> : null}
      {s.newChange ? <NewChangeBanner b={s.newChange} /> : null}
      {s.credits ? <CreditsBanner b={s.credits} /> : null}
      {s.creditsLow ? <CreditsBanner b={s.creditsLow} /> : null}
    </>
  );
}

export { SyncBanner, NewChangeBanner, CreditsBanner };
