/**
 * Which step of "How it got here" is open over the thread's card.
 *
 * The timeline is portalled into a host beside the card (./thread-rail.tsx)
 * and the layer it opens is drawn inside the card (./thread-card.tsx
 * `StepLayer`), by whichever part of the page holds that step's content: the
 * page's head for the request's words and a plan, a change's own section for
 * its votes and its tests. They share this one store, so a press in the
 * timeline, the card's foot and the layer's × all move the same thing.
 *
 * One page is on screen at a time; `page` is the page the open step belongs
 * to, so a step left open does not follow the reader to the next thread.
 */

import { createStore } from '../../../lib/plain-store.js';
import { useStoreState } from '../../../lib/use-store-state';
import type { ChangeRailInput, RailOpen } from './rail-model';

export interface StepState {
  page: string | null;
  open: RailOpen | null;
}

export const stepStore = createStore<StepState>({ page: null, open: null });

/** Pure: the two name the same step's content. */
export function sameStep(a: RailOpen | null, b: RailOpen | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'plan' && b.kind === 'plan') return a.key === b.key;
  if ('changeId' in a && 'changeId' in b) return a.changeId === b.changeId;
  return true;
}

/** Pure: both are about one change's votes and tests, which one layer holds. */
export function isGates(open: RailOpen | null, changeId: number | null): boolean {
  return !!open && (open.kind === 'checks' || open.kind === 'votes') && open.changeId === changeId;
}

export function openStep(page: string, open: RailOpen): void {
  const now = stepStore.get();
  // Pressing the open step again closes it.
  if (now.page === page && sameStep(now.open, open)) stepStore.set({ page, open: null });
  else stepStore.set({ page, open });
}

export function closeStep(): void {
  if (stepStore.get().open) stepStore.set({ open: null });
}

/** The step open on `page`, or null. */
export function useOpenStep(page: string): RailOpen | null {
  const state = useStoreState<StepState>(stepStore as any);
  return state.page === page ? state.open : null;
}

/**
 * A request's one change, as its own timeline would read it. The change's
 * section holds its votes and tests (./thread-changes.tsx) and the request's
 * head draws the timeline (./request-head.tsx), so the section publishes
 * what the timeline needs here. With it the request's last steps are the
 * change's phase, the same one its foot reads, and the two agree.
 */
export const leadStore = createStore<{ page: string | null; lead: ChangeRailInput | null }>({ page: null, lead: null });

export function publishLead(page: string, lead: ChangeRailInput | null): void {
  const now = leadStore.get();
  if (!lead && now.page !== page) return;
  leadStore.set({ page: lead ? page : null, lead });
}

/** The one change published for `page`, or null. */
export function useLead(page: string): ChangeRailInput | null {
  const state = useStoreState<{ page: string | null; lead: ChangeRailInput | null }>(leadStore as any);
  return state.page === page ? state.lead : null;
}
