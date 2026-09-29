/**
 * `#profile-proposals-screen` — "Your proposals" (#5310): every proposal the
 * viewer has started, across every project, grouped by status.
 *
 * Reached from Profile's `#profile-row-proposals` row
 * (./account-panel.tsx) at `#profile/proposals`. The legacy router
 * (`App.navigateToProfileProposals`, public/js/app.js) is a classic script
 * and cannot import from this bundle, so it reaches the controller below by
 * name through `window.UsernodeReact.profileProposals`, the same seam as
 * `window.UsernodeReact.workshop`.
 *
 * A fully React-owned sibling screen like `#workshop-screen`: no
 * `public/js/**` module writes inside this root. It ships hidden and EMPTY:
 * the rows arrive from GET /api/me/proposal-history in the controller's
 * open(), never in the first render, so the prerender and the hydration
 * agree.
 */

import { useRef, type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { proposalsView } from './profile-store.js';

type ProposalsState = {
  open: boolean;
  /** GET /api/me/proposal-history's body; null until it answers. */
  data: unknown;
  error: boolean;
};

const initial: ProposalsState = { open: false, data: null, error: false };
const profileProposalsStore = createStore(initial);

const TITLE = 'text-base font-semibold';
const SUBTITLE = 'text-[0.8125rem]';
const NOTE = 'px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400';

function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

export function ProfileProposalsScreen(): ReactNode {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(profileProposalsStore) as ProposalsState;
  useVisibilityHiddenClass(screenRef, 'profile-proposals-screen', false);
  const view = proposalsView(state.data);

  return (
    <main
      ref={screenRef}
      id="profile-proposals-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
    >
      {/* `pt-5` clears the header's notch, as on the Workshop screen. The bar
          is the title, so the screen draws no heading of its own. */}
      <div className="max-w-2xl mx-auto pt-5 pb-8">
        {state.error ? (
          <div className={NOTE}>
            <p>Your proposals could not be loaded.</p>
            <button
              type="button"
              className="mt-2 font-medium text-violet-600 dark:text-violet-400"
              onClick={() => { void profileProposalsController.reload(); }}
            >
              Try again
            </button>
          </div>
        ) : !view.loaded ? (
          state.open ? <p className={NOTE}>Loading…</p> : null
        ) : view.empty ? (
          <p className={NOTE}>You have not started a proposal yet.</p>
        ) : (
          view.sections.map((section) => (
            <section key={section.key} className="mt-2">
              <SectionHeader>{section.label}</SectionHeader>
              <GroupedList className="mx-0" tone="plane">
                {section.rows.map((row) => (
                  <ListRow
                    key={row.key}
                    as="a"
                    href={row.href}
                    title={row.title}
                    titleClassName={TITLE}
                    subtitle={row.meta}
                    subtitleClassName={SUBTITLE}
                  />
                ))}
              </GroupedList>
            </section>
          ))
        )}
      </div>
    </main>
  );
}

/**
 * The legacy seam. `open` is the liveness flag a load checks before it
 * publishes, so an answer that lands after the viewer left cannot paint into
 * a screen they are no longer on.
 */
export const profileProposalsController = {
  open() {
    profileProposalsStore.set({ open: true });
    return profileProposalsController.reload();
  },
  close() {
    profileProposalsStore.set({ open: false });
  },
  isOpen() {
    return profileProposalsStore.get().open;
  },
  async reload() {
    profileProposalsStore.set({ error: false });
    let data: unknown = null;
    try {
      const res = await fetch(`/api/me/proposal-history${demoQuery()}`, { credentials: 'same-origin' });
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }
    if (!profileProposalsStore.get().open) return;
    if (!data) {
      profileProposalsStore.set({ error: true });
      return;
    }
    profileProposalsStore.set({ data, error: false });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.profileProposals = profileProposalsController;
}

export { profileProposalsStore };
