import { t as tr } from "../../lib/i18n/runtime";
/**
 * The first-session tour's steps: real screens, one screen whole and then the
 * tap that leads on (./index.tsx draws them).
 *
 * The invited path walks what joining gave them: the project on Home, opened
 * and closed, its hub under Communities, and its Discussion, where it ends.
 * Every target is the product's own control or region, found by the
 * selectors the rest of the shell already pins (tests/baselines/
 * shell-markup.json, dapp.json): nothing here draws a picture of the product.
 */

export type TourScreen = 'home' | 'app' | 'hub' | 'discussion' | 'bot';

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
  /** Where the card goes: under the target or over it (auto), at the foot of the screen, or just above another element. */
  place?: 'auto' | 'bottom' | { above: string };
  /** Pressing the target lands on a list; open the next step's screen itself (the bot's chat, not the inbox). */
  opensNext?: boolean;
  /**
   * A transcript in the cut-out: the newest of its `rows` is shown from its
   * top edge (./index.tsx showNewestFromTop). Pinned to its newest line, a
   * card taller than the transcript began part-way down, with no first line.
   */
  newestFromTop?: { scroller: string; rows: string };
  last?: boolean;
};

/**
 * The maker's last step: their chat with Homeroom bot, its header (the bot's
 * name and what it is doing for them) with its messages under it, as one
 * cut-out. It used to be the messages alone, under a dimmed header, and its
 * newest card began part-way down: "the chat with Homeroom bot is missing the
 * header" (Evan, on his phone, 5 October 2026). The conversation's own
 * section scopes both, so no other pane's header or transcript is measured.
 * The platform's top bar above them is drawn in too (SCREEN_HEADER).
 */
export const BOT_CHAT_HEADER = '.messages-thread-direct > .messages-thread-header';
export const BOT_CHAT_MESSAGES = '.messages-thread-direct > .messages-thread-scroll';

/**
 * The platform's top bar, drawn with the screen under it (TourStep.alongside).
 * Its top padding is the status bar's inset, so its box starts at the top of
 * the screen inside the iOS app's WebView too. The steps that show a screen
 * whole cut it out with that screen: "include the header", on the app's
 * close step, the hub and the chat with Homeroom bot (Evan, on his phone,
 * 5 October 2026).
 */
export const SCREEN_HEADER = '#platform-header';

/**
 * What sits along the foot of a platform screen: the tab bar, and the app you
 * left (the Resume strip) on top of it. "The whole screen, minus the tab
 * bar" stops above both (TourStep.endsAbove).
 */
export const BOTTOM_BARS = '#platform-parked, #platform-tabs';

/**
 * The app screen's close step, the same on both paths: the app screen whole,
 * its top bar included, with ✕ ringed in it. It used to cut out ✕ alone and
 * dim the app it closes. `#app-view` holds both halves of the screen, the
 * build's progress (#app-content) and the running app (#app-frame-host).
 */
function closeAppStep(): TourStep {
  return {
    screen: 'app',
    target: '#app-view',
    alongside: SCREEN_HEADER,
    press: '#back-btn',
    get title() { return tr("auth:close_it_with_6799d998"); },
    get text() { return tr("auth:the_app_opens_full_screen_takes_you_back_to_home_8cf88983"); },
    tap: 'Tap ✕',
    place: 'bottom',
  };
}

/**
 * Where the project's first version stands, as its App tab shows it
 * (GET /api/apps/:slug `first_version`; public/js/app-view.js
 * _firstVersionView): Homeroom bot still building it, built and waiting for
 * approval, or neither (null: the app is what there is).
 */
export type FirstVersionStage = 'building' | 'ready' | null;

export type TourProject = {
  slug: string;
  name: string;
  conversationId?: number | null;
  firstVersion?: FirstVersionStage;
};

/**
 * The project's hub, named without a possessive: "Page Turners's hub" was
 * what a name ending in s read as (first-session run-through, 5 October 2026).
 */
export function hubTitle(name: string): string {
  return tr("auth:the_value1_hub_6e2a9b13", { value1: name });
}

/**
 * The invited path's second step, over the App tab: what the page behind it
 * says. A project still being built reads "<name> is being built …" there,
 * so the step does not call it an app to use any time.
 */
export function appStep(name: string, firstVersion: FirstVersionStage = null): Pick<TourStep, 'title' | 'text'> {
  if (firstVersion === 'building') {
    return {
      title: tr("auth:value1_being_built_4a7c1d90", { value1: name }),
      text: tr("auth:homeroom_bot_is_building_its_first_version_unti_2d8e5f41"),
    };
  }
  if (firstVersion === 'ready') {
    return {
      title: tr("auth:this_is_value1_9285731a", { value1: name }),
      text: tr("auth:its_first_version_is_ready_to_try_and_goes_live_9b3f7a26"),
    };
  }
  return { title: tr("auth:this_is_value1_9285731a", { value1: name }), text: tr("auth:the_group_s_app_made_on_homeroom_use_it_any_time_bd51fd5e") };
}

