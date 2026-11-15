/**
 * ONE bundle exporting the body-mounted app-allowance consent modal AND its
 * store.
 *
 * Same reason as ./dev-card-api.ts: `loadTsx` bundles each entry separately,
 * so loading a component and its store as two entries would hand the test two
 * copies of the module graph and therefore two distinct store objects.
 */

export { LlmConsentModal, LlmConsentCard } from '../../frontend/src/features/dev-board/modals/llm-consent-modal';
export { llmConsentModalStore } from '../../frontend/src/features/dev-board/modals/modals-store';
