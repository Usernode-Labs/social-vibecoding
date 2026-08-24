/**
 * One store per body-mounted Dev modal.
 *
 * Separate stores rather than one with three slots: each modal's host is
 * created and removed by `public/js/app-view.js` on every open, so they are
 * never on screen together and a shared store would only couple their
 * lifetimes. `null` is "not open" and is what the host renders between the
 * mount and the publish on the same tick.
 *
 * All three install `setFlush(flushSync)` in ../mount.ts, because the module
 * binds the dialog's dismissal — and, for the Generate-proposal picker, reads
 * the option list back — on the line after it publishes.
 */

import { createStore } from '../../../lib/plain-store.js';
import type {
  AutoSessionModalView,
  CreditOptionsModalView,
  LlmConsentModalView,
} from './model';

export const autoSessionModalStore = createStore<{ view: AutoSessionModalView | null }>({ view: null });
export const creditOptionsModalStore = createStore<{ view: CreditOptionsModalView | null }>({ view: null });
export const llmConsentModalStore = createStore<{ view: LlmConsentModalView | null }>({ view: null });
