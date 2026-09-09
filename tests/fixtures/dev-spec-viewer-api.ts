/**
 * The dev chat's shared-spec reader plus its store, from ONE entry — see
 * ./dev-card-api.ts for why loading them separately would hand the test a
 * different store object from the one the component subscribes to.
 */

export {
  SpecViewer,
  SpecViewerView,
} from '../../frontend/src/features/dev-chat/spec-viewer';
export { specViewerStore } from '../../frontend/src/features/dev-chat/spec-viewer-store';
