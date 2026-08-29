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

// A DEAD FILL on hover, and the only one left in the product. Under white ink
// amber-600 measures Lc -77.5 (body) but amber-500 measures -54.9, and on that
// fill NEITHER white (-54.9) nor near-black (54.2) clears the 75 body minimum —
// so the label could not be repaired by changing the ink, only by moving the
// fill. Every other coloured filled button in the tree already goes one step
// DARKER on hover under white ink (`bg-red-600 hover:bg-red-700` x5,
// `bg-meadow-600 hover:bg-meadow-700` x2); this was the sole outlier going
// lighter, which is the YELLOW ramp's rule (near-black ink) applied to a ramp
// that carries white. amber-700 is Lc -85.3.
//
// The leading space on the second fragment is load-bearing: a concatenation
// seam with no separator glues the two tokens and Tailwind compiles NEITHER.
const SYNC_BTN
  = 'rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed'
  + ' px-3 py-1 text-xs font-medium text-white transition-colors shrink-0';

/**
 * The four banner shells differ only in their tint, so the class strings are a
 * table rather than four hand-copied literals — the same reason the topic
 * head's note box is one shape. Every entry is a COMPLETE literal: Tailwind's
 * extractor is a regex over source text, so a class assembled from a variable
 * is a class that never gets compiled.
 *
 * THE KEYS NAME THE RAMP THEY HOLD. Two of them had stopped: `emerald` held
 * stock `emerald-*` (not an overridden ramp, so it rendered untuned Tailwind
 * green beside the platform's own) and is `meadow` now, the product's ONE
 * green; `violet` had already been reskinned to `azure-*` and kept the old
 * name, which is the exact trap AGENTS.md warns about — read the hex, not the
 * key. Renamed rather than left, since a key that lies is how the next hand
 * reaches for a hue it did not mean.
 */
const SHELL = {
  amber: 'flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs',
  meadow: 'flex items-center gap-2 px-3 py-2 bg-meadow-50 dark:bg-meadow-950/30 border-b border-meadow-200 dark:border-meadow-900/50 text-xs',
  azure: 'flex items-center gap-2 px-3 py-2 bg-azure-50 dark:bg-azure-950/30 border-b border-azure-200 dark:border-azure-900/50 text-xs',
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
        <SpinnerArcIcon className="w-4 h-4 animate-spin text-amber-800 dark:text-amber-200 shrink-0" />
        <span className="text-amber-800 dark:text-amber-200 flex-1">{b.message}</span>
        <button id="dc-sync-btn" type="button" disabled className={SYNC_BTN}>Syncing…</button>
      </div>
    );
  }
  if (b.kind === 'ok') {
    return (
      <div id="dc-sync-banner" className={SHELL.meadow}>
        {/* The glyph's dark step was `-400`, two tiers under the message it
            sits beside; on this ramp a light 700 ink pairs with a dark 200,
            which is what the text span next to it already spelled. */}
        <CheckIcon className="w-4 h-4 text-meadow-700 dark:text-meadow-200 shrink-0" />
        <span className="text-meadow-800 dark:text-meadow-200 flex-1">{b.message}</span>
      </div>
    );
  }
  const warn = <WarningTriangleIcon className="w-4 h-4 text-amber-800 dark:text-amber-200 shrink-0" />;
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
    <div id="dc-new-change-banner" className={SHELL.azure}>
      {/* The dark step MATCHES the message span beside it, which is this
          file's own convention for all four strips: the amber sync glyph is
          -200 against amber-200 text, the meadow ok glyph is -200 against
          meadow-200 text, and the credits red/amber glyphs are -200 against
          -200 text. Light may differ by one tier (glyph 700, text 800) and
          does everywhere; the DARK halves do not. `dark:text-azure-300`
          (Lc -66.5 on the #1F1F1B card, APCA-W3 0.1.9 as ported in
          tests/theme-ink-guards.test.js) left this one glyph a rung under
          its own sentence at -81.4 — the single strip in the file where a
          glyph and its text disagree in dark. */}
      <PlusIcon className="w-4 h-4 text-azure-700 dark:text-azure-200 shrink-0" />
      <span className="text-azure-800 dark:text-azure-200 flex-1">
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
  amber: 'w-4 h-4 text-amber-800 dark:text-amber-200 shrink-0',
  red: 'w-4 h-4 text-red-700 dark:text-red-200 shrink-0',
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
