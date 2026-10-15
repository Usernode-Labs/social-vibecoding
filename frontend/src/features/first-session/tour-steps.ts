/**
 * The first-session tours' steps: real screens, each card pointing at one
 * place (./index.tsx draws them). One short title and one short sentence per
 * card: the card names the place, the screen behind it says the rest (#4044).
 *
 * Two tours, both on Home, and neither takes anybody anywhere: every card
 * rings its place and leads on with Next.
 *
 *   walk   "1, 2, 3 on Home" (Evan, 15 Oct 2026, the onboarding canvas's
 *          "A tip in the app, then 1, 2, 3 on Home"). A newcomer's first
 *          session hands them their app first, full screen, with one tip
 *          under the Homeroom mark (./app-tip.tsx). The first time Home
 *          shows after that, three cards: their project's tile, Homeroom
 *          bot in Messages, and Communities. A private member (let in by an
 *          invite link before the waitlist let them in) gets a fourth, the
 *          waitlist card that is how they make apps of their own
 *          (homeWalkSteps).
 *   look   "Look around first" (decision E, #4072): four cards on Home,
 *          where to start a project later and what the tab bar's places are
 *          (lookAroundSteps).
 *
 * The walk replaced three longer tours that walked through the app, its
 * Homeroom menu, ✕, the hub and (for an invited person) #general, pressing
 * each control in turn. The tip says what the menu is for, in the app, and
 * the walk says where everything else is, on Home.
 *
 * Every target is the product's own control or region, found by the
 * selectors the rest of the shell already pins (tests/baselines/
 * shell-markup.json, dapp.json): nothing here draws a picture of the product.
 *
 * The words are read from the catalog (frontend/locales/en/onboarding.json)
 * when a tour's steps are built, never at module load, so they are in the
 * language on screen; ./index.tsx builds them again when it changes.
 */

import { t as translate } from '../../lib/i18n/runtime';

export type TourScreen = 'home' | 'app' | 'hub' | 'discussion' | 'bot';

/**
 * What a step that points at the project's app waits for (#4900,
 * ./tour-wait.ts): `running`, its tile on Home, until a tap on it opens it
 * (the tile's status is no longer "Spinning up..."); `open`, the app on its
 * own screen, until it has opened (its "Opening..." cover gone); `hub`, the
 * project's hub, until it is drawn whole (onboarding run two, 12 Oct 2026:
 * the hub's card stood over Home, then a blank page, then skeleton rows,
 * then a first draft of the hub and the hub itself, 2.35s in all, the ring
 * jumping as it redrew).
 */
export type AppWait = 'running' | 'open' | 'hub';

export type TourStep = {
  screen: TourScreen;
  /** Selector(s); several are drawn as one cut-out around all of them. */
  target: string;
  /**
   * Drawn into the same cut-out once the target is on screen: the top bar
   * over a screen (SCREEN_HEADER). It never stands in for the target, so a
   * screen that has not opened still dims whole and opens itself.
   */
  alongside?: string;
  /**
   * Bars the cut-out stops above (BOTTOM_BARS): every screen runs on under
   * the phone's tab bar, so a cut-out of the screen took the bar in with it.
   * Only a bar lying across the cut-out's foot counts; the rail beside the
   * screen from 768px up takes nothing off.
   */
  endsAbove?: string;
  /**
   * A tap step whose cut-out shows more than its control: the control itself,
   * the one press that leads on. It is what is ringed, and the only part of
   * the cut-out a press reaches. Without it, the target is the control.
   */
  press?: string;
  title: string;
  text: string;
  /**
   * A step the reader finishes by pressing its control: the hint shown instead
   * of Next. The hint presses that control too (./index.tsx pressTarget).
   */
  tap?: string;
  /**
   * Where the card goes: under the target or over it (auto), at the foot of
   * the screen, just above or below another element, or clear of a surface
   * whole (`{ clear }`: over it with a gap where a card fits, else under it;
   * ./card-placement.ts clearOf).
   */
  place?: 'auto' | 'bottom' | { above: string } | { below: string } | { clear: string };
  /** Pressing the target lands on a list; open the next step's screen itself (the bot's chat, not the inbox). */
  opensNext?: boolean;
  /**
   * A step that points at one control without asking for the press ("Look
   * around first": Next leads on). The control is ringed as a tap step's is,
   * and covered like the rest of the cut-out, so a press on it does not take
   * the reader out of the tour.
   */
  ringed?: boolean;
  /**
   * A control that draws the target when the screen holds it back, pressed
   * once if the target is not there: Home's "Show all N apps", behind which
   * a full collapsed grid keeps the New project tile (home.js createHidden).
   * The product's own handler draws it, as a finger on it would.
   */
  revealWith?: string;
  /**
   * The card's words say where the app opens ("<project> opens here"), so
   * the App tab's own "It opens here when it's ready." hides while the card
   * is up: the card carries `data-tour-says-where-it-opens`, which that line
   * reads (features/app-frame/app-status.tsx).
   */
  saysWhereItOpens?: boolean;
  /**
   * A step that points at the app itself waits for it to be ready (AppWait),
   * so no card stands over a tile that cannot be opened yet or over the app's
   * loading screen (onboarding run, 12 Oct 2026, #4900). Meanwhile its card
   * says the app is getting ready, with Skip and Back; it waits at most
   * ./tour-wait.ts TOUR_WAIT_MAX_MS, then shows as it always did.
   */
  waitsFor?: AppWait;
  /**
   * A step inside the Homeroom menu (APP_MENU): the tour opens the menu
   * while the step is up, Back to it included, and closes it once the reader
   * moves on, Skip included (./index.tsx). The tour is drawn over the menu
   * then, which on touch is a kit sheet above the tour's usual layer.
   */
  inMenu?: boolean;
  /**
   * The tour's last card. A last tap step ends the tour when its control is
   * pressed, and the press goes on to the control.
   */
  last?: boolean;
};

