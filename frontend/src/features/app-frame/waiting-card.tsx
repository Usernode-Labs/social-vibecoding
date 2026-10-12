/**
 * WHILE YOU WAIT (#4396): the App tab's waiting screen, for a member who is
 * not the maker of a first version that is not ready yet. An invited person
 * who joins early lands on that screen, full screen, and it used to offer
 * nothing to tap. Under the thumbnail and its build line, one card with
 * three rows:
 *
 *   Say hi to the group   the maker's note from the project's channel
 *                         ("sam: “…”"), else "Introduce yourself". Opens the
 *                         project's Discussion over the app, as a sheet.
 *   See the plan          "<N> things it will do", when there is a plan.
 *                         Opens it read only, as a sheet.
 *   Suggest something     the Homeroom menu's Suggest an improvement
 *                         (Improve.giveFeedback); a request made before the
 *                         first version is live waits in the queue.
 *
 * The data is AppView's (public/js/app-view.js _firstVersionWaiting, from
 * GET /api/apps/:slug `first_version`: routes/apps.js waitingMemberFields),
 * handed over in the screen's view, so this draws nothing the server did not
 * say. The maker's own screen has no card (Review the plan, Open Homeroom
 * bot), and once the first version is ready the screen is another one.
 *
 * ── The Discussion sheet is the Discussion tab's room ────────────────────
 *
 * The sheet mounts ../dev-board/workshop/project-discussion.tsx, the
 * project page's own Discussion (the group chat's pane, composer and reply
 * threads), rather than leaving for the hub: a private member who has not
 * been Home yet cannot reach it. It reads the project's community record
 * (useCommunity, the hub's), whose `channel` says whether the viewer may talk
 * there; the server's join gates are what they are everywhere.
 *
 * The group chat's pane has fixed ids (#gc-messages, #gc-input), and the
 * Discussion tab cannot be up at the same time: #app-content holds either
 * this screen or the project page (AppView._teardownDevRoots). The sheet is
 * a CSS sheet over a scrim, not handed to the native kit: the kit moves the
 * panel, and the chat's host must stay where it was mounted.
 *
 * Island rules: the card renders only from a view AppView publishes after
 * boot, and the sheets only while open, into document.body.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { ChatIcon, LightBulbIcon, ListLinesIcon, XIcon } from '@/components/ui/icons';

import { pushDismissible } from '../../lib/back-stack';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { type BuildLineState, BuildLine } from '../first-session/build-line';
import { reloadCommunity, useCommunity } from '../dev-board/workshop/community-card';
import { PlanLines, decidesLine, type MemberPlan } from '../dev-board/workshop/plan-page';
import { ProjectDiscussion } from '../dev-board/workshop/project-discussion';
import { Improve } from '../improve/improve-controller.js';

/** What the card is drawn from (AppView._firstVersionWaiting). */
export interface FirstVersionWaiting {
  slug: string;
  name: string;
  /** Who made it, by username. */
  maker: string | null;
  /** The first thing its maker said in the project's channel, in one line. */
  makerNote: string | null;
  /** The plan as members read it, when there is one. */
  plan: MemberPlan | null;
}

/** "Say hi to the group"'s second line. */
export function sayHiLine(waiting: Pick<FirstVersionWaiting, 'maker' | 'makerNote'>): string {
  return waiting.maker && waiting.makerNote
    ? translate('agent:appFrame.waiting.sayHi.makerNote', { maker: waiting.maker, note: waiting.makerNote })
    : translate('agent:appFrame.waiting.sayHi.introduce');
}

/** "See the plan"'s second line: "3 things it will do". */
export function planCountLine(plan: MemberPlan): string {
  return translate('agent:appFrame.waiting.plan.count', { count: plan.bullets.length });
}

/** "Suggest something"'s second line, as its message id. */
export const SUGGEST_LINE = 'agent:appFrame.waiting.suggest.sub';

type Sheet = 'discussion' | 'plan' | null;

const TILE = 'h-10 w-10 rounded-[12px] [&>svg]:h-5 [&>svg]:w-5';

