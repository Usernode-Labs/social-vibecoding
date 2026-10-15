/**
 * The first-session tours' steps: real screens, one screen whole and then the
 * tap that leads on (./index.tsx draws them). One short title and one short
 * sentence per card: the card names the place, the screen behind it says the
 * rest (#4044, the tour script on the onboarding canvas).
 *
 * Three tours. Starting a community and joining one share their first seven
 * cards, word for word: the project on Home, the project opened, Suggest an
 * improvement in its Homeroom menu, ✕ back to Home, where to find it under
 * Communities, and its hub. The maker's meets Homeroom bot on the way and
 * ends on that hub by opening the app (makerSteps); the invited one ends in
 * Discussion. "Look around first"
 * has its own four cards on Home (decision E, #4072): where to start a
 * project later, and what the tab bar's places are. A private member, let in
 * by an invite link before the waitlist let them in, gets the maker's walk
 * through the project, three cards reworded for someone invited, then
 * Homeroom bot and the waitlist, the first time they reach Home (#4080,
 * #4398, privateSteps).
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
   * pressed, and the press goes on to the control (the maker's Open app).
   */
  last?: boolean;
  /**
   * N1 (newcomer run four, 13 Oct 2026): the card draws the first look at
   * the project's first version, the picture of its main screen Homeroom
   * bot drew from the maker's answers, under its words; "Drawing your
   * screens…" until it is there, swapped in when it arrives
   * (./first-look.tsx). It asks for no press: Done ends the tour.
   */
  firstLook?: boolean;
};

/**
 * The platform's top bar, drawn with the screen under it (TourStep.alongside).
 * Its top padding is the status bar's inset, so its box starts at the top of
 * the screen inside the iOS app's WebView too. The steps that show a screen
 * whole cut it out with that screen: "include the header", on the app's
 * close step and the hub (Evan, on his phone, 5 October 2026).
 */
export const SCREEN_HEADER = '#platform-header';

/**
 * What sits along the foot of a platform screen: the tab bar, and the app you
 * left (the Resume strip) on top of it. "The whole screen, minus the tab
 * bar" stops above both (TourStep.endsAbove).
 */
export const BOTTOM_BARS = '#platform-parked, #platform-tabs';

/**
 * The hub's Open app (../dev-board/workshop/community-card.tsx), where the
 * maker's tour ends (makerSteps).
 */
export const OPEN_APP = '[data-ws-community-open-app]';

/**
 * The app screen's Suggest steps, the same on the invited and maker paths
 * (request #4225, reordered by #4390): the Homeroom mark at the top of the
 * app, which the reader taps, then the real menu it opens with its "Suggest
 * an improvement" button pointed at but not pressed, so no suggestion
 * starts.
 *
 * Newcomer run six (14 Oct 2026, iPhone 17 Safari): the menu's card stood
 * over the top of the menu's sheet, its grabber, its rounded corners and
 * the app's name a clipped sliver under the card. The card now stands
 * clear of the whole menu, over it with a gap (`place: { clear }`), and
 * says one short sentence: "Homeroom bot starts building it for you."
 */
export const MENU_TEXT = 'onboarding:firstSession.tour.menu.text';
export const SUGGEST_TEXT = 'onboarding:firstSession.tour.suggest.text';

/** The menu the Homeroom mark opens (../app-context/app-context-sheet.tsx). */
export const APP_MENU = '#apps-switcher-sheet';

function suggestSteps(): TourStep[] {
  return [
    {
      screen: 'app',
      target: '#platform-mark-btn',
      title: translate('onboarding:firstSession.tour.menu.title'),
      text: translate(MENU_TEXT),
      tap: translate('onboarding:firstSession.tour.menu.tap'),
    },
    {
      screen: 'app',
      target: '#improve-row-feedback',
      inMenu: true,
      ringed: true,
      place: { clear: APP_MENU },
      title: translate('onboarding:firstSession.tour.suggest.title'),
      text: translate(SUGGEST_TEXT),
    },
  ];
}

/**
 * Where a project's first version stands, as its App tab shows it
 * (GET /api/apps/:slug `first_version`; public/js/app-view.js
 * _firstVersionView): Homeroom bot still building it, built and waiting for
 * approval, or neither (null: the app is what there is). "You're in" reads it
 * (./index.tsx firstVersionStage); the cards no longer do, since the screen
 * behind the app's card says it (#4043, #4053).
 */
export type FirstVersionStage = 'building' | 'ready' | null;

export type TourProject = {
  slug: string;
  name: string;
  conversationId?: number | null;
  /**
   * Where its first version stands as the tour starts (FirstVersionStage):
   * one Homeroom bot is still building is said as one that will open, and
   * the maker's tour ends on its first look rather than on Open app, which
   * the hub does not show before it is live.
   */
  firstVersion?: FirstVersionStage;
};