/** The invited path: seven steps, ending in the group's chat. */
export function invitedSteps({ slug, name, firstVersion = null }: TourProject): TourStep[] {
  return [
    {
      screen: 'home',
      target: `.app-card[data-slug="${slug}"]`,
      get title() { return tr("auth:value1_is_on_your_home_310b3349", { value1: name }); },
      get text() { return tr("auth:open_it_any_time_from_here_7600459f"); },
      get tap() { return tr("auth:tap_it_to_open_it_2e386cca"); },
    },
    {
      screen: 'app',
      target: '#app-content',
      get title() { return appStep(name, firstVersion).title; },
      get text() { return appStep(name, firstVersion).text; },
      place: 'bottom',
    },
    closeAppStep(),
    {
      screen: 'home',
      // The Communities tab: ONE element, the phone's bottom bar below
      // 768px and the rail above it (features/nav/tab-bar.tsx; its key is
      // still `workshop`). A ring drawn anywhere else is the previous step's
      // cut-out, which ./index.tsx no longer carries into this one.
      target: '#platform-tab-workshop',
      get title() { return tr("auth:the_group_lives_in_communities_8966d327"); },
      get text() { return tr("auth:its_hub_and_its_group_chat_are_there_7bb8dda1"); },
      get tap() { return tr("auth:tap_communities_81a76bc4"); },
    },
    {
      screen: 'hub',
      // The hub whole: its top bar over it, down to the tab bar.
      target: '#app-content',
      alongside: SCREEN_HEADER,
      endsAbove: BOTTOM_BARS,
      get title() { return hubTitle(name); },
      get text() { return tr("auth:communities_opens_on_the_group_you_just_joined_w_9fcd40cd"); },
      place: 'bottom',
    },
    {
      screen: 'hub',
      target: '[data-ws-tab-btn="discussion"]',
      get title() { return tr("auth:discussion_is_the_group_chat_c130bcfa"); },
      get text() { return tr("auth:everyone_in_value1_talks_here_11db3a43", { value1: name }); },
      get tap() { return tr("auth:tap_discussion_9787fc6c"); },
      place: 'bottom',
    },
    {
      screen: 'discussion',
      target: '#gc-messages, #gc-form',
      get title() { return tr("auth:the_group_chat_5ffd1fdf"); },
      // WP-C: Homeroom bot reads a newcomer's messages here for ideas, and
      // offers to suggest one to the group (homeroom-bot-chat.js
      // maybeOffer), so the tour says that it does.
      get text() { return tr("auth:say_hi_or_share_an_idea_for_what_it_should_do_ne_a681546a"); },
      place: { above: '#gc-form' },
      last: true,
    },
  ];
}

/**
 * The maker's tour, after "Invite people later" or "Go to the Homeroom
 * app": the same shape as the invited one, but it ends where the build is,
 * in Homeroom bot's chat (when the project has one: the bot builds for this
 * account), and otherwise on the hub.
 */
export function makerSteps({ slug, name, conversationId }: TourProject): TourStep[] {
  const steps: TourStep[] = [
    {
      screen: 'home',
      target: `.app-card[data-slug="${slug}"]`,
      get title() { return tr("auth:value1_is_on_your_home_310b3349", { value1: name }); },
      get text() { return tr("auth:open_it_any_time_from_here_7600459f"); },
      get tap() { return tr("auth:tap_it_to_open_it_2e386cca"); },
    },
    {
      screen: 'app',
      target: '#app-content',
      get title() { return tr("auth:value1_being_built_337fe9aa", { value1: name }); },
      get text() { return tr("auth:until_the_first_version_is_ready_this_shows_how__a6b7f0d6"); },
      place: 'bottom',
    },
    closeAppStep(),
    {
      screen: 'home',
      // The same tab as the invited path's step 4 (see there).
      target: '#platform-tab-workshop',
      get title() { return tr("auth:your_group_lives_in_communities_7c0e2574"); },
      get text() { return tr("auth:its_hub_and_its_group_chat_are_there_7bb8dda1"); },
      get tap() { return tr("auth:tap_communities_81a76bc4"); },
    },
    {
      screen: 'hub',
      // As the invited path's hub step: the whole screen but the tab bar.
      target: '#app-content',
      alongside: SCREEN_HEADER,
      endsAbove: BOTTOM_BARS,
      get title() { return hubTitle(name); },
      get text() { return tr("auth:who_s_in_it_what_s_being_built_and_what_s_up_for_93a3b812"); },
      place: 'bottom',
    },
  ];
  if (!conversationId) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], last: true };
    return steps;
  }
  steps.push(
    {
      screen: 'hub',
      target: '#platform-tab-messages',
      get title() { return tr("auth:homeroom_bot_is_in_messages_dbe68a6a"); },
      get text() { return tr("auth:it_s_building_value1_now_8e542c51", { value1: name }); },
      get tap() { return tr("auth:tap_messages_da072f5e"); },
      opensNext: true,
    },
    {
      screen: 'bot',
      target: `${BOT_CHAT_HEADER}, ${BOT_CHAT_MESSAGES}`,
      alongside: SCREEN_HEADER,
      newestFromTop: { scroller: BOT_CHAT_MESSAGES, rows: 'article.messages-message' },
      get title() { return tr("auth:your_chat_with_homeroom_bot_5b8251d0"); },
      get text() { return tr("auth:it_shows_how_the_build_is_going_here_and_message_f75c92a8"); },
      place: 'bottom',
      last: true,
    },
  );
  return steps;
}
