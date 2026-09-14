/**
 * `#cli-tokens-list` — the CLI / coding-agent credential rows, as a view model.
 *
 * `settings.js` used to build these with `document.createElement`: a card, a
 * `.flex` top row, two text nodes, and — only for a live, non-demo row — a
 * Revoke button with a listener attached to it. It pushes THIS instead, and
 * ./cli-tokens-list.tsx is the only writer of the DOM below that host.
 *
 * ── Everything is pre-decided ─────────────────────────────────────────
 *
 * The two date formats, the `status · created … · last used …` line, and
 * whether a row may be revoked at all are resolved by settings.js, where the
 * payload and the `?demo=1` flag already live. A staging demo row is
 * fabricated server-side and has nothing to revoke, so `revocable` is false
 * for it — the component renders, it does not decide.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * `#cli-tokens-more` and `#cli-tokens-status` are SIBLINGS of this host, not
 * children: the Load-more button's `hidden` follows the keyset cursor and the
 * status line is written by three different call sites (revoke succeeded,
 * revoke failed, demo data). Both stay settings.js's, which is why they are
 * still plain elements in sections/cli.tsx.
 *
 * ── Three phases, because the host had three states ───────────────────
 *
 * `_loadCliTokens` wrote `list.textContent = 'Loading credentials…'` on a
 * reset and `list.textContent = ''` when the fetch failed with nothing
 * cached; `_renderCliTokens` wrote the rows or the empty line. Those are
 * `loading`, `idle` and `ready` — the same three states, named.
 *
 * @typedef {{ id: string|null, hint: string, detail: string, revocable: boolean }} CliTokenView
 * @typedef {{ phase: 'idle'|'loading'|'ready', tokens: CliTokenView[] }} CliTokensState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is exactly the empty `<div id="cli-tokens-list">`
 * that sections/cli.tsx ships and the SSG prerender emits. The list is fetched
 * when the section opens, so a first render that drew the "No CLI credentials."
 * line would be a hydration mismatch — which console.errors, and a console
 * error on any route fails proposal checks. #1609's setup guide is static
 * section markup and therefore does not depend on this state.
 */
export const INITIAL_CLI_TOKENS = /** @type {CliTokensState} */ ({ phase: 'idle', tokens: [] });

export const cliTokensStore = createStore(INITIAL_CLI_TOKENS);

/**
 * Published for settings.js, which is loaded before this bundle and cannot
 * import — the same seam `settingsGrants` and `settingsAgentFiles` use, and
 * published at module-evaluation time so the API exists long before the
 * section can be opened. The `typeof window` guard is not decoration: the SSG
 * prerender evaluates this whole module graph in Node.
 */
if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsCliTokens = {
    publish: (next) => cliTokensStore.set(next),
  };
}
