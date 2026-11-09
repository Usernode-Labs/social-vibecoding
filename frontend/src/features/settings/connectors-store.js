/**
 * The per-tool connector cards in Settings > Connectors, as a view model.
 *
 * settings.js fetches the connections and publishes one entry per tool, in the
 * page's order. ./connectors-list.tsx reads it twice per card: ToolStatus in the
 * card's top row and ToolConnections under it. Those two are the only React
 * state on the pane. Everything else there is static markup settings.js writes
 * into by id, the setup steps' ticks included.
 *
 * Three phases, the last of which is the only one anything draws: `idle` before
 * the first fetch or after a failed one, `loading` while one runs, `ready` with
 * an answer.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * Siblings on the pane, all still settings.js's and all still plain elements in
 * sections/connectors.tsx:
 *
 *   * `#connectors-status` — the write outcome, painted by the disconnect
 *     handler in both directions.
 *   * `#connector-case-cc-local` / `-cc-web` — static prose blocks whose
 *     `hidden` follows which client families are connected.
 *   * `#connector-hint-status` — the read-only tip status, whose three
 *     mutually-exclusive explanations are prose this module composes.
 *
 * @typedef {{ id: string, title: string, detail: string, capabilities: string|null }} ConnectionView
 * @typedef {'working'|'unused'|'attention'|'none'} ToolStatusKey
 * @typedef {{ key: 'claude'|'chatgpt'|'codex'|'generic', status: ToolStatusKey, connections: ConnectionView[] }} ToolView
 * @typedef {{ phase: 'idle'|'loading'|'ready', tools: ToolView[] }} ConnectorsState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is the empty hosts sections/connectors.tsx ships
 * and the SSG prerender emits: the list is fetched when the section opens, so
 * drawing anything at hydration would mismatch.
 */
export const INITIAL_CONNECTORS = /** @type {ConnectorsState} */ (
  { phase: 'idle', tools: [] }
);

export const connectorsStore = createStore(INITIAL_CONNECTORS);

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsConnectors = {
    publish: (next) => connectorsStore.set(next),
  };
}
