// Phone review #58 (23 Nov 2026): A MESSAGE BOX THAT WRAPS GIVES ITS TEXT THE
// WHOLE CARD.
//
// The conversation composer (features/messages/composer.tsx) and New chat
// (features/messages/new-thread.tsx) lay out the "+", the field, dictation
// and Send on one flex row for the field's whole height. On a phone that
// left the words 219px of a 357px card (the "+" and its gap on the left,
// the mic and Send on the right of every line), so two sentences filled six
// lines and scrolled. Once the field's text wraps, the row is STACKED: the
// field takes the card's full width and the buttons stand on a line of
// their own beneath it (app.css, "THE STACKED MESSAGE BOX").
//
// ── Why it does not flip back the moment it fits ──────────────────────
//
// Stacked, the field is wider, so text that wrapped beside the buttons may
// fit on one line again. Judged by the wider field alone it would unstack,
// wrap, and stack again on every keystroke. So it stacks when the text
// first wraps beside the buttons, remembering how wide the field was then,
// and unstacks only once the text (with no line break in it) would fit on
// one line at THAT width again, or the box is emptied, as after a send.
//
// ── Why it refits the height ───────────────────────────────────────────
//
// lib/use-auto-grow.ts sizes the field when its text changes; a change of
// width alone does not reach it. So each change of layout sizes the field
// again (refitToContent), before the frame is drawn.

import { useRef, useState, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from './legacy-dom';
import { refitToContent } from './use-auto-grow';

let canvas: HTMLCanvasElement | null = null;

/** The width `text` takes on one line in `el`'s type, or null where it cannot be measured. */
function oneLineWidth(el: HTMLTextAreaElement, text: string): number | null {
  if (typeof document === 'undefined') return null;
  canvas = canvas || document.createElement('canvas');
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  const cs = getComputedStyle(el);
  ctx.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return ctx.measureText(text).width;
}

/** The space a line of text has inside `el`: its width less its side padding. */
function textBox(el: HTMLTextAreaElement): { width: number; vertical: number; line: number } {
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  return {
    width: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
    vertical: px(cs.paddingTop) + px(cs.paddingBottom),
    line: px(cs.lineHeight) || px(cs.fontSize) * 1.3 || 22,
  };
}

/**
 * Pure: whether the box stays stacked, given whether it is now, its text,
 * whether that text runs past one line in the field as laid out, and (for
 * a stacked box) whether it would fit on one line at the width the field
 * had beside the buttons.
 */
export function nextStacked(stacked: boolean, value: string, wraps: boolean, fitsBeside: boolean | null): boolean {
  if (!value) return false;
  if (!stacked) return wraps;
  if (value.includes('\n')) return true;
  return fitsBeside === false || fitsBeside === null;
}

/**
 * Whether `ref`'s message box is stacked (its field over its buttons),
 * re-read whenever `value` changes. The caller puts it on the row as
 * `data-stacked`.
 */
export function useComposerStack(ref: RefObject<HTMLTextAreaElement | null>, value: string): boolean {
  const [stacked, setStacked] = useState(false);
  // The field's text width beside the buttons, read as it stacked.
  const beside = useRef(0);
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = textBox(el);
    const wraps = el.scrollHeight - box.vertical > box.line * 1.5;
    let fitsBeside: boolean | null = null;
    if (stacked && value && !value.includes('\n')) {
      const width = oneLineWidth(el, value);
      fitsBeside = width === null ? null : width <= beside.current - 1;
    }
    const next = nextStacked(stacked, value, wraps, fitsBeside);
    if (next !== stacked) {
      if (next) beside.current = box.width;
      setStacked(next);
    }
  }, [ref, value, stacked]);
  // The new width needs a new height (see the header).
  const laidOut = useRef(stacked);
  useIsomorphicLayoutEffect(() => {
    if (laidOut.current === stacked) return;
    laidOut.current = stacked;
    const el = ref.current;
    if (el) refitToContent(el, el.value);
  }, [ref, stacked]);
  return stacked;
}
