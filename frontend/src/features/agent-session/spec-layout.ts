// Where an agent session's spec is drawn (#2779 follow-up), and how it is
// split.
//
// BESIDE THE CONVERSATION WHEN THERE IS ROOM. From 1024px up the spec is a
// right-hand pane next to the chat, the way the dev chat's own viewer has
// always been (public/css/app.css `.dc-spec-viewer`), instead of a sheet over
// the whole conversation. In Messages the conversation list steps aside while
// it is open, which is what makes the room on a laptop: without it the thread
// pane is about 680px at 1280, too narrow for two readable columns.
// Narrower windows, and the side panel beside a running app (a document of its
// own, so its viewport is the panel's width), keep the sheet.
//
// THE WIDTH IS THE DEV CHAT'S. One layout preference for both viewers: the
// same localStorage key, the same default, the same floor, and the same rule
// that the chat keeps at least 320px, whatever a stale stored value says.
//
// TWO TABS WHEN THE SPEC HAS TWO HALVES. The scout writes every spec as
// "## User-facing changes" then "## Technical implementation"
// (routes/sessions.js), and the dev chat's viewer shows them as tabs so a
// non-developer lands on the plain-language half. The split is that viewer's
// own function, loaded by the shell as a plain script; a spec without both
// headings, or a page without the script, shows whole, as it always did.

import { useEffect, useState } from 'react';

import { useAgentSessionState, type AgentSessionHost } from './store';

export const SPEC_BESIDE_QUERY = '(min-width: 1024px)';
export const SPEC_WIDTH_KEY = 'dc-spec-viewer-width-v1';
export const SPEC_DEFAULT_WIDTH = 480;
export const SPEC_MIN_WIDTH = 280;
export const CHAT_MIN_WIDTH = 320;
/** The divider between them (`w-1`), which the chat's 320px does not include. */
export const SPEC_DIVIDER_WIDTH = 4;
/** How far one arrow key moves the divider. */
export const SPEC_WIDTH_STEP = 24;

/**
 * The spec pane's width: the stored one, or the default when there is none;
 * never under the floor (a drag past it, even past zero, stops there); and
 * never so wide the chat beside it, after the divider, drops under 320px.
 * With no container measured yet only the floor applies; CSS holds the
 * ceiling too.
 */
export function clampSpecWidth(width: number | null | undefined, containerWidth: number | null | undefined): number {
  const wanted = typeof width === 'number' && Number.isFinite(width) ? width : SPEC_DEFAULT_WIDTH;
  const ceiling = typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.max(SPEC_MIN_WIDTH, containerWidth - CHAT_MIN_WIDTH - SPEC_DIVIDER_WIDTH)
    : Infinity;
  return Math.round(Math.min(ceiling, Math.max(SPEC_MIN_WIDTH, wanted)));
}

export function readSpecWidth(): number | null {
  try {
    const value = parseInt(window.localStorage.getItem(SPEC_WIDTH_KEY) || '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeSpecWidth(px: number): void {
  try { window.localStorage.setItem(SPEC_WIDTH_KEY, String(Math.round(px))); } catch { /* the default next time */ }
}

export interface SpecSplit {
  preamble: string;
  userFacing: string;
  technical: string;
}

type Splitter = (markdown: string) => SpecSplit | null;

/** The dev chat viewer's split, or null: a spec without both halves shows whole. */
export function splitSpec(text: string, splitter?: Splitter | null): SpecSplit | null {
  const split = splitter !== undefined
    ? splitter
    : (typeof window !== 'undefined' ? (window as unknown as { splitSpecSections?: Splitter }).splitSpecSections : null);
  if (typeof split !== 'function' || !text) return null;
  try {
    return split(text) || null;
  } catch {
    return null;
  }
}

/**
 * Whether the window is wide enough for the spec beside the chat. False in
 * the prerender and on the first client render, which must match it; the
 * real answer arrives in an effect, and follows the window from then on.
 */
export function useWideEnoughForSpec(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(SPEC_BESIDE_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return wide;
}

/** A spec is open beside the conversation this host is drawing. */
export function useSpecBeside(host: AgentSessionHost): boolean {
  const snapshot = useAgentSessionState();
  const wide = useWideEnoughForSpec();
  return wide && snapshot.open && snapshot.host === host && !!snapshot.specSheet;
}