export function WaitingCard({ waiting, line }: { waiting: FirstVersionWaiting; line: BuildLineState | null }): ReactNode {
  // Subscribed: the helpers' lines are read in the language on screen.
  const t = useMessages('agent');
  useMessages('project');
  const [sheet, setSheet] = useState<Sheet>(null);
  const plan = waiting.plan && waiting.plan.bullets.length ? waiting.plan : null;
  return (
    <div className="w-full max-w-[342px] pt-3 text-left" data-app-first-version-waiting="">
      <SectionHeader className="px-1 pb-2 pt-0">{t('agent:appFrame.waiting.title')}</SectionHeader>
      <GroupedList tone="plane" className="mx-0">
        <ListRow
          as="button"
          data-waiting-row="discussion"
          leading={<IconTile className={TILE}><ChatIcon aria-hidden="true" /></IconTile>}
          title={t('agent:appFrame.waiting.sayHi.title')}
          subtitle={sayHiLine(waiting)}
          onClick={() => setSheet('discussion')}
        />
        {plan ? (
          <ListRow
            as="button"
            data-waiting-row="plan"
            leading={<IconTile className={TILE}><ListLinesIcon aria-hidden="true" /></IconTile>}
            title={t('agent:appFrame.waiting.plan.title')}
            subtitle={planCountLine(plan)}
            onClick={() => setSheet('plan')}
          />
        ) : null}
        <ListRow
          as="button"
          data-waiting-row="suggest"
          leading={<IconTile className={TILE}><LightBulbIcon aria-hidden="true" /></IconTile>}
          title={t('agent:appFrame.waiting.suggest.title')}
          subtitle={t(SUGGEST_LINE)}
          onClick={() => Improve.giveFeedback()}
        />
      </GroupedList>
      {/* ONE sheet whose body changes ("Talk about it in Discussion" turns
          the plan into the room): a second sheet would release the first's
          back record (lib/back-stack.ts) as it pushed its own, and that
          traversal would close it. */}
      {sheet ? (
        <WaitSheet
          id={sheet === 'discussion' ? 'app-waiting-discussion' : 'app-waiting-plan'}
          title={sheet === 'discussion'
            ? t('agent:appFrame.waiting.sheet.discussion', { project: waiting.name })
            : t('agent:appFrame.waiting.sheet.plan', { project: waiting.name })}
          tall={sheet === 'discussion'}
          onClose={() => setSheet(null)}
        >
          {sheet === 'discussion' ? <DiscussionBody slug={waiting.slug} name={waiting.name} /> : plan ? (
            <div className="flex flex-col gap-3">
              <PlanLines name={waiting.name} plan={plan} />
              {line ? <BuildLine state={line} note={lineNote(line)} className="px-1" /> : null}
              <p className="px-1 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400" data-waiting-plan-who="">
                {decidesLine(waiting.maker, line)}
              </p>
              <Button
                type="button"
                variant="neutral"
                ink="neutral"
                layout="full"
                className="min-h-[44px]"
                data-waiting-plan-discussion=""
                onClick={() => setSheet('discussion')}
              >
                {t('agent:appFrame.waiting.plan.talk')}
              </Button>
            </div>
          ) : null}
        </WaitSheet>
      ) : null}
    </div>
  );
}

/** How long building a first version usually takes (bot-thanks-card.tsx's words), while it builds. */
export function lineNote(line: BuildLineState | null): string | null {
  return line === 'building' ? translate('agent:appFrame.waiting.buildNote') : null;
}

/**
 * The project's Discussion, as its page's tab draws it, once its record is
 * read: read afresh as the sheet opens, so the room is the one there is now.
 */
function DiscussionBody({ slug, name }: { slug: string; name: string }): ReactNode {
  const t = useMessages('agent');
  const data = useCommunity(slug);
  const [read, setRead] = useState(false);
  useEffect(() => {
    let live = true;
    void reloadCommunity(slug).then(() => { if (live) setRead(true); });
    return () => { live = false; };
  }, [slug]);
  if (!data) {
    return (
      <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400" data-waiting-discussion-state="">
        {read ? t('agent:appFrame.waiting.discussion.failed') : t('agent:appFrame.waiting.discussion.loading')}
      </p>
    );
  }
  return <ProjectDiscussion slug={slug} name={name} data={data} />;
}

/**
 * A sheet from the floor over a scrim, as the install steps' sheet draws
 * itself without the kit (../mobile-install/install-steps-sheet.tsx): a
 * title and its ✕, then the body. Back, Escape, the scrim and ✕ close it.
 * `tall` gives the body most of the screen, for the chat.
 */
function WaitSheet({ id, title, tall = false, onClose, children }: {
  id: string;
  title: string;
  tall?: boolean;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('core');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      onCloseRef.current();
      return true;
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (!backed) release();
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={tall
          ? 'flex h-[88dvh] w-full max-w-lg flex-col rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-3 pt-3 pb-[env(safe-area-inset-bottom,0px)]'
          : 'flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]'}
      >
        <div className="mb-3 flex shrink-0 items-center gap-2 px-1">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 truncate text-[17px] font-bold leading-snug text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={t('core:common.close')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100 un-touch-target"
          >
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className={tall ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-y-auto'}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
