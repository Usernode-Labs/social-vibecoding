/**
 * `#github-link-body` — the social-account ownership proofs and the daily
 * credit tier they unlock, as a view model.
 *
 * `settings.js` used to build this whole block with `document.createElement`:
 * a tier card, a row per provider (heading, state line, linked-at, the
 * "no token held" line, a Connect anchor or a disabled button, Disconnect, an
 * audit note, a stranded-attempt note) and, for an admin, a diagnostics panel
 * with a Copy control and a live credential check. It pushes THIS instead, and
 * ./social-identity.tsx is the only writer of the DOM below that host.
 *
 * ── Every branch is resolved here ─────────────────────────────────────
 *
 * There are a lot of them and none is cosmetic: five tier states, five
 * provider states, and the demo variants of both actions. They are decided
 * where the payload, the entitlement policy and the `?demo=` flag already live,
 * so the component renders text and tone rather than re-deriving eligibility.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * `#github-link-status` — a SIBLING of this host. `_socialIdentityCallbackStatus`
 * reads the OAuth result out of the hash query and paints it, which is about
 * the navigation that just happened rather than about the block's contents.
 *
 * The two things the component owns as its OWN state, because they are
 * transient and never leave the subtree: the Copy control's "Copied" flash and
 * the configuration check's in-flight/verdict line. Both were local variables
 * closed over by a listener before.
 *
 * @typedef {{ title: string, detail: string, tone: 'plain'|'warn'|'ok' }} TierCardView
 * @typedef {{ source: string, callbackUrl: string, warning: string, demo: boolean,
 *             name: string, provider: string }} DiagnosticsView
 * @typedef {{
 *   provider: 'github'|'x', name: string, heading: string,
 *   state: { text: string, tone: 'amber'|'emerald'|'muted' },
 *   linkedAt: string|null, noToken: string|null,
 *   connect: { label: string, href: string|null }|null,
 *   unlink: { disabled: boolean }|null,
 *   strandedNote: string|null, diagnostics: DiagnosticsView|null,
 * }} ProviderRowView
 * @typedef {{ phase: 'idle'|'loading'|'error'|'ready', message: string|null,
 *             tier: TierCardView|null, providers: ProviderRowView[] }} SocialIdentityState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is the empty `<div id="github-link-body">`
 * sections/connectors.tsx ships. `loading` and `error` are the two bare text
 * nodes `_loadGithubLink` wrote with `textContent`.
 */
export const INITIAL_SOCIAL_IDENTITY = /** @type {SocialIdentityState} */ ({
  phase: 'idle', message: null, tier: null, providers: [],
});

export const socialIdentityStore = createStore(INITIAL_SOCIAL_IDENTITY);

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsSocialIdentity = {
    publish: (next) => socialIdentityStore.set(next),
  };
}
