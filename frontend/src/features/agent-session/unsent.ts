// What the composer holds and has not sent (#2779 follow-up, the dev chat's
// `usernode:dc-draft:<id>`): kept per conversation in this browser, so a
// reload, a switch to another conversation or a trip elsewhere in the app
// brings it back. `new` is the unsent conversation's. Not the SAVED drafts,
// which are sent-later messages on the server (store.ts, "Saved drafts").
//
// Storage can be missing or refuse (a private window, blocked site data);
// then the text lives only as long as the composer does, as it did before.

import type { AgentSessionTarget } from './store';

export const UNSENT_PREFIX = 'usernode:agent-session-unsent:';

export function readUnsent(target: AgentSessionTarget): string {
  try {
    return window.localStorage.getItem(`${UNSENT_PREFIX}${target}`) || '';
  } catch {
    return '';
  }
}

export function writeUnsent(target: AgentSessionTarget, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(`${UNSENT_PREFIX}${target}`, text);
    else window.localStorage.removeItem(`${UNSENT_PREFIX}${target}`);
  } catch { /* kept in the composer only */ }
}