/**
 * The project's hub, named without a possessive: "Page Turners's hub" was
 * what a name ending in s read as (first-session run-through, 5 October 2026).
 */
export function hubTitle(name: string): string {
  return translate('onboarding:firstSession.tour.hub.title', { community: name });
}

/**
 * The cards both paths open with, word for word (the tour script on the
 * onboarding canvas): the project on Home; the project opened, the app
 * screen whole with its top bar; Suggest an improvement (#4225, #4390), the
 * Homeroom mark tapped and the menu it opens; ✕, ringed alone, back to Home
 * (#4044: "focus the step on the ✕"); the Communities tab, naming the
 * project instead of "its hub and its group chat"; and the hub, by what is
 * on it (#4045). The Communities tab is ONE element, the phone's bottom bar
 * below 768px and the rail above it (features/nav/tab-bar.tsx; its key is
 * still `workshop`). The first two point at the app, and wait for it
 * (`waitsFor`): its tile until it can be opened, the app until it has. The
 * hub's waits for the hub to be drawn whole.
 */
/** The project's tile in Home's own grid (#app-list), never a card of the same app elsewhere on Home. */
export function tileOf(slug: string): string {
  return `#app-list .app-card[data-slug="${slug}"]`;
}

function sharedSteps(slug: string, name: string, firstVersion: FirstVersionStage = null): TourStep[] {
  // N8: a first version Homeroom bot is still building is not there to open:
  // its App tab shows it being made, so the card says it will open here.
  const building = firstVersion === 'building';
  return [
    {
      screen: 'home',
      // Home's own grid only: the Discover rail's cards are `.app-card`s
      // with a slug too (onboarding run three, 12 Oct 2026: the cut-out
      // glided off the tile and back as Home drew).
      target: tileOf(slug),
      waitsFor: 'running',
      title: translate('onboarding:firstSession.tour.onHome.title', { app: name }),
      text: translate('onboarding:firstSession.tour.onHome.text'),
      tap: translate('onboarding:firstSession.tour.onHome.tap'),
    },
    {
      // `#app-view` holds both halves of the screen, the build's progress
      // (#app-content) and the running app (#app-frame-host), and the top
      // bar over it is drawn in too.
      screen: 'app',
      target: '#app-view',
      alongside: SCREEN_HEADER,
      waitsFor: 'open',
      title: building
        ? translate('onboarding:firstSession.tour.opensBuilding.title', { app: name })
        : translate('onboarding:firstSession.tour.opens.title', { app: name }),
      text: building
        ? translate('onboarding:firstSession.tour.opensBuilding.text')
        : translate('onboarding:firstSession.tour.opens.text'),
      saysWhereItOpens: true,
      place: 'bottom',
    },
    ...suggestSteps(),
    {
      screen: 'app',
      target: '#back-btn',
      title: translate('onboarding:firstSession.tour.back.title'),
      text: translate('onboarding:firstSession.tour.back.text', { app: name }),
      tap: translate('onboarding:firstSession.tour.back.tap'),
    },
    {
      screen: 'home',
      target: '#platform-tab-workshop',
      title: translate('onboarding:firstSession.tour.communities.title', { community: name }),
      text: translate('onboarding:firstSession.tour.communities.text'),
      tap: translate('onboarding:firstSession.tour.communities.tap'),
    },
    {
      // The hub whole: its top bar over it, down to the tab bar. Its card
      // waits for the hub to be drawn whole (`hub`).
      screen: 'hub',
      target: '#app-content',
      alongside: SCREEN_HEADER,
      endsAbove: BOTTOM_BARS,
      waitsFor: 'hub',
      title: hubTitle(name),
      text: translate('onboarding:firstSession.tour.hub.text'),
      place: 'bottom',
    },
  ];
}

/** Joining a community: nine steps, ending in its Discussion, where the people already are. */
export function invitedSteps({ slug, name, firstVersion = null }: TourProject): TourStep[] {
  return [
    ...sharedSteps(slug, name, firstVersion),
    {
      // #4417: #general's row in the places list beside the page (a wide
      // window), or on a phone the place bar's button, which opens the list
      // in its tray: whichever of the two is on screen is ringed. The press
      // that opens the tray does not open #general itself, so the tour does.
      screen: 'hub',
      target: '[data-places] [data-place="discussion"], [data-places-btn]',
      title: translate('onboarding:firstSession.tour.general.title'),
      text: translate('onboarding:firstSession.tour.general.text', { community: name }),
      tap: translate('onboarding:firstSession.tour.general.tap'),
      opensNext: true,
    },
    {
      screen: 'discussion',
      target: '#gc-messages, #gc-form',
      title: translate('onboarding:firstSession.tour.sayHi.title'),
      text: translate('onboarding:firstSession.tour.sayHi.text'),
      place: { above: '#gc-form' },
      last: true,
    },
  ];
}

