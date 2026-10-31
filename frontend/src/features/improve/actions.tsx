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

import { type ReactNode } from 'react';

import { ArrowPathIcon, SpinnerArcIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { owedHomeWalk } from '../app-context/about-data';
import { useFirstSessionVisit } from '../first-session/tour-running';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { designThisScreen } from '../design/start';

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
 * now", Messages' "+" choice, in the Agents list that is agent chats' one
 * home (#4729: it also led the Homeroom menu's Agent chats section, which
 * has since left the menu whole). Until then this button is the menu's one
 * way to change the app, which is the point for a first-time user.
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
  const t = useMessages('agent');
  return (
    <>
      <div
        id="improve-quick-actions"
        className="shrink-0 flex items-stretch gap-2 px-4 pt-1 pb-2"
      >
        <QuickAction
          id="improve-row-feedback"
          label={t('agent:menu.suggestImprovement')}
          onClick={() => Improve.giveFeedback()}
        />
      </div>
      <DesignScreenAction />
    </>
  );
}

/**
 * #6071: Design this screen. A quiet row under the one filled action, not a
 * second button beside it: it copies what is on screen now (Homeroom's page,
 * or the app on its App tab) into a private design thread in the person's
 * chat with Homeroom bot, who edits it with them (../design/start.ts).
 */
function DesignScreenAction(): ReactNode {
  const t = useMessages('agent');
  return (
    <div className="shrink-0 px-4 pb-2">
      <button
        id="improve-row-design"
        type="button"
        onClick={() => { void designThisScreen(); }}
        className="w-full h-9 px-3 rounded-full text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40 transition-colors un-touch-target"
      >
        {t('agent:menu.designScreen')}
      </button>
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
 * the wording. Each line names what it is about, Homeroom or the app by its
 * name: right under the app's name at the top of this menu, "There is a new
 * version available" read as the app having changed, a minute after
 * somebody signed up (Evan, sign-up test, 19 Oct 2026). The row is a button
 * on a phone and with a mouse, so the words say what it does, not "Click".
 *
 * NOT FOR A NEWCOMER. Somebody who has not reached Homeroom yet (the first
 * session's walk on Home still owed on this device, or a first-session visit
 * under way: ../first-session/) is told nothing about Homeroom's own
 * updates. The new build is still fetched, so their next launch lands on it;
 * the reload on the next launch, not mid-use, is unchanged
 * (public/js/app.js's fresh-shell rules). Their app's own lines stay.
 */
function UpdateStatus(): ReactNode {
  const t = useMessages('agent');
  const { versionState, deploying, appUpdateReady } = useStoreState(improveStore);
  const { name } = useStoreState(improveStore);
  const firstVisit = useFirstSessionVisit();
  const newcomer = firstVisit || owedHomeWalk();
  const platformBusy = !newcomer && (versionState === 'deploying' || versionState === 'downloading');
  const ready = !newcomer && (versionState === 'ready' || versionState === 'failed');
  const app = (name || '').trim();

  if (ready) {
    return (
      <UpdateReadyRow id="improve-update-ready" onUpdate={() => window.location.reload()}>
        {t('agent:menu.update.platformReady')}
      </UpdateReadyRow>
    );
  }

  if (appUpdateReady) {
    return (
      <UpdateReadyRow id="improve-app-update-ready" onUpdate={() => Improve.reloadApp()}>
        {app ? t('agent:menu.update.appReady', { app }) : t('agent:menu.update.appReadyUnnamed')}
      </UpdateReadyRow>
    );
  }

  if (platformBusy || deploying) {
    // Which one is building decides the wording. Both at once is possible and
    // says the more surprising of the two.
    const line = platformBusy
      ? (versionState === 'downloading'
        ? t('agent:menu.update.platformDownloading')
        : t('agent:menu.update.platformBuilding'))
      : (app ? t('agent:menu.update.appBuilding', { app }) : t('agent:menu.update.appBuildingUnnamed'));
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

/**
 * A new build is ready: a short line naming what has the update (#5577),
 * then "Reload" at the row's end (polish N4). It read "There is a new
 * version available. Click here to get the new version." in link blue, a run
 * of text with nothing on a phone to tap but the words. The whole row is
 * still the one button, so the target is the row's full height, and the pill
 * is what says it does something.
 */
function UpdateReadyRow({ id, onUpdate, children }: { id: string; onUpdate: () => void; children: ReactNode }): ReactNode {
  const t = useMessages('agent');
  return (
    <button
      id={id}
      type="button"
      className={'flex w-full items-center gap-3 px-4 py-3 text-left '
        + 'text-sm font-medium text-zinc-900 dark:text-zinc-100 '
        + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 un-touch-target'}
      onClick={onUpdate}
    >
      <ArrowPathIcon className="w-5 h-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      <span className="min-w-0 flex-1">{children}</span>
      <span className="shrink-0 rounded-full bg-violet-600 px-3 py-1 text-[13px] font-semibold text-white">
        {t('agent:menu.update.action')}
      </span>
    </button>
  );
}

export { UpdateStatus };
