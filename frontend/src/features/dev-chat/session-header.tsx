/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import type { MouseEvent, ReactNode } from 'react';

import { EyeIcon, PencilSparklesIcon } from '@/components/ui/icons';

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
          title={`${advisory} advisory vote${advisory === 1 ? '' : 's'} from non-approvers — they don’t count toward merging`}
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
  return (
    <button
      type="button"
      id="dc-venue-select"
      className="dc-venue-select"
      data-venue-change="1"
      data-venue-current={venue.id}
      aria-haspopup="menu"
      disabled={venue.disabled}
      title={venue.title}
      onClick={(e: MouseEvent<HTMLButtonElement>) => controller()?.openVenueSheet?.(e.currentTarget)}
    >
      <span className="dc-venue-name">{venue.label}</span>
      <span className="dc-venue-caret" aria-hidden="true">{'▾'}</span>
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
 * Two segments in a shared track, as the board draws them. The EYE opens the
 * staging preview (seeing); the pencil-sparkles brings the chat back (doing).
 * Whichever mode is current is SOLID — yellow for seeing, accent blue for
 * doing — and carries the LABEL, which is where the retired `#dc-mode-chip`
 * went: `Preview` while the preview is up, `Building` while an AI turn is in
 * flight. The other segment is a bare glyph on the track. Solid rather than
 * tinted because the board draws it that way, and because two tinted pills
 * side by side do not read as "one of these is on". At rest the doing segment is
 * filled but wordless, because "you are in the chat, and nothing is running"
 * is not news. The label keeps the chip's id so the one thing that read it
 * still resolves.
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

  return (
    <span
      id="dc-mode-switch"
      className="shrink-0 flex items-center gap-0.5 rounded-full bg-zinc-200 p-0.5 dark:bg-zinc-800"
      role="group"
      aria-label="Preview or build this change"
    >
      <button
        id="app-eye-btn"
        type="button"
        className={seeing
          ? 'flex items-center gap-1 h-6 rounded-full py-1 pr-2.5 pl-1.5 text-xs font-semibold bg-amber-300 text-zinc-900 un-touch-target'
          : 'flex items-center justify-center h-6 w-6 rounded-full text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 un-touch-target'}
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
        type="button"
        className={seeing
          ? 'flex items-center justify-center h-6 w-6 rounded-full text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 un-touch-target'
          : 'flex items-center gap-1 h-6 rounded-full py-1 pr-2.5 pl-1.5 text-xs font-semibold bg-violet-600 text-white un-touch-target'}
        aria-label="Back to building"
        aria-pressed={seeing ? 'false' : 'true'}
        title="Back to the session chat"
        onClick={() => {
          if (!seeing) return;
          (window as any).AppView?.closeStagingOverlay?.();
        }}
      >
        <PencilSparklesIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {!seeing && busy ? <span id="dc-mode-chip">Building</span> : null}
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
        <span className="text-xs text-zinc-500 dark:text-zinc-400" title={s.newChangeTitle}>New change</span>
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
