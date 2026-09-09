/**
 * `#connectors-list` — the connected chat clients, as a view model.
 *
 * `settings.js` used to build these with `document.createElement`: a card, a
 * `.flex` top row, a title and a metadata line, and a Disconnect button with a
 * listener attached to it. It pushes THIS instead, and
 * ./connectors-list.tsx is the only writer of the DOM below that host.
 *
 * Three phases, because the host had three states: `_loadConnectors` wrote
 * `list.textContent = 'Loading connections…'` before the fetch and
 * `list.textContent = ''` when it failed; `_renderConnectors` wrote the cards
 * or the empty line.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * Three siblings of this host, all still settings.js's and all still plain
 * elements in sections/connectors.tsx:
 *
 *   * `#connectors-status` — the write outcome, painted by the disconnect
 *     handler in both directions.
 *   * `#connector-case-cc-local` / `-cc-web` — static prose blocks whose
 *     `hidden` follows which client families are connected.
 *   * `#connector-hint-status` — the read-only tip status, whose three
 *     mutually-exclusive explanations are prose this module composes.
 *
 * @typedef {{ id: string, title: string, detail: string }} ConnectorView
 * @typedef {{ phase: 'idle'|'loading'|'ready', connectors: ConnectorView[] }} ConnectorsState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is the empty `<div id="connectors-list">` that
 * sections/connectors.tsx ships and the SSG prerender emits — the list is
 * fetched when the section opens, so drawing anything at hydration would
 * mismatch.
 */
export const INITIAL_CONNECTORS = /** @type {ConnectorsState} */ (
  { phase: 'idle', connectors: [] }
);

export const connectorsStore = createStore(INITIAL_CONNECTORS);

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsConnectors = {
    publish: (next) => connectorsStore.set(next),
  };
}
