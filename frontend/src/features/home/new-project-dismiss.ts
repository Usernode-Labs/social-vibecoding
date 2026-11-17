/**
 * Whether Home's "Have an idea?" card is closed in this browser.
 *
 * Closing is a per-browser choice, not an account setting: the same person on
 * another device still gets the card. It is kept the way the verify card's
 * "Not now" is (./verify-card.tsx), one key in localStorage, and the card and
 * the page that lays out its column both listen to one event so closing it
 * drops the side column at once rather than at the next reload.
 */

export const NEW_PROJECT_HIDDEN_KEY = 'usernode:new-project-card-hidden';
export const NEW_PROJECT_HIDDEN_EVENT = 'usernode:new-project-card-hidden';

/** True when the viewer closed the card in this browser. */
export function newProjectCardHidden(): boolean {
  try { return localStorage.getItem(NEW_PROJECT_HIDDEN_KEY) === '1'; } catch { return false; }
}

/**
 * Close the card: remember it for this browser and tell the page. Without
 * storage (private mode throws) it is hidden for this visit only.
 */
export function hideNewProjectCard(): void {
  try { localStorage.setItem(NEW_PROJECT_HIDDEN_KEY, '1'); } catch { /* hidden for this visit */ }
  try { window.dispatchEvent(new Event(NEW_PROJECT_HIDDEN_EVENT)); } catch { /* no window to tell */ }
}
