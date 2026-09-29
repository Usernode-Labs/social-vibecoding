/**
 * Whether an app Workshop's "Which project?" panel is open (#2768).
 *
 * THE CONTROL AND THE PANEL ARE IN TWO REACT ROOTS, which is why this is a
 * store and not the `useState` it used to be inside `AppWorkshopScope`
 * (./workshop-chrome.tsx). The control is the HEADER's icon and name
 * (features/header/header-title.tsx): on a phone since #2768, and on a
 * desktop too since #3295, which retired the scope chip that used to lead the
 * app's Workshop there — a second picture of the app, under a header saying
 * the same thing. The panel itself stays where it always rendered, at the
 * top of the Workshop page, so it drops down from right under the header
 * that opened it.
 *
 * It is not `workshopStore.picker`: that flag was the all-apps screen's, which
 * has no switcher any more (#2759), and a flag shared between two screens is
 * a panel left open on one greeting the other.
 *
 * `open: false` is the prerender: the panel renders only once somebody taps.
 */

import { createStore } from '../../lib/plain-store.js';

export const appScopeStore = createStore({ open: false });

/**
 * The panel's id, which the header's control names in its `aria-controls` —
 * one spelling, so the two cannot point at different elements. It is the
 * retired chip's id (#dev-ws-scope-chip) plus `-picker`, kept as it was.
 */
export const APP_SCOPE_PANEL_ID = 'dev-ws-scope-chip-picker';
