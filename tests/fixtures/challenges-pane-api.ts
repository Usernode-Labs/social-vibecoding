/**
 * ONE bundle exporting the Challenges pane AND its store, plus the two
 * chevrons its group headers draw.
 *
 * Same reason as ./dev-modals-api.ts: `loadTsx` bundles each entry separately,
 * so loading the pane and its store as two entries would hand the test two
 * copies of the module graph and therefore two distinct store objects.
 */

export { ChallengesPane } from '../../frontend/src/features/leaderboard/challenges-pane';
export { topochainChallengesStore } from '../../frontend/src/features/leaderboard/topochain-challenges-store.js';
export { ChevronDownIcon, ChevronUpIcon } from '../../frontend/@/components/ui/icons';
