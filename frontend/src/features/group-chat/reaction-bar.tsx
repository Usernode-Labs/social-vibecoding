/**
 * `#gc-react-bar` — the quick reaction row, the `＋` grid and the touch-only
 * Edit action, as the only React writer below that host.
 *
 * ── The host is the module's, the children are React's ────────────────
 *
 * Same seam as ./autocomplete.tsx, and for the same reasons. The bar is a
 * `position: fixed` element appended to `document.body` by
 * public/js/group-chat.js, which points it at a row (`data-msg-id`), measures
 * that row's rect and writes `left` / `top` on every open, and owns the
 * element's own `hidden`. None of that is markup, so none of it moves. What
 * moves is everything INSIDE the bar, which was an `innerHTML` assignment of
 * ~380 buttons plus two `classList.toggle` calls that reached back into it.
 *
 * ── Accept is still a delegated click on the host ─────────────────────
 *
 * Bound ONCE by `_ensureReactionBar`, on an element that outlives every
 * render, and it reads `data-emoji` off whichever `.gc-react-bar-emoji` was
 * hit. Rows keep that attribute for it. The `＋` and the pencil go through the
 * same handler: it publishes the grid toggle and calls `_startEdit` with the
 * id the host carries, so the bar's three affordances stay one owner's.
 *
 * ── Why the buttons carry no `type` ───────────────────────────────────
 *
 * Like-for-like with the markup this replaces. The bar is appended to the
 * body and is inside no `<form>`, so the default `submit` type has nothing to
 * submit; adding an attribute here would be a difference for its own sake.
 */

import { useStoreState } from '../../lib/use-store-state';
import { reactionBarStore, type ReactionBarState } from './reaction-bar-store';

/** The emoji sets, fixed for the life of the page — see ./reaction-bar-store.ts. */
export interface ReactionBarProps {
  quick: string[];
  grid: string[];
}

function EmojiButton({ emoji }: { emoji: string }) {
  return (
    <button className="gc-react-bar-emoji" data-emoji={emoji}>
      {emoji}
    </button>
  );
}

export function ReactionBarView({
  quick,
  grid,
  gridOpen,
  editable,
}: ReactionBarProps & ReactionBarState) {
  return (
    <>
      <div className="gc-react-bar-quick">
        {/*
            Keyed by position: both lists are module constants, never reordered
            and never filtered, so the index IS the identity — and the two
            overlap (every quick reaction also appears in the grid), so the
            character is not one to reach for.
        */}
        {quick.map((emoji, i) => <EmojiButton key={`${i}:${emoji}`} emoji={emoji} />)}
        <button className="gc-react-bar-more" aria-label="More emoji">＋</button>
        {/*
            Touch-only Edit for the viewer's own ordinary messages — desktop
            has the hover pencil. Rendered always and hidden per row, as the
            markup did, so the host's delegated handler has one node to find.
        */}
        <button
          className={`gc-react-bar-edit${editable ? '' : ' hidden'}`}
          aria-label="Edit message"
        >
          ✏️
        </button>
      </div>
      <div className={`gc-react-bar-grid${gridOpen ? '' : ' hidden'}`}>
        {grid.map((emoji, i) => <EmojiButton key={`${i}:${emoji}`} emoji={emoji} />)}
      </div>
    </>
  );
}

export function ReactionBar(props: ReactionBarProps) {
  return <ReactionBarView {...props} {...useStoreState<ReactionBarState>(reactionBarStore)} />;
}
