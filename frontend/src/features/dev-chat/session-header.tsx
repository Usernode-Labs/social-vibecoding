/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { EyeIcon, LockIcon, PencilSparklesIcon } from '@/components/ui/icons';

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
function VenueSelect({ venue }: { venue: NonNullable<SessionHeaderState['venue']> }): ReactNode {
  const busyTitle = 'Wait for the current response to finish before changing where this session is built.';
  return (
    <button
      type="button"
      id="dc-venue-select"
      className="dc-venue-select"
      data-venue-change="1"
      data-venue-current={venue.id}
      data-venue-busy={venue.disabled ? '1' : undefined}
      aria-haspopup="menu"
      aria-label={venue.disabled ? `${venue.label}. Unavailable while the agent is thinking.` : undefined}
      disabled={venue.disabled}
      title={venue.disabled ? busyTitle : venue.title}
      onClick={venue.disabled
        ? undefined
        : (e: MouseEvent<HTMLButtonElement>) => controller()?.openVenueSheet?.(e.currentTarget)}
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

  // No preview yet — the chip alone, exactly as the strip drew it before.
  if (!previewUrl) {
    if (!busy) return null;
    return (
      <span
        id="dc-mode-chip"
        className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-600 text-white shrink-0"
      >
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
        className="text-sm font-semibold text-zinc-900 truncate flex-1 min-w-0 dark:text-zinc-100"
        title={s.branch}
      >
        {s.title}
      </span>
      {s.pr ? (
        <button
          id="dc-pr-header-link"
          className="text-xs text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
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
      <ModeSwitch busy={!!s.busy} />
    </>
  );
}