/**
 * The platform's top bar, drawn with the screen under it (TourStep.alongside).
 * Its top padding is the status bar's inset, so its box starts at the top of
 * the screen inside the iOS app's WebView too.
 */
export const SCREEN_HEADER = '#platform-header';

/**
 * What sits along the foot of a platform screen: the tab bar, and the app you
 * left (the Resume strip) on top of it. "The whole screen, minus the tab
 * bar" stops above both (TourStep.endsAbove).
 */
export const BOTTOM_BARS = '#platform-parked, #platform-tabs';

/** The menu the Homeroom mark opens (../app-context/app-context-sheet.tsx). */
export const APP_MENU = '#apps-switcher-sheet';

/**
 * Where a project's first version stands, as its App tab shows it
 * (GET /api/apps/:slug `first_version`; public/js/app-view.js
 * _firstVersionView): Homeroom bot still building it, built and waiting for
 * approval, or neither (null: the app is what there is). The made screen
 * hands it on (./made.tsx madeStage): an app that is not live yet is not
 * opened for its maker, who goes to Home and its walk instead.
 */
export type FirstVersionStage = 'building' | 'ready' | null;

/** The project's tile in Home's own grid (#app-list), never a card of the same app elsewhere on Home. */
export function tileOf(slug: string): string {
  return `#app-list .app-card[data-slug="${slug}"]`;
}

/** The project a walk is about, and whether its reader is a private member (the waitlist card). */
export type HomeWalkProject = { slug: string; privateMember?: boolean };

/**
 * The walk on Home (see the header): three cards, or four for a private
 * member, each ringing its place, with Next and Done on the last. Nothing is
 * pressed: the tile is pointed at, not opened. Its card is the one place
 * the walk says what Home is, so it names no project ("Your apps live here,
 * on Home."): the tile beside it does.
 */
export function homeWalkSteps({ slug, privateMember = false }: HomeWalkProject): TourStep[] {
  const steps: TourStep[] = [
    {
      screen: 'home',
      // Home's own grid only: the Discover rail's cards are `.app-card`s
      // with a slug too (onboarding run three, 12 Oct 2026).
      target: tileOf(slug),
      ringed: true,
      title: translate('onboarding:firstSession.walk.home.title'),
      text: translate('onboarding:firstSession.walk.home.text'),
    },
    {
      // The tab bar's own tabs, the same elements on a phone's bar and on
      // the rail from 768px up (features/nav/tab-bar.tsx).
      screen: 'home',
      target: '#platform-tab-messages',
      ringed: true,
      title: translate('onboarding:firstSession.walk.bot.title'),
      text: translate('onboarding:firstSession.walk.bot.text'),
    },
    {
      // Its key is still `workshop`.
      screen: 'home',
      target: '#platform-tab-workshop',
      ringed: true,
      title: translate('onboarding:firstSession.walk.communities.title'),
      text: translate('onboarding:firstSession.walk.communities.text'),
    },
  ];
  if (privateMember) {
    // The card's own heading says what it is for; this card says what to
    // do with it (../home/waitlist-card.tsx).
    steps.push({
      screen: 'home',
      target: '#home-waitlist-card',
      ringed: true,
      title: translate('onboarding:firstSession.walk.waitlist.title'),
      text: translate('onboarding:firstSession.walk.waitlist.text'),
    });
  }
  steps[steps.length - 1] = { ...steps[steps.length - 1], last: true };
  return steps;
}

/**
 * "Look around first" (decision E, #4072): it used to land on Home with
 * nothing explained. Four cards on Home, each pointing at one place and
 * leading on with Next, so nobody is taken anywhere: New project, where a
 * community and its app start whenever they want one, then the tab bar's
 * Discover, Communities and Messages.
 */
export function lookAroundSteps(): TourStep[] {
  return [
    {
      screen: 'home',
      target: '#home-create-tile',
      revealWith: '#home-apps-more-btn',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.make.title'),
      text: translate('onboarding:firstSession.tour.look.make.text'),
    },
    {
      screen: 'home',
      target: '#platform-tab-discover',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.discover.title'),
      text: translate('onboarding:firstSession.tour.look.discover.text'),
    },
    {
      screen: 'home',
      target: '#platform-tab-workshop',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.communities.title'),
      text: translate('onboarding:firstSession.tour.look.communities.text'),
    },
    {
      screen: 'home',
      target: '#platform-tab-messages',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.bot.title'),
      text: translate('onboarding:firstSession.tour.look.bot.text'),
      last: true,
    },
  ];
}
