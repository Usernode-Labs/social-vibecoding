/**
 * The experimental switch for the new Needs you review flow (Settings ›
 * Experimental, "New Needs you"). Off by default. While it is on, the
 * Communities tab's Needs you draws ./review-flow.tsx instead of the reel
 * (../workshop/needs-reel.tsx).
 *
 * Kept on the ACCOUNT (users.review_flow_enabled, POST /api/me/review-flow),
 * like the AI progress estimate: it follows the person to every device, and
 * the server knows who is in the experiment, so it can serve them the
 * before/after stills at the density they were captured at.
 *
 * It was first kept on the device (localStorage `usernode:review-flow`). A
 * device that still has it on carries it over to the account once, and the
 * device copy is then dropped.
 *
 * settings.js (a classic module that cannot import) paints and saves the
 * switch through `window.UsernodeReact.reviewFlow`, published below; a screen
 * that draws differently subscribes with `useReviewFlowEnabled`.
 */

import { useSyncExternalStore } from 'react';

/** The switch's old home on the device, read once to carry it over. */
export const REVIEW_FLOW_STORAGE_KEY = 'usernode:review-flow';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type AppUser = { reviewFlowEnabled?: boolean } | null | undefined;
type AppLike = { user?: AppUser; bootSession?: () => Promise<unknown> };
type Post = (enabled: boolean) => Promise<boolean>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function app(): AppLike | null {
  return typeof window !== 'undefined' ? ((window as unknown as { App?: AppLike }).App || null) : null;
}

/** Whether the signed-in account has the new review flow turned on. */
export function reviewFlowEnabled(a: AppLike | null = app()): boolean {
  return !!a?.user?.reviewFlowEnabled;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

const post: Post = async (enabled) => {
  try {
    const r = await fetch('/api/me/review-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ enabled }),
    });
    return r.ok;
  } catch {
    return false;
  }
};

/**
 * Turns the switch on or off for the account. Resolves true once the server
 * took it; on a failed save nothing changes, so the switch never shows a
 * choice the account does not have.
 */
export async function setReviewFlowEnabled(on: boolean, a: AppLike | null = app(), send: Post = post): Promise<boolean> {
  if (!(await send(!!on))) return false;
  if (a?.user) a.user.reviewFlowEnabled = !!on;
  notify();
  return true;
}

/** A device that had it on before it moved to the account carries it over, once. */
export async function carryOverDeviceSwitch(
  a: AppLike | null = app(), storage: StorageLike | null = defaultStorage(), send: Post = post,
): Promise<void> {
  let was: string | null = null;
  try { was = storage ? storage.getItem(REVIEW_FLOW_STORAGE_KEY) : null; } catch { return; }
  if (was == null || !a?.user) return;
  if (was === '1' && !a.user.reviewFlowEnabled && !(await setReviewFlowEnabled(true, a, send))) return;
  try { storage?.removeItem(REVIEW_FLOW_STORAGE_KEY); } catch { /* it is read once more next time */ }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // The account arrives with the session: draw again once it has.
  app()?.bootSession?.().then(() => { carryOverDeviceSwitch().finally(fn); }, () => {});
  return () => { listeners.delete(fn); };
}

/** The switch, live: a screen re-renders when it is turned on or off. */
export function useReviewFlowEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => reviewFlowEnabled(), () => false);
}

/** The bridge settings.js reads and saves the switch through. */
export function installReviewFlowBridge(win: Window & { UsernodeReact?: Record<string, unknown> } = window as never): void {
  const bridge = (win.UsernodeReact ||= {});
  bridge.reviewFlow = {
    enabled: () => reviewFlowEnabled(),
    setEnabled: (on: boolean) => setReviewFlowEnabled(!!on),
  };
}

if (typeof window !== 'undefined') installReviewFlowBridge();
