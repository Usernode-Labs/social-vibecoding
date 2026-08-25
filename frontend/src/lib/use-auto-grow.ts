// #1408 — a textarea that grows with its content, up to a ceiling.
//
// The browser gives you `rows` (a fixed height) or a scrollbar, and nothing in
// between: a one-row composer holding four lines of text shows the last line
// and hides the rest, which is the complaint. CSS has no "height: content, but
// stop at N" for a form control either — `field-sizing: content` is exactly
// that and is not portable yet — so this is the small JS that fills the gap.
//
// ── Why it sets height and lets CSS hold the ceiling ───────────────────
//
// The measurement is the standard one: collapse to `auto` so scrollHeight
// reports the CONTENT height rather than the current box, then pin the box to
// it. Read without the reset, scrollHeight only ever grows — a textarea that
// had been dragged tall stays tall when its text is deleted.
//
// The MAXIMUM deliberately stays in the stylesheet. Every caller already has a
// `max-height` there beside its other sizing, so duplicating it as a number
// here would give one control two ceilings that can disagree. Setting
// `height` past `max-height` is harmless — the used height is clamped — so the
// element simply stops growing and scrolls, which is the wanted behaviour.
// Callers must therefore set `overflow-y: auto`, or the overflow is clipped
// and unreachable.
//
// ── Why a layout effect ────────────────────────────────────────────────
//
// The height is written before the browser paints, so a restored draft or a
// pasted paragraph is never visibly one row for a frame before snapping open.
// It is client-only by construction, so the first render still matches the
// server's markup: the inline style appears after mount, and no host renders
// this on the server today anyway.

import { useIsomorphicLayoutEffect } from './legacy-dom';

import type { RefObject } from 'react';

/**
 * Keep `ref`'s textarea sized to its content, re-measuring whenever `value`
 * changes.
 *
 * `value` is the dependency rather than an input listener because every caller
 * is already a controlled component: React has re-rendered by the time this
 * runs, so the DOM holds the new text and one measurement covers typing,
 * pasting, a programmatic clear on send, and a draft restored on mount.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Two writes, in this order, for the reason in the header: without the
    // collapse, scrollHeight is measured against the box the element already
    // has and can only ratchet upwards.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
