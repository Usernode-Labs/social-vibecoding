/**
 * The two ACTIONS and the update NOTICE, which is all that outlived the
 * Improve panel (#2718 review).
 *
 * The panel was a drawer you opened from a row in the mark's menu to reach
 * two buttons, a list of sessions and a notice. The sessions are the
 * Workshop's since earlier in this issue, which left a drawer holding two
 * buttons — one tap to open, one to press, for something the menu could
 * simply carry. "Remove the Improve app button and the whole drawer under
 * the platform mark list", and the buttons move up into it.
 *
 * They live here rather than in the menu so the menu stays a menu: these are
 * the Improve feature's controls and they read the Improve store, whatever
 * surface draws them.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { ArrowPathIcon, SpinnerArcIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/**
 * `flex-1 basis-0` so the two share the row evenly, which is what "next to
 * each other" asks for and what the panel's own well did.
 *
 * Every id is the one it has always had: `#improve-row-feedback` is what the
 * outbox dot's writer selects and `#improve-row-new-session` has named
 * Improve.startSession() since the panel existed. Both are ids, so both can
 * exist exactly once — which is why the panel had to go rather than sit
 * behind the menu carrying a second copy.
 */
const ACTION_BASE =
  'inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-9 px-3 '
  + 'rounded-full text-sm font-semibold transition-colors un-touch-target';

const ACTION_FILL =
  'bg-violet-600 hover:bg-violet-500 text-white';

function QuickAction({ id, label, onClick }: {
  id: string;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      className={ACTION_BASE + ' ' + ACTION_FILL}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * Give feedback, then New change.
 *
 * FEEDBACK LEADS, because it is the one action that needs nothing of the
 * viewer — no collaborator bit, no session, no repo — and New change is
 * hidden outright for a viewer who may not write. "Give feedback", not
 * "Feedback": both are things you DO, and a bare noun beside the verb phrase
 * read as a category label sitting next to an action.
 *
 * ON THE PLATFORM TOO. The panel's target could be the platform's own
 * self-hosted row (#1367), and so can this: on Home these act on Homeroom
 * itself, which is what "that also shows up on the platform" asks for.
 */
export function ImproveQuickActions(): ReactNode {
  const state = useStoreState(improveStore);
  return (
    <div
      id="improve-quick-actions"
      className="shrink-0 flex items-stretch gap-2 px-4 pt-1 pb-2"
    >
      <QuickAction
        id="improve-row-feedback"
        label="Give feedback"
        onClick={() => Improve.giveFeedback()}
      />
      {state.readOnly ? null : (
        <QuickAction
          id="improve-row-new-session"
          label="New change"
          onClick={() => Improve.startSession()}
        />
      )}
    </div>
  );
}

/**
 * What is happening to the build, in the panel that offers to change it.
 *
 * Three states, and each is a different kind of thing to say:
 *
 *   - BUILDING. A note, not an offer. Either this app is deploying a merged
 *     change or the platform is rolling one out; there is nothing to press,
 *     so pressing is not offered.
 *   - READY. The one case with an action: the new build is downloaded and a
 *     reload will land on it. `failed` gets the same button with a warier
 *     line, because a reload that might need two tries still beats a tab with
 *     no way forward.
 *     This app's OWN build landing is the same kind of thing with its own
 *     row: the frame is still showing the build before it, and what the row
 *     offers is a reload of the frame, not of the tab (Improve.reloadApp).
 *   - WORKING. Nothing is being deployed, but one of the viewer's own
 *     changes is mid-turn: what the working indicator on the Homeroom mark
 *     means, which the mark cannot say itself (#3015; own work only since the
 *     follow-up, SessionState.anyActiveFor). A note, and the lowest priority
 *     of the four, because the other three are about what the viewer is
 *     running.
 *   - IDLE. Nothing. A row saying "up to date" is a row that is right almost
 *     always and therefore never read.
 *
 * `versionState` is the platform's, published from
 * App.renderPlatformVersionPill; `deploying` is this app's own. They are
 * separate facts with one presentation here, because "something is being
 * built" is what the viewer is asking, and which of the two it is shows in
 * the wording.
 */
export const WORKING_NOTE = 'One of your changes is building right now. The Homeroom mark shows it until it finishes.';

function UpdateStatus(): ReactNode {
  const { versionState, deploying, appUpdateReady, working } = useStoreState(improveStore);
  // After mount only: the prerender prints nothing here, and `working` is
  // live state the hydrating render must not print ahead of it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const platformBusy = versionState === 'deploying' || versionState === 'downloading';
  const ready = versionState === 'ready' || versionState === 'failed';

  if (ready) {
    return (
      <button
        id="improve-update-ready"
        type="button"
        className={'flex w-full items-center gap-3 px-4 py-3 text-left '
          + 'text-sm font-medium text-violet-600 dark:text-violet-400 '
          + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 un-touch-target'}
        onClick={() => window.location.reload()}
      >
        <ArrowPathIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          There is a new version available. Click here to get the new version.
        </span>
      </button>
    );
  }

  if (appUpdateReady) {
    return (
      <button
        id="improve-app-update-ready"
        type="button"
        className={'flex w-full items-center gap-3 px-4 py-3 text-left '
          + 'text-sm font-medium text-violet-600 dark:text-violet-400 '
          + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 un-touch-target'}
        onClick={() => Improve.reloadApp()}
      >
        <ArrowPathIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          This app has a new version. Click here to reload it.
        </span>
      </button>
    );
  }

  if (platformBusy || deploying) {
    // Which one is building decides the wording. Both at once is possible and
    // says the more surprising of the two.
    const line = platformBusy
      ? (versionState === 'downloading'
        ? 'A new version of the platform is downloading. The reload appears once it is ready.'
        : 'A new version of the platform is being built.')
      : 'A new version of this app is being built.';
    return (
      <div
        id="improve-update-note"
        className="flex items-center gap-3 px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <SpinnerArcIcon className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 flex-1">{line}</span>
      </div>
    );
  }

  if (mounted && working) {
    // The mark's own spinner, drawn beside the words that say what it is.
    return (
      <div
        data-improve-working-note
        className="flex items-center gap-3 px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <span className="inline-flex w-4 shrink-0 justify-center text-violet-600 dark:text-violet-400" aria-hidden="true">
          <svg className="w-3 h-3 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="40 57" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">{WORKING_NOTE}</span>
      </div>
    );
  }

  return null;
}

export { UpdateStatus };
