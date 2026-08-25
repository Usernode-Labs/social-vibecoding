/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import type { MouseEvent, ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
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
          title={`${advisory} advisory vote${advisory === 1 ? '' : 's'} from non-approvers. They don’t count toward merging`}
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
  return (
    <>
      <a
        id="dc-back"
        className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 text-sm"
        href={s.backHref}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          // #1036: a real anchor — a cmd/ctrl/shift/middle click opens the dev
          // page in a new tab and must leave THIS session mounted as it is.
          // The guard runs before preventDefault, or the new tab is swallowed.
          const N = controller();
          if ((window as any).NavLink?.isNativeClick(e)) return;
          e.preventDefault();
          N?.leaveSession?.();
        }}
      >
        {'←'}
      </a>
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
      {/* The lifecycle pill's own host. It is rendered whether or not there is
          a pill to draw, because `#dc-status-pill` is what a mid-turn patch
          used to find — the patch is a publish now, and the empty span is
          still the shape the strip's spacing was written against. */}
      <span id="dc-status-pill">{s.life ? <MergeStatusPill life={s.life} /> : null}</span>
      {/* #1348: where this session is built, top right of the session area. It
          states the venue and opens the sheet that changes it. Here it
          survives the launchpad swap, and it is not competing with the meter,
          the runner and the budget menu for the same strip.
          LAST, and a direct child: a declared check pins both. */}
      {s.venue ? <VenueSelect venue={s.venue} /> : null}
    </>
  );
}