/**
 * A PRIVATE MEMBER's tour (users.private_member_since): an invite link let
 * them into a community's app before they were let in, and they reach the
 * rest of Homeroom only through the mark menu's "Go to Homeroom" (#4080).
 * The first time they do, nine cards (request #4398): the maker's walk
 * through the project (sharedSteps), with three cards reworded for someone
 * who was invited rather than someone who made it (the app opened, Suggest
 * an improvement in its menu, and the hub), then Homeroom bot and the
 * waitlist card that is how they make apps of their own. The ✕ step has its
 * control because goHome notes the Home visit before the tour starts
 * (App._privateNoClose turns false), so the app has its ✕ again.
 */
export function privateSteps({ slug, name }: TourProject): TourStep[] {
  const [home, app, menu, suggest, close, communities, hub] = sharedSteps(slug, name);
  return [
    home,
    { ...app, text: translate('onboarding:firstSession.tour.private.opens.text') },
    menu,
    { ...suggest, text: translate('onboarding:firstSession.tour.private.suggest.text', { app: name }) },
    close,
    communities,
    { ...hub, text: translate('onboarding:firstSession.tour.private.hub.text') },
    {
      screen: 'hub',
      target: '#platform-tab-messages',
      ringed: true,
      // What the bot is for, then where it is (#4397); the maker's and "Look
      // around first" tours keep their own card.
      title: translate('onboarding:firstSession.tour.private.bot.title'),
      text: translate('onboarding:firstSession.tour.private.bot.text', { app: name }),
    },
    {
      // The card's own heading says what it is for ("Make and share your
      // own apps"); this card says where, and what the card does.
      screen: 'home',
      target: '#home-waitlist-card',
      ringed: true,
      title: translate('onboarding:firstSession.tour.private.waitlist.title'),
      text: translate('onboarding:firstSession.tour.private.waitlist.text'),
      last: true,
    },
  ];
}

/**
 * Starting a community, after "Invite people later" or "Start the tour": the
 * same first seven cards, with one more before the Communities tab, "Meet
 * Homeroom bot", which says what it is for and where it always is (Evan, 10
 * Oct 2026: a ready-made tier list's tour ended without it). The tour ends on
 * the hub, its last card asking them to tap Open app, which opens their new
 * app and ends the tour: "that's probably where they want to go anyway"
 * (Evan, 10 Oct 2026). The app runs by then (the made screen waits for it,
 * and the steps on the app wait too); one Homeroom bot is building opens on
 * its build, which takes the maker to the bot's chat when a plan or a
 * question waits for them (AppView._firstVersionView). That chat used to be
 * the tour's last two cards, Messages and then the plan, for a project the
 * bot builds.
 *
 * N1 (newcomer run four, 13 Oct 2026): a project whose first version
 * Homeroom bot is still making has no Open app on its hub until that version
 * is live, and the card that asked for it waited on a control that was not
 * there. Its tour ends on one more card instead: the first look at what is
 * being made, with Done (firstLookStep).
 */
export function makerSteps({ slug, name, firstVersion = null }: TourProject): TourStep[] {
  const steps = sharedSteps(slug, name, firstVersion);
  const communities = steps.findIndex((step) => step.target === '#platform-tab-workshop');
  steps.splice(communities, 0, {
    screen: 'home',
    target: '#platform-tab-messages',
    ringed: true,
    title: translate('onboarding:firstSession.tour.maker.meetBot.title'),
    text: translate('onboarding:firstSession.tour.maker.meetBot.text', { app: name }),
  });
  const hub = steps[steps.length - 1];
  // N1: a first version that is not live yet has no Open app on its hub
  // (community-card.tsx shows the first version's card instead), so the
  // tour ends on its first look, which Done closes: no card asks for a
  // press on a control that is not there.
  if (firstVersion) return [...steps, firstLookStep()];
  steps[steps.length - 1] = {
    ...hub,
    press: OPEN_APP,
    text: translate('onboarding:firstSession.tour.maker.hub.text', { app: name }),
    tap: translate('onboarding:firstSession.tour.maker.hub.tap'),
    last: true,
  };
  return steps;
}

/**
 * N1: the maker's last card while Homeroom bot builds their first version:
 * "Here's what Homeroom bot is making", over the hub, with the first look
 * drawn in the card (TourStep.firstLook) and Done.
 */
export function firstLookStep(): TourStep {
  return {
    screen: 'hub',
    target: '#app-content',
    alongside: SCREEN_HEADER,
    endsAbove: BOTTOM_BARS,
    title: translate('onboarding:firstSession.tour.firstLook.title'),
    text: translate('onboarding:firstSession.tour.firstLook.text'),
    place: 'bottom',
    firstLook: true,
    last: true,
  };
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
