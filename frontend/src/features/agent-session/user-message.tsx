import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
/**
 * What you sent, in an agent chat — and "Show more" when it is long (#3558).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * A message of yours that is longer than eight lines folds to the height of
 * eight: the first six, a seventh that fades out, and "Show more" on the
 * eighth, where the words have faded to nothing. Pressing it opens the whole
 * message in place and the control turns into "Show less". A message that
 * fits in eight lines renders as it always did, with no control and no fade.
 * Only YOUR messages fold: the request was about a pasted spec or log taking
 * over the conversation, and the Mayor's replies are the thing you came to
 * read.
 *
 * ── Why eight, when a comment folds at four ─────────────────────────────
 *
 * A long comment (../dev-board/comment-clamp.tsx, #2556) folds at four lines,
 * and at four this would fold ordinary asks: in the bubble's 85% of a 390px
 * phone a line is about forty characters, so a two-sentence instruction is
 * already five. Eight keeps a few sentences whole on a phone (~300
 * characters) and is still a bit over a third of the transcript a phone
 * shows, so a forty-line spec stops pushing the reply off the screen. On a
 * desktop the same eight lines hold two to three times the text, so it folds
 * there only when a message is genuinely long.
 *
 * ── What is borrowed from the comment fold, and what is not ────────────
 *
 * The decision is the same and is MEASURED with the same function
 * (`overflowsClamp`): eight short lines and eight lines of one long wrapped
 * paragraph are the same eight lines on screen, a character count gets both
 * wrong at different widths, and the same message folds on a phone and not
 * on a desktop. The control is the same button, neutral and compact.
 *
 * Two things differ, both because a chat is not a list of comments:
 *
 *   - THE CONTROL SITS IN THE FADE, inside the bubble, instead of under it.
 *     Whether a message is long is only known once it is laid out, so the
 *     control arrives after the first render. Under the bubble, it would make
 *     every long message taller AFTER the transcript had already scrolled to
 *     the bottom (FollowOutput in ./index.tsx), and opening a conversation
 *     would land one control's height above the end per long message. In the
 *     fade it takes no room at all: the bubble's height is set by the clamp,
 *     which IS in the first render, and nothing moves when the control
 *     appears. Expanded, there is no fade to sit in, so "Show less" takes its
 *     own line at the end of the message, in the same corner.
 *   - IT IS MEASURED BEFORE PAINT (a layout effect, not a passive one). The
 *     fade can only go on a message that is long, so with a passive effect a
 *     long message would paint once unfaded and then fade. The transcript is
 *     never part of the prerendered shell (every row arrives from a read, in
 *     an effect), so measuring in a layout effect cannot disagree with
 *     anything a server printed.
 *
 * ── Folding it again ────────────────────────────────────────────────────
 *
 * A long message read to its end leaves "Show less" far below the message's
 * top. Pressing it shrinks the bubble by however much was opened, and a
 * transcript that keeps its scroll offset would then be showing whatever came
 * after it. So a fold the reader asked for brings the folded message back
 * into view (`block: 'nearest'`: nothing moves when it is already on screen).
 *
 * The state is per message and lives here, as the comment fold's does:
 * opening one message does not open the next, and leaving the conversation
 * forgets it.
 */

import { useLayoutEffect, useRef, useState, type Ref } from 'react';

import { Button } from '@/components/ui/button';

import { overflowsClamp } from '../dev-board/comment-clamp';

/**
 * How many lines a long message of yours shows before it is opened.
 *
 * Spelled twice on purpose, as the comment fold spells its four: Tailwind's
 * own clamp scale stops at six, so the clamp is the arbitrary-value literal
 * below, and a name assembled from this constant would compile to nothing
 * (tests/tailwind-build.test.js).
 */
export const USER_CLAMP_LINES = 8;

/** The clamp itself. A complete literal, never interpolated. */
export const USER_CLAMP_CLASS = 'line-clamp-[8]';

