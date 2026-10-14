/**
 * The App tab's placeholder island plus the store it reads — one entry, so
 * the test drives the SAME store object app-view.js publishes into. See
 * ./dev-card-api.ts for why that matters.
 */

export { AppStatus, AppStatusView_, heldForTour } from '../../frontend/src/features/app-frame/app-status';
export { appStatusStore } from '../../frontend/src/features/app-frame/app-status-store.js';
export { setTourRunning } from '../../frontend/src/features/first-session/tour-running';
