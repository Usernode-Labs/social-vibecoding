/**
 * ONE bundle exporting the three body-mounted Dev modals AND their stores.
 *
 * Same reason as ./dev-card-api.ts: `loadTsx` bundles each entry separately,
 * so loading a component and its store as two entries would hand the test two
 * copies of the module graph and therefore two distinct store objects.
 */

export { AutoSessionModal, AutoSessionCard } from '../../frontend/src/features/dev-board/modals/auto-session-modal';
export { CreditOptionsModal, CreditOptionsCard } from '../../frontend/src/features/dev-board/modals/credit-options-modal';
export { LlmConsentModal, LlmConsentCard } from '../../frontend/src/features/dev-board/modals/llm-consent-modal';
export {
  autoSessionModalStore,
  creditOptionsModalStore,
  llmConsentModalStore,
} from '../../frontend/src/features/dev-board/modals/modals-store';
