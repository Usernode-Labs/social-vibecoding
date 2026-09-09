/**
 * The agent instructions & skills lists' view model (#460's lists, converted).
 *
 * `settings.js` used to build both lists itself: `innerHTML` for the loading,
 * error and per-kind empty lines, a `document.createElement` + `innerHTML` per
 * file, then three `querySelector` + `addEventListener` calls per row for
 * View, Delete and the lazily-filled `<pre>`. It pushes THIS instead, and
 * ./agent-files-list.tsx is the only writer of the DOM below the two hosts.
 *
 * ── One store, two hosts ──────────────────────────────────────────────
 *
 * The instructions list and the skills list are the same rows from the same
 * fetch, split by `kind`. Modelling them as ONE state with a kind on each file
 * keeps that one fetch answering both, exactly as the module's `byKind` filter
 * did — two stores would be two copies of every update path, and they could
 * disagree about whether a load had finished.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * A row's OPEN state and its fetched content. Those are per-row, per-viewer
 * and never outlive the row, so they are component state in the island rather
 * than model. The DOM version kept the content in the `<pre>`'s textContent,
 * which meant every reload of the list threw away what had been fetched.
 *
 * The status line (`#agent-files-status`) and the upload form. Both are
 * siblings of these hosts and stay `settings.js`'s — nothing in this subtree
 * writes to either.
 *
 * @typedef {{ kind: string, name: string, description: string, kb: number }} AgentFileView
 * @typedef {{ phase: 'idle'|'loading'|'error'|'ready', files: AgentFileView[], demo: boolean }} AgentFilesState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is exactly the two empty divs
 * sections/agent-files.tsx ships and the SSG prerender emits. A first render
 * that drew a "Loading…" line would be a hydration mismatch, which
 * console.errors — and a console error on any route fails proposal checks.
 */
export const INITIAL_AGENT_FILES = /** @type {AgentFilesState} */ ({
  phase: 'idle', files: [], demo: false,
});

export const agentFilesStore = createStore(INITIAL_AGENT_FILES);

/**
 * Published for settings.js, a classic script loaded before this bundle. Same
 * seam and the same reasoning as ./grants-store.js — including why it is not
 * hung off `UsernodeReact.settings`.
 */
if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsAgentFiles = {
    publish: (next) => agentFilesStore.set(next),
  };
}
