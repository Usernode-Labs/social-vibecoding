// The agent-session panel and its store in ONE bundle, for the reason
// ./parked-strip-api.ts gives: tests/lib/render-tsx.js bundles each entry on
// its own, so a store loaded through a second entry would be a second copy the
// panel cannot see.
export { AgentSessionPanel, PreviewCardView, RunCard, SavedDrafts, SpecBody, SpecCard } from '../../frontend/src/features/agent-session/index';
export { buildTranscript } from '../../frontend/src/features/agent-session/transcript';
export {
  openAgentSession,
  openSpec,
  closeSpec,
  getAgentSessionState,
  setSpecTab,
  openPreview,
  dockPreview,
  closePreview,
  proposeChange,
  retryStaging,
  handleEvent,
  PREVIEW_SLOT_ID,
  saveComposerDraft,
  sendSavedDraft,
  editSavedDraft,
  deleteSavedDraft,
  agentSessionDraftsChanged,
  stopAgentTurn,
  stoppedText,
  MAX_SAVED_DRAFTS,
} from '../../frontend/src/features/agent-session/store';
