/**
 * The controls a RUNNING APP's header carries besides the bell and the mark:
 * Community, the way to the app's community, and Suggest (#3702).
 *
 * ── Community: the app's other half, one tap away ──────────────────────
 *
 * Home keeps ONE tile for an app and its community (the one Pinned grid),
 * and a tap on it opens the app, as an app's icon does everywhere. That
 * leaves the community with no door on Home, so its door is here, on the app
 * itself, for as long as the app is open: a people button that opens the
 * community's hub (Home.openHub, the door rule), which has had Open app as
 * the way back all along. It is Wikipedia's Talk beside Article: no question
 * at the link, and the second place always in view where the time is spent.
 *
 * On a phone it is the glyph alone in the header's round disc, so the app
 * keeps its whole screen and its name most of the bar; from `sm` it says
 * "Community". It is drawn on the App tab only: on the project's own page
 * you are already there.
 *
 * It wears the votes the community waits on you for, which #5419 took off
 * this bar as a pill of its own ("N to vote"): there the count was a second
 * control asking for a vote; here it is a small number on the one button
 * that goes where the votes are, and a zero says nothing. The number is the
 * community scope's own (../workshop/community-scope `votesWaiting`), which
 * the shell already keeps, so nothing is fetched for it.
 *
 * ── Why here and not in the menu ───────────────────────────────────────
 *
 * Suggest was reachable before, and only from the Homeroom mark's menu: its
 * blue button is Suggest (../improve/actions.tsx). But the running app is
 * where a person notices what they would change — the thing on screen is the
 * thing the suggestion is about — so it takes one tap from the bar rather
 * than two through a menu. The menu's own rows are unchanged.
 *
 * On a phone the bar was too crowded with the old pair of controls (#5367),
 * so Suggest is hidden below `sm` and reached there through the mark's menu;
 * it keeps its place in the header on wider windows.
 *
 * The header's "N to vote" pill was removed in #5419: most of the bar
 * belongs to the app, and a count asking for a vote pulled attention away
 * from it. The count still shows on the mark's menu's "Go to community hub"
 * row (../app-context/app-context-sheet.tsx) and in the Communities tab's
 * Needs you feed, which load their own counts, and the loading this component
 * used to do existed only to feed the pill, so it went with it.
 *
 * ── Post-mount only, like the sheet's own conditional rows ─────────────
 *
 * The component ships NOTHING in the prerendered document — no id, no
 * element — and renders null on the hydrating render too (`mounted`), so the
 * two agree whatever the stores say by then (a deep link into an app has
 * app.js publish the target before this bundle hydrates). `InAppControls` is
 * what those gates resolve TO, exported so the render pass can be exercised
 * against real store state without an effect to click through.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { PencilSquareIcon, UserGroupIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { communityScopeStore, votesWaiting } from '../workshop/community-scope';

/**
 * The back button's own frame — the tinted round disc, the header's ink —
 * narrowed on a phone (`px-1.5` and the word `hidden sm:inline`) so the
 * app's name keeps some room.
 */
const SUGGEST_CLASS = 'shrink-0 hidden sm:inline-flex items-center justify-center gap-1.5 h-7 '
  + 'min-w-7 px-1.5 sm:px-2.5 rounded-full border border-[color:var(--brand-line)] '
  + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] '
  + 'text-[0.8125rem] font-semibold un-touch-target';

/**
 * Community's frame: the same tinted disc. A bare round disc on a phone,
 * where its word is hidden; a pill with the word from `sm`.
 */
const COMMUNITY_CLASS = 'relative shrink-0 inline-flex items-center justify-center gap-1.5 h-7 '
  + 'min-w-7 px-0 sm:px-2.5 rounded-full border border-[color:var(--brand-line)] '
  + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] '
  + 'text-[0.8125rem] font-semibold no-underline un-touch-target';
/** The votes waiting: on the disc's corner on a phone, inside the pill from `sm`. */
const COMMUNITY_COUNT = 'flex items-center justify-center rounded-full bg-violet-600 text-white '
  + 'font-extrabold tabular-nums';
const COMMUNITY_COUNT_CORNER = `${COMMUNITY_COUNT} sm:hidden absolute -top-1.5 -end-1.5 min-w-[17px] h-[17px] `
  + 'px-1 text-[10.5px] ring-2 ring-zinc-200 dark:ring-zinc-900';
const COMMUNITY_COUNT_INLINE = `${COMMUNITY_COUNT} hidden sm:flex min-w-[18px] h-[18px] px-1.5 text-[11px]`;

/**
 * Whether the controls have somewhere to stand right now: a project's app,
 * AND its page (Hub, Needs you, the Workshop, a channel, a request). The
 * page used to draw no Suggest, so the same project's bar had it on its App
 * tab and lost it on every other (audit P01, 1 Nov 2026); "Suggest" is about
 * the project either way, and the form opens on it from both
 * (Improve.giveFeedback, App.currentApp is the project's).
 */
function useInAppShown(): boolean {
  const { target, slug, tab, selfHosted } = useStoreState(improveStore);
  return target === 'app' && (tab === 'app' || tab === 'dev') && !!slug && !selfHosted;
}

export function InAppActions(): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return <InAppControls />;
}

/**
 * The control itself, drawn for the current store state. Everything here is
 * post-mount, so a store value arriving late simply changes a subtree React
 * already owns.
 */
export function InAppControls(): ReactNode {
  const t = useMessages();
  const shown = useInAppShown();
  const { slug, tab } = useStoreState(improveStore);
  const scope = useStoreState(communityScopeStore) as { info?: Record<string, { needs?: number; unchosen?: boolean }> };

  if (!shown || !slug) return null;

  const votes = votesWaiting(scope.info?.[slug]);
  const said = votes > 99 ? '99+' : String(votes);

  return (
    <>
      {/*
          Community: on the App tab only. A link, so a modified click opens
          the hub in a new tab; a plain one goes through Home.openHub, which
          names the hub as the place to land on (the door rule).
      */}
      {tab === 'app' ? (
        <a
          id="header-in-app-community"
          href={`#app/${encodeURIComponent(slug)}/dev/hub`}
          className={COMMUNITY_CLASS}
          data-votes={votes > 0 ? String(votes) : undefined}
          aria-label={votes > 0
            ? t('core:header.inApp.communityVotes', { count: votes })
            : t('core:header.inApp.communityLabel')}
          title={t('core:header.inApp.communityLabel')}
          onClick={(event) => {
            const win = window as any;
            if (win.NavLink?.isNativeClick?.(event)) return;
            if (typeof win.Home?.openHub !== 'function') return;
            event.preventDefault();
            win.Home.openHub(slug);
          }}
        >
          <UserGroupIcon className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('core:header.inApp.community')}</span>
          {votes > 0 ? (
            <>
              <span className={COMMUNITY_COUNT_CORNER} aria-hidden="true">{said}</span>
              <span className={COMMUNITY_COUNT_INLINE} aria-hidden="true">{said}</span>
            </>
          ) : null}
        </a>
      ) : null}
      {/*
          Drawn like the back button, per the header's own controls; on a
          phone the word goes and the pencil stands alone.
      */}
      <button
        id="header-in-app-suggest"
        type="button"
        className={SUGGEST_CLASS}
        aria-label={t('core:header.inApp.suggestLabel')}
        onClick={() => Improve.giveFeedback({ target: 'app' })}
      >
        <PencilSquareIcon className="w-4 h-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t('core:header.inApp.suggest')}</span>
      </button>
    </>
  );
}