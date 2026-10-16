/**
 * The two controls a RUNNING APP's header carries besides the bell and the
 * mark (#3702): "N to vote" and Suggest.
 *
 * ── Why here and not in the menu ───────────────────────────────────────
 *
 * Both were reachable before, and only from the Homeroom mark's menu: the
 * menu's "Go to community hub" row carries the vote count
 * (../app-context/app-context-sheet.tsx) and its blue button is Suggest
 * (../improve/actions.tsx). But the running app is where a person notices
 * what they would change and when a vote is freshest — the thing on screen is
 * the thing the votes are about — so each takes one tap from the bar rather
 * than two through a menu. The menu's own rows are unchanged.
 *
 * ── The count is the Communities tab's ─────────────────────────────────
 *
 * `communityScopeStore.info[slug].needs` is votes owed less the ones swiped
 * past (#3526), kept live by ./needs-seen — the same number the tab's badge
 * and the menu row show, from the one load the store already keeps. Nothing
 * here opens a second endpoint. An UNCHOSEN community's votes are left out,
 * exactly as `tabVotes` leaves them off the tab (5 Oct 2026): the platform's
 * own community does not summon anybody who has not taken part there yet.
 *
 * Loading runs when the app comes ON SCREEN, in an effect keyed to that —
 * never during render, which is the hydration rule every island here follows.
 * Failure is silence: a count the store does not have is no pill, and a
 * refused request leaves the header exactly as it was before this existed.
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

import { PencilSquareIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { navStore } from '../nav/nav-store.js';
import { offeringGoToHomeroom } from '../app-context/about-data';
import { communityScopeStore, loadCommunities } from '../workshop/community-scope';
import { hydrateNeedsSeen } from '../workshop/needs-seen';
import { openPlace } from '../dev-board/workshop/place-store';
import { placeHref } from '../dev-board/workshop/places';

/**
 * A small filled pill in the accent the platform gives a number that asks
 * something of you — the same blue the menu's Suggest button is filled with
 * — and the header's 28px height, so the bar does not grow.
 */
const TO_VOTE_CLASS = 'shrink-0 inline-flex items-center h-7 px-2.5 rounded-full '
  + 'bg-violet-600 hover:bg-violet-500 text-white text-[0.8125rem] font-semibold '
  + 'whitespace-nowrap un-touch-target';

/**
 * The back button's own frame — the tinted round disc, the header's ink —
 * narrowed on a phone (`px-1.5` and the word `hidden sm:inline`) so the
 * app's name keeps some room.
 */
const SUGGEST_CLASS = 'shrink-0 inline-flex items-center justify-center gap-1.5 h-7 '
  + 'min-w-7 px-1.5 sm:px-2.5 rounded-full border border-[color:var(--brand-line)] '
  + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] '
  + 'text-[0.8125rem] font-semibold un-touch-target';

/** Whether the running-app controls have somewhere to stand right now. */
function useInAppShown(): boolean {
  const { target, slug, tab, selfHosted } = useStoreState(improveStore);
  return target === 'app' && tab === 'app' && !!slug && !selfHosted;
}

export function InAppActions(): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const shown = useInAppShown();
  const { slug } = useStoreState(improveStore);

  // Each time the app comes back on screen, read what this community owes
  // — first what was already passed over (#3526), then the fresh counts.
  useEffect(() => {
    if (!shown) return;
    hydrateNeedsSeen();
    void loadCommunities(true);
  }, [shown, slug]);

  if (!mounted) return null;
  return <InAppControls />;
}

/**
 * The two controls themselves, drawn for the current store state. Everything
 * here is post-mount, so a store value arriving late simply changes a
 * subtree React already owns.
 */
export function InAppControls(): ReactNode {
  const t = useMessages();
  const shown = useInAppShown();
  const { slug, restricted } = useStoreState(improveStore);
  const { privateMember } = useStoreState(navStore);
  const scope = useStoreState(communityScopeStore);

  if (!shown || !slug) return null;
  // Hidden whenever the menu's community hub row is: for a viewer the
  // platform hides it from, and for a newcomer still being offered
  // "Go to Homeroom" (one way onward, ../app-context/about-data.ts).
  const pillAllowed = !(restricted || offeringGoToHomeroom(!!privateMember));
  const info = scope.info[slug];
  // The same rule `tabVotes` applies for one community: an unchosen
  // community's votes stay off the badge.
  const n = info && !info.unchosen ? Number(info.needs) || 0 : 0;

  return (
    <>
      {/*
          SUGGEST, FIRST IN THE GROUP so the order reads Suggest · to vote ·
          bell · mark: the two doors that are ABOUT this app, then the
          platform's. Drawn like the back button, per the header's own
          controls; on a phone the word goes and the pencil stands alone.
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
      {/*
          "N to vote", the menu row's words. An ANCHOR, not a button, so a
          modified click and a new tab still open the Needs you feed; a plain
          click goes through openPlace, which moves the page in place where it
          is mounted and otherwise opens its address — on a phone the app
          stays parked, on a wide window the side panel takes the hash. Zero
          owed, or all of them already swiped past: nothing at all.
      */}
      {pillAllowed && n > 0 ? (
        <a
          id="header-in-app-to-vote"
          href={placeHref(slug, 'needs')}
          title={t('core:header.inApp.toVote', { count: n })}
          aria-label={t('core:header.inApp.toVote', { count: n })}
          className={TO_VOTE_CLASS}
          onClick={(event) => {
            // A modified click opens the href in a tab; a plain click moves
            // the page. The tap is recorded as reaching the project page by a
            // nudge, the same way a notification tap is
            // (../notifications/notifications.js).
            if ((window as unknown as { NavLink?: { isNativeClick?(e: unknown): boolean } }).NavLink?.isNativeClick?.(event)) return;
            event.preventDefault();
            try { (window as unknown as { UITelemetry?: { markNextVia?(v: string): void } }).UITelemetry?.markNextVia?.('nudged'); } catch { /* best effort */ }
            openPlace(slug, 'needs');
          }}
        >
          {t('core:header.inApp.toVote', { count: n })}
        </a>
      ) : null}
    </>
  );
}
