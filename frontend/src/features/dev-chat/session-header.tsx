/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import type { MouseEvent, ReactNode } from 'react';

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

export function SessionHeader(): ReactNode {
  const s = useStoreState(sessionHeaderStore);
  // The Preview chip's flag lives on the improve store — the same
  // `previewActive` that highlights the header's eye. One fact, one field.
  const { previewActive } = useStoreState(improveStore) as { previewActive: boolean };
  return (
    <>
      {/* The in-strip ← retired (Streamlined Concept): the platform header's
          own back arrow leads the session bar now — App.setBackIcon('arrow',
          '#app/<slug>/board') on the way in, DevChat.handleBack on the way
          out. One back control, in the bar the board draws it in. */}
      <span className="text-xs text-zinc-500 truncate flex-1 dark:text-zinc-400" title={s.branch}>{s.title}</span>
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
      {/*
          The MODE CHIP (Streamlined Concept) — the Figma title row's
          `Building` / `Preview` state: violet while an AI turn is in flight
          (doing), amber while the staging preview is on screen (seeing),
          absent at rest. The lifecycle pill that stood here moved UP into
          the platform header (#header-status-pill) — the board puts the
          "Checks run…" state in the top bar, not the title row.
      */}
      {previewActive ? (
        <span
          id="dc-mode-chip"
          className="text-[0.65rem] font-semibold px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-700 dark:text-amber-400 shrink-0"
        >
          Preview
        </span>
      ) : s.busy ? (
        <span
          id="dc-mode-chip"
          className="text-[0.65rem] font-semibold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-400 shrink-0"
        >
          Building
        </span>
      ) : null}
      {/* #1348: where this session is built, top right of the session area. It
          states the venue and opens the sheet that changes it. Here it
          survives the launchpad swap, and it is not competing with the meter,
          the runner and the budget menu for the same strip.
          LAST, and a direct child: a declared check pins both. */}
      {s.venue ? <VenueSelect venue={s.venue} /> : null}
    </>
  );
}
