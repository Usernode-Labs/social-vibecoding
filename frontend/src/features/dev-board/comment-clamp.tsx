/**
 * "Show more" for a long comment — the one implementation both React comment
 * surfaces use (#2556).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * A comment shows its first four lines. If there is more behind them, a
 * control under the text expands it in place and turns into "Show less". A
 * comment that fits in four lines renders exactly as it did before, with no
 * control at all — which is why the decision is MEASURED rather than taken
 * from a character count: four short lines and four hundred characters of
 * one long word are the same four lines on screen, and a threshold over the
 * text gets both wrong at different widths.
 *
 * ── Why the control cannot be in the first render ──────────────────────
 *
 * `overflowsClamp` needs a laid-out box, so it runs in an effect. That is
 * also what the shell requires of it: an island's initial render has to emit
 * the markup the prerendered document carries, and a control whose presence
 * depends on the viewport's width is not that. So the first pass draws the
 * clamped body alone and the effect reveals the control — the same shape the
 * feed's lazy comment fill already has.
 *
 * ── Why the state is per comment, and lives here ───────────────────────
 *
 * Expanding one comment must not expand the next, and collapsing the list
 * (scrolling a feed row out of view, closing a sheet) is what forgets it:
 * `useState` inside the component that draws one comment is exactly that
 * lifetime, and it needs no store.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';

/**
 * How many lines a long comment shows before it is expanded.
 *
 * The number is spelled twice on purpose: `line-clamp-4` is the literal
 * Tailwind's extractor has to see (a name assembled from this constant
 * compiles to nothing — see tests/tailwind-build.test.js), and the constant
 * is what the legacy Workshop filler's own clamp is held to.
 */
export const CLAMP_LINES = 4;

/** The clamp itself. A complete literal, never interpolated. */
export const CLAMP_CLASS = 'line-clamp-4';

/**
 * Is this clamped element hiding anything?
 *
 * `scrollHeight` is the full content, `clientHeight` the four lines on
 * screen. The 1px slack is for sub-pixel line heights: a body of exactly
 * four lines can measure a fraction over, and a control that says "Show
 * more" and then reveals nothing is worse than no control.
 */
export function overflowsClamp(el: { scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.clientHeight > 1;
}

/**
 * The presentational half: a clamped body and, when there is more to see,
 * the control under it.
 *
 * Split from the stateful wrapper below so both states are renderable from a
 * test — renderToStaticMarkup never runs the effect that decides
 * `overflowing`, and the four cases this has (clamped, expanded, with a
 * control, without) are the whole of the feature's markup.
 */
export function ClampedCommentBody({
  className, expanded, overflowing, onToggle, bodyRef, html, children,
}: {
  className: string;
  expanded: boolean;
  overflowing: boolean;
  onToggle?: () => void;
  bodyRef?: Ref<HTMLDivElement>;
  /**
   * The sanitized-markdown case, passed straight through to
   * `dangerouslySetInnerHTML` on the clamped node itself. The clamp adds a
   * class to the div the surface already drew; it does NOT wrap it in one,
   * because `public/js/**` and dapp.json select on these chains.
   */
  html?: { __html: string };
  children?: ReactNode;
}) {
  return (
    <>
      <div
        ref={bodyRef}
        className={expanded ? className : `${className} ${CLAMP_CLASS}`}
        {...(html ? { dangerouslySetInnerHTML: html } : {})}
      >
        {html ? undefined : children}
      </div>
      {overflowing ? (
        <Button
          type="button"
          variant="neutral"
          ink="neutral"
          size="xsText"
          // `dev-comment-more` styles nothing — it is the hook a declared
          // check selects on, and the React counterpart of the legacy
          // surface's `.dev-feed-comment-toggle`.
          className="dev-comment-more mt-1"
          aria-expanded={expanded}
          // The card surfaces put a delegated click handler on the whole row
          // (it opens the topic). The handler already skips a <button>, but
          // stopping here keeps that true of any host this lands in next.
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </>
  );
}

/**
 * The stateful wrapper the two surfaces mount.
 *
 * `contentKey` re-measures when the text itself changes — a reply that
 * arrives from a reload replaces the node's content without remounting it.
 * A ResizeObserver covers the other direction: the same comment is four
 * lines on a desktop card and nine on a phone, and the control has to appear
 * and disappear with the width.
 */
export function ClampedComment({
  className, contentKey, html, children,
}: {
  className: string;
  contentKey: string;
  html?: { __html: string };
  children?: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  useEffect(() => {
    // Only the CLAMPED box can answer the question: once expanded there is
    // nothing hidden to measure, and the control has to stay so the reader
    // can put it back.
    if (expanded) return undefined;
    const el = bodyRef.current;
    if (!el) return undefined;
    const measure = () => setOverflowing(overflowsClamp(el));
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [expanded, contentKey]);

  return (
    <ClampedCommentBody
      className={className}
      expanded={expanded}
      overflowing={overflowing}
      onToggle={toggle}
      bodyRef={bodyRef}
      html={html}
    >
      {children}
    </ClampedCommentBody>
  );
}
