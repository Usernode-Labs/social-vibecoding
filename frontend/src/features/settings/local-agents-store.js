/**
 * `#settings-local-agents-list` — the machines currently attached to one of
 * this account's dev sessions (#907), as a view model.
 *
 * `settings.js` used to build a card per lease with `document.createElement`
 * — deliberately, because the label is free text the user typed on their own
 * machine and arrives verbatim. React escapes it for the same reason, and
 * ./local-agents-list.tsx is the only writer of the DOM below that host now.
 *
 * ── Two phases, not three ─────────────────────────────────────────────
 *
 * Unlike the credential and connector lists, this one has no "loading" and no
 * empty line: the whole SECTION hides itself when nothing is attached, because
 * an empty "Local coding agent — none" panel would be noise on every account
 * that has never used the CLI, which is nearly all of them. That `hidden` is a
 * sibling concern and stays settings.js's.
 *
 * @typedef {{ leaseId: string|null, title: string, where: string, detail: string,
 *             detachable: boolean }} LocalAgentView
 * @typedef {{ phase: 'idle'|'ready', agents: LocalAgentView[] }} LocalAgentsState
 */

import { createStore } from '../../lib/plain-store.js';

export const INITIAL_LOCAL_AGENTS = /** @type {LocalAgentsState} */ (
  { phase: 'idle', agents: [] }
);

export const localAgentsStore = createStore(INITIAL_LOCAL_AGENTS);

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsLocalAgents = {
    publish: (next) => localAgentsStore.set(next),
  };
}
