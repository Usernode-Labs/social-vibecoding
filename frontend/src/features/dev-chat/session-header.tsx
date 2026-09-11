/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { EyeIcon, LockIcon, PencilSparklesIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { useDialog } from '../dialogs/use-dialog';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import {
  sessionHeaderStore,
  type MergeLife,
  type SessionHeaderState,
} from './session-header-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

/**
 * `MergeStatus.pillHtml`'s markup, drawn from the descriptor rather than from
 * a string.
 *
 * The text is assembled into ONE run before it is rendered, which is not
 * tidiness: the string version emitted `glyph + ' ' + label` as a single text
 * node, and splitting it into two JSX children would put a comment separator
 * between them in the server-rendered pass. Same for the space that precedes
 * the advisory chip — it belongs to the label's text node, exactly as the
 * template wrote it.
 */
export function MergeStatusPill({ life }: { life: MergeLife }): ReactNode {
  if (!life || !life.label) return null;
  const votes = life.key === 'in_vote' ? life.votes : null;
  const advisory = votes && votes.advisory > 0 ? votes.advisory : 0;
  let text = life.glyph ? `${life.glyph} ` : '';
  text += votes ? `${life.label} · ${votes.yes}/${votes.majority}` : life.label;
  if (advisory) text += ' ';
  return (
    <span className={`ms-pill ms-pill-${life.tone || 'neutral'}`} title={life.title || undefined}>
      {life.spinner ? <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span> : null}
      {text}
      {advisory ? (
        <span
          className="ms-advisory"
          title={`${advisory} advisory vote${advisory === 1 ? '' : 's'} from non-approvers, so they don’t count toward merging`}
        >
          {`+${advisory}`}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The venue dropdown, top right.
 *
 * `data-venue-change` is the hook every caller already looked the old
 * "change how this is built" link up by, and three of them still resolve this
 * button by id at call time to anchor the sheet against — so the id, the
 * attributes and the position all stay exactly as `selectorHtml` wrote them.
 */
function VenueSelect({ venue, details = false, onSelect }: {
  venue: NonNullable<SessionHeaderState['venue']>;
  details?: boolean;
  onSelect?: () => void;
}): ReactNode {
  const busyTitle = 'Wait for the current response to finish before changing where this session is built.';
  return (
    <button
      type="button"
      id={details ? 'dc-venue-details-select' : 'dc-venue-select'}
      className={details ? 'dc-venue-select dc-venue-details-select' : 'dc-venue-select max-sm:hidden'}
      data-venue-change="1"
      data-venue-current={venue.id}
      data-venue-busy={venue.disabled ? '1' : undefined}
      aria-haspopup="menu"
      aria-label={venue.disabled ? `${venue.label}. Unavailable while the agent is thinking.` : undefined}
      disabled={venue.disabled}
      title={venue.disabled ? busyTitle : venue.title}
      onClick={venue.disabled
        ? undefined
        : (e: MouseEvent<HTMLButtonElement>) => onSelect
          ? onSelect() : controller()?.openVenueSheet?.(e.currentTarget)}
    >
      <span className="dc-venue-name">{venue.label}</span>
      {venue.disabled ? (
        <span className="dc-venue-busy" aria-hidden="true">
          <LockIcon className="dc-venue-busy-icon" />
          <span>Thinking…</span>
        </span>
      ) : (
        <span className="dc-venue-caret" aria-hidden="true">{'▾'}</span>
      )}
    </button>
  );
}

/**
 * The doing<->seeing switch — the Figma session bar's quick loop.
 *
 * ── Why it is here and not in the header ───────────────────────────────
 *
 * It was an eye/pencil PAIR in the platform header's right slot, where it
 * displaced Improve. Improve is the header's standing action now (see
 * ../improve/improve-button.tsx), and this loop belongs beside the name of
 * the change it acts on anyway: it is the only genuinely contextual control
 * the product has, and a dev session is the only place it means anything.
 *
 * ── What it says ──────────────────────────────────────────────────────
 *
 * ── ONE control, not two buttons ──────────────────────────────────────
 *
 * A segmented switch on the iOS model: a single track with a THUMB that
 * slides between the two segments, rather than two pills that swap fills.
 * The difference matters because the two states are one choice — you are
 * either seeing the change or building it — and two independently-filled
 * pills read as two buttons that happen to sit together.
 *
 * The thumb is measured rather than fixed at 50%, because the segments are
 * NOT equal width: the current one carries a label and the other collapses to
 * a bare glyph, which is what keeps the strip usable at 375px next to the
 * change's name and the venue. A layout effect reads the active segment's
 * offset and width and hands them to the thumb as CSS variables; the thumb
 * animates `transform` and `width`, so the label growing and the fill
 * travelling are one movement.
 *
 * ── What the thumb says ───────────────────────────────────────────────
 *
 * The EYE opens the staging preview (seeing); the pencil-sparkles brings the
 * chat back (doing). The thumb is yellow under the eye and accent blue under
 * the pencil, and WHICHEVER segment it is under carries the label — `Preview`
 * one side, `Building` the other. Symmetrical on purpose: the label belongs
 * to the thumb, so a switch that reads `Preview` in one position has to read
 * `Building` in the other, or the control looks like it lost its word.
 *
 * `Building` used to appear only while an AI turn was in flight, on the
 * reasoning that "you are in the chat and nothing is running" is not news.
 * That made the two sides asymmetric — the thumb sat wordless half the time —
 * and a busy turn already announces itself in the transcript and the header's
 * status pill. The label keeps `#dc-mode-chip`'s id so the one thing that read
 * it still resolves.
 *
 * ── The gate ──────────────────────────────────────────────────────────
 *
 * No staging preview, no switch: a change has no preview until one is built,
 * and the rest of the platform already treats this eye as exactly that gated
 * affordance (AppView.cardPreviewHtml renders its eye only for a session with
 * a `staging_url`). With nothing to see there is no loop to draw, so the
 * strip falls back to the bare `Building` chip it used to carry.
 */
function ModeSwitch({ busy }: { busy: boolean }): ReactNode {
  const { previewSessionId, previewUrl, previewActive } = useStoreState(improveStore) as {
    previewSessionId: number | null; previewUrl: string | null; previewActive: boolean;
  };
  const seeing = !!previewActive;
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const eyeRef = useRef<HTMLButtonElement | null>(null);
  const penRef = useRef<HTMLButtonElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  // Measure AFTER the labels have laid out — the active segment's width is
  // its text's, so this cannot be computed ahead of the paint. `seeing` and
  // `busy` are the two inputs that change which segment is wide.
  useIsomorphicLayoutEffect(() => {
    if (!previewUrl) { setThumb(null); return undefined; }
    const measure = () => {
      const active = seeing ? eyeRef.current : penRef.current;
      if (!active) return;
      setThumb({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    // The label is text, so a font swap or a width change under it moves the
    // thumb — the same reason the docked staging panel watches its slot.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && trackRef.current) ro.observe(trackRef.current);
    return () => ro?.disconnect();
  }, [seeing, busy, previewUrl]);

  // #1594: with no preview to switch to, Building is status, not an action.
  // Keep it compact and neutral; the accent-filled controls remain clickable.
  if (!previewUrl) {
    if (!busy) return null;
    return (
      <span
        id="dc-mode-chip"
        role="status"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-100 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 shrink-0 cursor-default"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
        Building
      </span>
    );
  }

  const SEG_ON = 'relative z-10 flex items-center gap-1 h-6 rounded-full py-1 pr-2.5 pl-1.5 '
    + 'text-xs font-semibold un-touch-target';
  const SEG_OFF = 'relative z-10 flex items-center justify-center h-6 w-6 rounded-full '
    + 'text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 un-touch-target';

  return (
    <span
      id="dc-mode-switch"
      ref={trackRef}
      className="relative shrink-0 flex items-center rounded-full bg-zinc-200 p-0.5 dark:bg-zinc-800"
      role="group"
      aria-label="Preview or build this change"
    >
      {/* THE THUMB. One element for both states, so the fill travels rather
          than one pill vanishing and another appearing. Hidden until the
          first measurement lands, which is the same frame. */}
      <span
        aria-hidden="true"
        className={'absolute top-0.5 bottom-0.5 left-0 rounded-full transition-[transform,width] '
          + 'duration-200 ease-out '
          + (thumb ? '' : 'opacity-0 ')
          + (seeing ? 'bg-amber-300' : 'bg-violet-600')}
        style={thumb
          ? { transform: `translateX(${thumb.x}px)`, width: `${thumb.w}px` }
          : undefined}
      >
      </span>
      <button
        id="app-eye-btn"
        ref={eyeRef}
        type="button"
        className={seeing ? `${SEG_ON} text-zinc-900` : SEG_OFF}
        aria-label="Preview this change"
        aria-pressed={seeing ? 'true' : 'false'}
        title="Preview this change on staging"
        onClick={() => {
          if (seeing) return;
          (window as any).AppView?.swapToStagingForSession?.(previewSessionId, previewUrl);
        }}
      >
        <EyeIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {seeing ? <span id="dc-mode-chip">Preview</span> : null}
      </button>
      <button
        id="session-build-btn"
        ref={penRef}
        type="button"
        className={seeing ? SEG_OFF : `${SEG_ON} text-white`}
        aria-label="Back to building"
        aria-pressed={seeing ? 'false' : 'true'}
        title="Back to the session chat"
        onClick={() => {
          if (!seeing) return;
          (window as any).AppView?.closeStagingOverlay?.();
        }}
      >
        <PencilSparklesIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {!seeing ? <span id="dc-mode-chip">Building</span> : null}
      </button>
    </span>
  );
}

export function SessionHeader(): ReactNode {
  const s = useStoreState(sessionHeaderStore);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [dialogHome, setDialogHome] = useState<HTMLElement | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => { setDialogHome(document.body); }, []);
  const afterClose = useRef<(() => void) | null>(null);
  const details = useDialog('sessionDetails', {
    onOpen: () => {
      setShowDetails(true);
      // The kit moves the card into its own dialog. Name that surface (or
      // the web fallback) without giving React a second owner of its DOM.
      const surface = cardRef.current?.closest('.un-modal') || details.rootRef.current;
      surface?.setAttribute('role', 'dialog');
      surface?.setAttribute('aria-modal', 'true');
      surface?.setAttribute('aria-labelledby', 'dc-session-details-title');
      cardRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    },
    onClose: () => {
      setShowDetails(false);
      if (triggerRef.current?.getClientRects().length) triggerRef.current.focus();
      const action = afterClose.current;
      afterClose.current = null;
      action?.();
    },
  });
  const { close } = details;
  // Never carry a sheet (or a queued provider action) into another session,
  // route, or the desktop layout. A status/title refresh alone keeps it open.
  useEffect(() => {
    afterClose.current = null;
    close();
  }, [s.sessionId, s.branch, close]);
  useEffect(() => {
    const leave = () => { afterClose.current = null; close(); };
    const desktop = window.matchMedia('(min-width: 640px)');
    const resize = () => { if (desktop.matches) leave(); };
    desktop.addEventListener('change', resize);
    window.addEventListener('hashchange', leave);
    return () => {
      afterClose.current = null;
      desktop.removeEventListener('change', resize);
      window.removeEventListener('hashchange', leave);
    };
  }, [close]);
  useEffect(() => {
    if (!details.isOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === 'Tab') {
        const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        const outside = !buttons.includes(document.activeElement as HTMLButtonElement);
        if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [details.isOpen, close]);
  const revealPr = () => {
    afterClose.current = () => controller()?.revealPrCard?.();
    close();
  };
  const selectVenue = () => {
    // Wait for the first surface's exit before opening the provider chooser:
    // no stacked scrims, stale anchors, or focus stolen by the outgoing sheet.
    afterClose.current = () => {
      const venue = sessionHeaderStore.get().venue;
      if (venue && !venue.disabled) controller()?.openVenueSheet?.(triggerRef.current);
    };
    close();
  };
  return (
    <>
      {/* The in-strip ← retired (Streamlined Concept): the platform header's
          own back arrow leads the session bar now — App.setBackIcon('arrow',
          '#app/<slug>/board') on the way in, DevChat.handleBack on the way
          out. One back control, in the bar the board draws it in. */}
      {/* The board makes the change's NAME the subject of this row — dark and
          semibold, taking whatever width the controls leave it. It was a 12px
          grey caption, which read as metadata about the bar rather than as
          the thing the bar is about. */}
      <span
        className="dc-session-title text-sm font-semibold text-zinc-900 truncate flex-1 min-w-0 dark:text-zinc-100"
        title={s.branch}
      >
        {s.title}
      </span>
      {s.pr ? (
        <button
          id="dc-pr-header-link"
          className="max-sm:hidden text-xs text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
          title={s.prTitle}
          onClick={() => controller()?.revealPrCard?.()}
        >
          {`PR #${s.pr}`}
        </button>
      ) : (
        /* "New change" is the PR link's resting state — it says only "no PR
           yet", and it was taking room from the change's own name on a 375px
           strip that also carries the venue and the mode switch. The board's
           row is the name and the switch, nothing else; hiding it below `sm`
           is the nearest thing to that which still shows it where there is
           room. */
        <span className="max-sm:hidden text-xs text-zinc-500 dark:text-zinc-400" title={s.newChangeTitle}>New change</span>
      )}
      {/* #1348: where this session is built. It states the venue and opens the
          sheet that changes it. Here it survives the launchpad swap, and it is
          not competing with the meter, the runner and the budget menu for the
          same strip. A direct child, which a declared check pins; the mode
          switch sits after it, on the strip's right edge. */}
      {s.venue ? <VenueSelect venue={s.venue} /> : null}
      <button
        ref={triggerRef} type="button" className="dc-session-details-trigger sm:hidden shrink-0 inline-flex items-center gap-1 min-h-[44px] text-xs font-medium text-violet-700 dark:text-violet-400"
        aria-haspopup="dialog" aria-expanded={details.isOpen} aria-controls="dc-session-details"
        onClick={() => details.open()}
      >Details <span aria-hidden="true">▾</span></button>
      <ModeSwitch busy={!!s.busy} />
      {/* The Dev view is itself a portal. Keep the dialog under the body's
          event boundary: the native kit lifts its card to body, so leaving
          it under the Dev portal would strand React's delegated clicks.
          No SSG portal; once mounted, the card remains stable for adoption. */}
      {dialogHome ? createPortal(
        <DialogRoot id="dc-session-details" ref={details.rootRef} {...details.backdropProps}>
          <DialogCard ref={cardRef}>
            <div className="flex items-center justify-between gap-3">
              <h2 id="dc-session-details-title" className="text-lg font-semibold">Session details</h2>
              <Button type="button" variant="neutral" ink="neutral" size="sm" className="min-h-[44px]" onClick={close}>Done</Button>
            </div>
            {showDetails ? (
              <div className="mt-4 space-y-4">
                <p className="text-base font-semibold break-words">{s.title}</p>
                <div className="flex flex-wrap items-center gap-3">
                  {s.pr ? <button type="button" className="min-h-[44px] text-sm text-violet-700 dark:text-violet-400" title={s.prTitle} onClick={revealPr}>{`PR #${s.pr}`}</button>
                    : <span className="text-sm text-zinc-500 dark:text-zinc-400" title={s.newChangeTitle}>New change</span>}
                  {s.life ? <MergeStatusPill life={s.life} /> : null}
                </div>
                {s.venue ? <div>
                  <p className="mb-2 text-sm text-zinc-500 dark:text-zinc-400">Built with</p>
                  <VenueSelect venue={s.venue} details onSelect={selectVenue} />
                </div> : null}
              </div>
            ) : null}
          </DialogCard>
        </DialogRoot>, dialogHome,
      ) : null}
    </>
  );
}
