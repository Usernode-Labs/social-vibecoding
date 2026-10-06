/**
 * The ACTION and the update NOTICE, which is all that outlived the Improve
 * panel (#2718 review). There were two actions until the UI overhaul; see
 * ImproveQuickActions.
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

import { ArrowPathIcon, SendIcon, SpinnerArcIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { sendQueuedNow } from '../dialogs/feedback-queue-send.js';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/**
 * `flex-1` so the one action spans the menu's width, which is what the
 * design draws: a single filled button over the list, not two sharing a row.
 *
 * The id is the one it has always had: `#improve-row-feedback` is what the
 * outbox dot's writer selects, and an id can exist exactly once.
 */
const ACTION_BASE =
  'inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-3 '
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
 * Suggest an improvement: ONE BUTTON, where there were two (UI overhaul).
 *
 * The menu offered "Give feedback" and "New change" side by side, and people
 * found both confusing: feedback read as a note to nobody in particular, and
 * New change started an agent session without saying so. The two did the
 * same thing from where the viewer stands, asking for something to change,
 * and differed in who does the work. So the button asks for the change (the
 * same dialog, headed "Suggest an improvement", which posts a request members
 * can see, vote on and pick up), and building it yourself is "Build it
 * yourself", leading the list's Agent chats below, which shows once the
 * viewer has had an agent session (../app-context/app-context-sheet.tsx
 * AgentChats). Until then this button is the menu's one way to change the
 * app, which is the point for a first-time user.
 *
 * It said "Ask for a change" until the first-session run-through (5 Oct
 * 2026), which asked for words a first-time user would use.
 *
 * It needs nothing of the viewer (no collaborator bit, no session, no repo),
 * so it is always shown.
 *
 * ON THE PLATFORM TOO. The panel's target could be the platform's own
 * self-hosted row (#1367), and so can this: on Home it asks Homeroom itself.
 */
export function ImproveQuickActions(): ReactNode {
  return (
    <div
      id="improve-quick-actions"
      className="shrink-0 flex items-stretch gap-2 px-4 pt-1 pb-2"
    >
      <QuickAction
        id="improve-row-feedback"
        label="Suggest an improvement"
        onClick={() => Improve.giveFeedback()}
      />
    </div>
  );
}

/**
 * #4004: the saved-offline-feedback row. While messages wait in the outbox —
 * the same count the dialog's queue line shows and the mark's dot lights —
 * the menu offers to push them out right now instead of waiting out the
 * retry schedule. The row reads like the reload rows above (UpdateStatus's
 * ready rows: a full-width tap row, a leading glyph, violet words, the whole
 * row the button), with the count sentence written the way the dialog writes
 * it.
 *
 * Rendered by the app-context sheet as a SIBLING of #improve-quick-actions,
 * never inside it: the declared check
 * `#improve-quick-actions > #improve-row-feedback:only-child` pins that
 * container to one button. It sits immediately ABOVE that container, because
 * `#improve-quick-actions + #switcher-nav` (two more checks) pins the list to
 * follow it directly.
 *
 * AFTER MOUNT ONLY, like AgentChats in the sheet: the count is published by
 * the feedback controller's sequenced read, which can land around hydration,
 * so the hydrating render must draw what the prerender drew — nothing — and
 * the row arrives one commit later. Nothing is waiting in the prerendered
 * document by construction.
 */
function QueueActions(): ReactNode {
  const { queuedFeedback } = useStoreState(improveStore);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted || !(queuedFeedback > 0)) return null;
  return (
    <button
      id="improve-queue-send"
      type="button"
      className={'flex w-full items-center gap-3 px-4 py-3 text-left '
        + 'text-sm font-medium text-violet-600 dark:text-violet-400 '
        + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 un-touch-target'}
      onClick={() => { void sendQueuedNow(); }}
    >
      <SendIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {queuedFeedback === 1
          ? '1 message saved on this device is waiting to send. Send now.'
          : `${queuedFeedback} messages saved on this device are waiting to send. Send now.`}
      </span>
    </button>
  );
}

export { QueueActions };

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
 *   - IDLE. Nothing. A row saying "up to date" is a row that is right almost
 *     always and therefore never read.
 *
 * NO NOTE FOR THE VIEWER'S OWN WORK (#3075). One of your changes being
 * mid-turn had a fourth line here (#3015), saying what the corner spinner on
 * the Homeroom mark meant. The spinner stays (../header/platform-mark.tsx,
 * with its hover title); the sentence under it went, because the menu that
 * carried it lists the working session itself under Continue, spinner and
 * all, which says the same thing where it can be acted on.
 *
 * `versionState` is the platform's, published from
 * App.renderPlatformVersionPill; `deploying` is this app's own. They are
 * separate facts with one presentation here, because "something is being
 * built" is what the viewer is asking, and which of the two it is shows in
 * the wording.
 */
function UpdateStatus(): ReactNode {
  const { versionState, deploying, appUpdateReady } = useStoreState(improveStore);
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

  return null;
}

export { UpdateStatus };