/**
 * The fade, in the bubble's lines (1.5em each): opaque through the sixth,
 * out across the seventh, and nothing left of the eighth, which is the row
 * "Show more" sits in — so the control never lands on top of half a word. A
 * mask rather than a gradient laid over the text, so it fades the WORDS and
 * not the bubble: the bubble keeps its fill and its rounded foot, in both
 * themes, with no second copy of its colour. The compiled rule carries the
 * `-webkit-` spelling too (autoprefixer).
 */
export const USER_FADE_CLASS = '[mask-image:linear-gradient(to_bottom,#000_calc(100%-3em),transparent_calc(100%-1.5em))]';

/**
 * The bubble's own utilities, exactly as the transcript drew them before
 * (#2779), plus `relative` for the control that sits on the fade.
 */
const BUBBLE = 'relative max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100';

/**
 * The presentational half: the bubble, its text, and the control when there
 * is more to see. Split from the stateful wrapper so each state renders from
 * a test (renderToStaticMarkup never runs the effect that decides
 * `overflowing`).
 *
 * The text is its own element inside the bubble, rather than the clamp going
 * on the bubble, because a clamp on a padded box lets the top of the ninth
 * line show through the bottom padding.
 */
export function UserMessageBody({
  text, expanded, overflowing, onToggle, className = '', bubbleRef, textRef,
}: {
  text: string;
  expanded: boolean;
  overflowing: boolean;
  onToggle?: () => void;
  /** Added to the bubble: the outbox fades a message that is on its way. */
  className?: string;
  bubbleRef?: Ref<HTMLDivElement>;
  textRef?: Ref<HTMLParagraphElement>;
}) {
  const textClass = expanded
    ? 'whitespace-pre-wrap'
    : overflowing
      ? `whitespace-pre-wrap ${USER_CLAMP_CLASS} ${USER_FADE_CLASS}`
      : `whitespace-pre-wrap ${USER_CLAMP_CLASS}`;
  return (
    <div ref={bubbleRef} className={className ? `${BUBBLE} ${className}` : BUBBLE}>
      <p ref={textRef} className={textClass}>{text}</p>
      {overflowing ? (
        <Button
          type="button"
          variant="neutral"
          ink="neutral"
          size="xsText"
          // In the faded eighth line while folded; on a line of its own at
          // the end once open. Either way the label's right edge lines up
          // with the text's and its foot sits 8px above the bubble's.
          // `touch-target-32` gives a finger 32px on a coarse pointer
          // without the box growing.
          className={expanded
            ? 'touch-target-32 -mb-0.5 -mr-3 ml-auto mt-1 block'
            : 'touch-target-32 absolute bottom-2 right-1'}
          aria-expanded={expanded}
          data-agent-session-user-more
          onClick={onToggle}
        >
          <LocalizedValue render={() => (expanded ? tr("workshop:show_less_94ea9b1d") : tr("workshop:show_more_f5c9bd13"))} />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The stateful wrapper the transcript and the outbox mount.
 *
 * `text` is in the measurement's dependencies so different words are measured
 * again rather than trusted to the last answer. A ResizeObserver covers the
 * width: a paragraph that is eight lines in a desktop's chat column is
 * twenty-odd on a phone, so the control has to come and go with the width;
 * and a conversation opened while its pane is hidden measures nothing until
 * it gets a box.
 */
export function UserMessage({ text, className = '' }: { text: string; className?: string }) {
  useUiLanguage();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const folded = useRef(false);

  useLayoutEffect(() => {
    // Only the CLAMPED box can answer: once open there is nothing hidden to
    // measure, and the control has to stay so the reader can fold it again.
    if (expanded) return undefined;
    const el = textRef.current;
    if (!el) return undefined;
    const measure = () => setOverflowing(overflowsClamp(el));
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [expanded, text]);

  useLayoutEffect(() => {
    if (expanded || !folded.current) return;
    folded.current = false;
    bubbleRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);

  const toggle = () => {
    if (expanded) folded.current = true;
    setExpanded(!expanded);
  };

  return (
    <UserMessageBody
      text={text}
      expanded={expanded}
      overflowing={overflowing}
      onToggle={toggle}
      className={className}
      bubbleRef={bubbleRef}
      textRef={textRef}
    />
  );
}
