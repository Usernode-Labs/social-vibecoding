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
  title: string;
  text: string;
  /** A step the reader finishes by pressing its target: the hint shown instead of Next. */
  tap?: string;
  /** Where the card goes: under the target or over it (auto), at the foot of the screen, or just above another element. */
  place?: 'auto' | 'bottom' | { above: string };
  /** Pressing the target lands on a list; open the next step's screen itself (the bot's chat, not the inbox). */
  opensNext?: boolean;
  last?: boolean;
};

export type TourProject = { slug: string; name: string; conversationId?: number | null };

/** The invited path: seven steps, ending in the group's chat. */
export function invitedSteps({ slug, name }: TourProject): TourStep[] {
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
      get title() { return tr("auth:this_is_value1_9285731a", { value1: name }); },
      get text() { return tr("auth:the_group_s_app_made_on_homeroom_use_it_any_time_bd51fd5e"); },
      place: 'bottom',
    },
    {
      screen: 'app',
      target: '#back-btn',
      get title() { return tr("auth:close_it_with_6799d998"); },
      get text() { return tr("auth:the_app_opens_full_screen_takes_you_back_to_home_8cf88983"); },
      tap: 'Tap ✕',
      place: 'bottom',
    },
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
      target: '#app-content',
      get title() { return tr("auth:value1_s_hub_44139f68", { value1: name }); },
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
    {
      screen: 'app',
      target: '#back-btn',
      get title() { return tr("auth:close_it_with_6799d998"); },
      get text() { return tr("auth:the_app_opens_full_screen_takes_you_back_to_home_8cf88983"); },
      tap: 'Tap ✕',
      place: 'bottom',
    },
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
      target: '#app-content',
      get title() { return tr("auth:value1_s_hub_44139f68", { value1: name }); },
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
      target: '.messages-thread-scroll',
      get title() { return tr("auth:your_chat_with_homeroom_bot_5b8251d0"); },
      get text() { return tr("auth:it_shows_how_the_build_is_going_here_and_message_f75c92a8"); },
      place: 'bottom',
      last: true,
    },
  );
  return steps;
}
