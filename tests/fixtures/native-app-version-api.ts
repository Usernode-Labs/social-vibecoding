/**
 * The drawer's mobile-app-version row plus its store, from ONE entry — see
 * ./dev-card-api.ts for why loading them separately would hand the test a
 * different store object from the one the component subscribes to.
 */

export {
  NativeAppVersionRow,
} from '../../frontend/src/features/header/native-app-version-row';
export {
  nativeAppVersionStore,
} from '../../frontend/src/features/header/native-app-version-store';
