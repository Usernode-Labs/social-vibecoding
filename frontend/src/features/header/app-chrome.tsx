/**
 * #app-chrome-controls — the two in-app controls the Homeroom menu alone used
 * to carry (#3702): the votes waiting on you for the app on screen, and Ask
 * for a change, beside the Homeroom mark in the running app's header.
 *
 * ── What this replaces, and what it keeps ───────────────────────────
 *
 * Both ways into the group's loop sat one tap into the mark's menu:
 * "N to vote" was the trailing figure on its "Go to community hub" row
 * (../app-context/app-context-sheet.tsx) and "Ask for a change" its filled
 * button (../improve/actions.tsx). Neither is removed — the menu keeps both
 * rows exactly as they were — this puts the same two things on the bar the
 * app's own chrome draws, where the change on screen is what you are
 * reacting to.
 *
 * ── The vote pill ──────────────────────────────────────────────────
 *
 * The count is the same number the menu row shows: GET /api/workshop/counts
 * answers per app, and `unseenNeeds` (../workshop/needs-seen.ts) leaves the
 * votes swiped past out of it (#3526). Loaded on mount-and-when-the-app
 * changes, never during render: the prerender ships no figure and a fetch in
 * a first render would be a hydration mismatch. Failure is silence — the pill
 * is a shortcut, the menu row still works.
 *
 * Pressing it is the same door the "Go to community hub" row opens, turned to
 * Needs you: `AppView._landOnTab(slug, 'needs')` writes the remembered tab
 * (the door the hub's own links use), then `App.openAppTab(slug, 'dev')`
 * routes to the project page, which opens on it. Getting started's Look step
 * is the same pair (../home/getting-started.tsx). The app stays parked
 * (parked-store.js) and resumable from the strip above the tab bar, the way
 * every other door out of an app leaves it.
 *
 * ── The Suggest pill ───────────────────────────────────────────────
 *
 * Opens the existing Ask for a change dialog (`#feedback-modal`), pre-scoped
 * to the app on screen with `target: 'app'` — the payload Getting started's
 * Suggest passes (features/home/getting-started.tsx), which the dialog's
 * controller takes as the press that already made the choice (#2707). The
 * same dialog, the same wording, one entry deeper into the place it is about.
 *
 * ── Where the two sit ─────────────────────────────────────────────
 *
 * In the header's right group, to the LEFT of the bell and the mark — a
 * neighbour of the controls already there, inside the measured group, so
 * use-header-layout.ts keeps counting them towards the title's clearance and
 * the row keeps its 28px ceiling. Hidden at zero ("0 to vote" is a row that
 * is right almost always and therefore never read) and on the platform's own
 * screens (an app's chrome names no app).
 *
 * CHROMELESS MODE HIDES THE BAR ITSELF (App.setChromeless publishes
 * 'platform-header' false), so these controls ride it down rather than
 * floating over the app: they render inside #platform-header, which is
 * `hidden` there. No new fixed layer, no safe-area surface of its own to
 * place.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { PencilSparklesIcon } from '@/components/ui/icons';

import { useVisibility } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { hydrateNeedsSeen, unseenNeeds } from '../workshop/needs-seen';

/** The pill shell: 24px tall, the header's content row holds it. */
const PILL_BASE = 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full '
  + 'text-[0.75rem] font-semibold un-touch-target transition-colors shrink-0';

/** The vote pill's ink: the one accent, doing the job it is for (#3702). */
const VOTE_CLS = PILL_BASE + ' bg-violet-600 hover:bg-violet-500 text-white';

/** The Suggest pill: a quiet control, not a second accent. */
const SUGGEST_CLS = PILL_BASE + ' border border-[color:var(--brand-line)] '
  + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] '
  + 'hover:brightness-95';

type ShellWindow = {
  App?: {
    openAppTab?: (slug: string, tab?: string, opts?: unknown) => unknown;
    openFeedbackModal?: (opts?: { target?: 'app' }) => void;
  };
  AppView?: { _landOnTab?: (slug: string, tab: string) => void };
};

/** The owed count the pill shows, or null for none (and for a failed read). */
function useOwedCount(slug: string | null, headerVisible: boolean): number | null {
  const [owed, setOwed] = useState<number | null>(null);

  useEffect(() => {
    if (!slug || !headerVisible) { setOwed(null); return; }
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/workshop/counts${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const c = data?.counts?.[slug];
        // #3526: less the votes swiped past in a Needs you feed, as every
        // other count of them is (../workshop/needs-seen.ts).
        hydrateNeedsSeen();
        const n = c && typeof c.needs === 'number'
          ? unseenNeeds(slug, c.needs, Array.isArray(c.owed) ? c.owed : null)
          : null;
        if (live && typeof n === 'number' && n > 0) setOwed(n);
        else if (live) setOwed(null);
      } catch {
        // Offline is a state, not a failure: no figure, the menu row works.
        if (live) setOwed(null);
      }
    })();
    return () => { live = false; };
  }, [slug, headerVisible]);

  return owed;
}

export function AppChromeControls(): ReactNode {
  const headerVisible = useVisibility('platform-header', true);
  const { slug, selfHosted } = useStoreState(improveStore);
  const owed = useOwedCount(slug, headerVisible);

  // The platform's own screens name no app: the pill would say "0" of nothing
  // and Suggest would open the dialog about the platform, which the menu's
  // own rows still offer. Hidden here rather than at zero, because it is
  // WHERE, not WHAT, that decides.
  if (!slug || selfHosted || !headerVisible) return null;

  const goToNeeds = () => {
    const win = window as unknown as ShellWindow;
    win.AppView?._landOnTab?.(slug, 'needs');
    void win.App?.openAppTab?.(slug, 'dev');
  };
  const suggest = () => {
    // The app on screen is the subject: the dialog opens with it chosen.
    (window as unknown as ShellWindow).App?.openFeedbackModal?.({ target: 'app' });
  };

  return (
    <>
      {owed ? (
        <button
          id="app-chrome-owed"
          type="button"
          className={VOTE_CLS}
          aria-label={`${owed} to vote`}
          title={`${owed} to vote`}
          data-app-chrome-owed={String(owed)}
          onClick={goToNeeds}
        >
          {`${owed} to vote`}
        </button>
      ) : null}
      <button
        id="app-chrome-suggest"
        type="button"
        className={SUGGEST_CLS}
        aria-label="Ask for a change"
        title="Ask for a change"
        data-app-chrome-suggest=""
        onClick={suggest}
      >
        <PencilSparklesIcon className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Suggest</span>
      </button>
    </>
  );
}
