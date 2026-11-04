/**
 * The shared-spec reader's view model — folded into the detail store
 * (../ai/detail.ts) when plans became one kind of detail beside a thread
 * (#6230, 3 Nov 2026). The names stay here so a reader of the old module
 * still finds them; the state itself is the detail store's.
 */

export type {
  SpecPanelBody,
  DetailState as SpecPanelState,
} from '../ai/detail';
