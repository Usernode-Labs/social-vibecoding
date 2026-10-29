/**
 * A thread message's body, folded behind "Show more" when it is long (#6022).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * A message longer than twenty lines shows the height of fifteen, fading out
 * at the foot, with "Show more" under it; pressing it opens the whole
 * message in place and the control turns into "Show less". A message of
 * twenty lines or fewer renders exactly as it always did: no clamp, no fade,
 * no control. The gap between the two numbers is on purpose: folding a
 * sixteen-line message to fifteen would hide one line behind a button.
 *
 * Every row that draws a body through this (`MessageRow` and `GitHubRow` in
 * ./transcript.tsx) folds: a request's and a change's stream, a community's
 * channel and a reply thread are the same rows.
 *
 * ── Why a height, and not `line-clamp` ──────────────────────────────────
 *
 * The comment fold (../dev-board/comment-clamp.tsx) and the agent chat's
 * (../agent-session/user-message.tsx) clamp by lines, which suits plain
 * text. A thread body is rendered markdown: headings, lists, code blocks and
 * pictures (the comment that prompted this carried a whole plan with its
 * screenshots). `-webkit-line-clamp` counts only lines of text, so a body of
 * ten lines and five screenshots would "fit" at several screens tall. A
 * height in `em` folds every kind of content to the same space.
 *
 * ── Measured, and measured again as it grows ────────────────────────────
 *
 * Long is decided from the laid-out box (`isLongBody`): twenty short lines
 * and one wrapped paragraph of twenty are the same twenty lines on screen,
 * and the same message is long on a phone and not on a desktop. The
 * measurement is a layout effect so a long body never paints unfolded first;
 * the transcript is not part of the prerendered shell (its rows arrive from
 * a read), so that cannot disagree with anything the server printed.
 *
 * `scrollHeight` is the whole content whether or not the box is clamped, so
 * one measurement serves both states. A ResizeObserver re-asks when the box
 * changes size: an unfolded body that grows as its pictures load becomes
 * long and folds; a width change rewraps it. While the box is folded its
 * height is fixed, so a picture loading inside it fires no resize; the
 * `load` listener (images do not bubble it, so it listens in the capture
 * phase) covers that case.
 *
 * ── Opening it keeps the reader where they are ──────────────────────────
 *
 * The revealed text grows BELOW the button the reader pressed. A thread
 * scroller pinned to its newest line (`GroupChat._attachThreadFollow`) would
 * answer that growth by jumping to the new bottom, past everything just
 * revealed. So opening first asks `GroupChat.holdReadingPosition` to stop the
 * follow for the scroller this row is in; the message's top stays put and
 * the text opens under it.
 *
 * ── The folded part is not a hidden tab stop ────────────────────────────
 *
 * `overflow: hidden` and a mask hide words, not links: a mention, a link or
 * a reference chip below the fold is still in the tab order, and focusing it
 * would scroll the clipped box inside itself while the control still says
 * folded. So focus that lands in the faded or clipped part (`focusIsClipped`)
 * opens the message, as pressing "Show more" would. Focus on a link in the
 * visible lines leaves it folded.
 *
 * ── What the legacy editor still does to this node ──────────────────────
 *
 * `GroupChat._startEdit` hides `.gc-msg-content` with an inline
 * `display: none` and puts its editor after it. The fold only adds classes
 * (React owns `className`; the editor never writes it), and a hidden body
 * measures zero, so the control goes away while the editor is open and
 * comes back when it closes.
 */

import { useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';

/** A body longer than this many lines folds. */
export const LONG_BODY_LINES = 20;

/**
 * How much a folded body shows: fifteen of the body's 1.5em lines. Spelled
 * as a complete literal so Tailwind's extractor compiles it.
 */
export const FOLD_CLASS = 'max-h-[22.5em] overflow-hidden';

/**
 * The fade over the last two of those lines. A mask, so it fades the words
 * and not the row's background, in either theme. The compiled rule carries
 * the `-webkit-` spelling too (autoprefixer).
 */
export const FADE_CLASS = '[mask-image:linear-gradient(to_bottom,#000_calc(100%-3em),transparent)]';

/**
 * One line of this box, in pixels. `normal` (no line height set) is read as
 * the 1.5 every chat body uses.
 */
export function lineHeightPx(style: { lineHeight: string; fontSize: string }): number {
  const lh = parseFloat(style.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = parseFloat(style.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.5 : 0;
}

/**
 * Is this body long enough to fold? `scrollHeight` is its full content,
 * clamped or not. A box with no layout yet (a hidden pane, a body the editor
 * hid) measures zero and is not long; the observer asks again once it has a
 * box.
 */
export function isLongBody(scrollHeight: number, lineHeight: number): boolean {
  if (!(lineHeight > 0) || !(scrollHeight > 0)) return false;
  return scrollHeight > lineHeight * LONG_BODY_LINES + 1;
}

/**
 * Did focus land on something the fold hides? `target` and `box` are
 * bounding rects (only `bottom` is read): anything that ends inside the fade
 * (`fadePx` above the box's foot) or below it is not readable folded.
 */
export function focusIsClipped(target: { bottom: number }, box: { bottom: number }, fadePx: number): boolean {
  return target.bottom > box.bottom - Math.max(0, fadePx);
}

/**
 * The presentational half: the body and, when it is long, the control under
 * it. Split from the stateful `Body` so each state renders from a test
 * (renderToStaticMarkup never runs the effect that decides `long`).
 *
 * The control is a sibling AFTER `.gc-msg-content`, never a wrapper around
 * it: dapp.json selects on `.gc-msg > .min-w-0 > div > .gc-msg-content`.
 */
export function LongBodyView({
  html, long, expanded, onToggle, onFocusInside, bodyRef,
}: {
  html: { __html: string };
  long: boolean;
  expanded: boolean;
  onToggle?: () => void;
  /** Focus moved onto something inside the body (React's onFocus is `focusin`). */
  onFocusInside?: (target: EventTarget) => void;
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const t = useMessages('chat');
  const folded = long && !expanded;
  return (
    <>
      <div
        ref={bodyRef}
        className={folded ? `gc-msg-content ${FOLD_CLASS} ${FADE_CLASS}` : 'gc-msg-content'}
        {...(folded && onFocusInside ? { onFocus: (e: { target: EventTarget }) => onFocusInside(e.target) } : {})}
        dangerouslySetInnerHTML={html}
      />
      {long ? (
        <Button
          type="button"
          variant="neutral"
          ink="neutral"
          size="xsText"
          // `gc-msg-more` styles nothing: it is the hook a test or a check
          // selects on.
          className="gc-msg-more touch-target-32 mt-1"
          aria-expanded={expanded}
          // A row's own handlers (long-press, the quote jump) skip buttons,
          // but stopping here keeps that true of any host this lands in.
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
        >
          {expanded ? t('chat:group.row.showLess') : t('chat:group.row.showMore')}
        </Button>
      ) : null}
    </>
  );
}

/**
 * The body every thread row draws.
 *
 * Memoising the `{ __html }` wrapper matters: React rewrites a node's
 * `innerHTML` whenever that object is new, even for an identical string,
 * which on a long transcript means every row's body is rewritten on every
 * reaction (features/dev-board/board-frame.tsx has the note).
 */
export function Body({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const refolded = useRef(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return undefined;
    const measure = () => setLong(isLongBody(el.scrollHeight, lineHeightPx(window.getComputedStyle(el))));
    measure();
    el.addEventListener('load', measure, true);
    const obs = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    obs?.observe(el);
    return () => {
      el.removeEventListener('load', measure, true);
      obs?.disconnect();
    };
  }, [html]);

  // Folding a long body read to its end shrinks it by however much was
  // opened, which would leave the reader on whatever came after it. Bring
  // the folded body back into view (`nearest`: nothing moves if it shows).
  useLayoutEffect(() => {
    if (expanded || !refolded.current) return;
    refolded.current = false;
    bodyRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);

  // Opening grows the row below the reader's line: stop the thread's
  // follow-the-bottom for it first, so the message's top stays put.
  const open = () => {
    (typeof window !== 'undefined' ? (window as any).GroupChat : null)?.holdReadingPosition?.(bodyRef.current);
    setExpanded(true);
  };

  const toggle = () => {
    if (expanded) {
      refolded.current = true;
      setExpanded(false);
    } else {
      open();
    }
  };

  const focusInside = (target: EventTarget) => {
    const el = bodyRef.current;
    if (!el || target === el || typeof (target as Element).getBoundingClientRect !== 'function') return;
    const fade = 2 * lineHeightPx(window.getComputedStyle(el));
    if (focusIsClipped((target as Element).getBoundingClientRect(), el.getBoundingClientRect(), fade)) {
      // The browser may already have scrolled the clipped box to show it;
      // opened, the box has no overflow and that offset goes with it.
      el.scrollTop = 0;
      open();
    }
  };

  return (
    <LongBodyView
      html={wrapper}
      long={long}
      expanded={expanded}
      onToggle={toggle}
      onFocusInside={focusInside}
      bodyRef={bodyRef}
    />
  );
}
