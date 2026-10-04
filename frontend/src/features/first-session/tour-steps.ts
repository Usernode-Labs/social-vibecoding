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
      title: `${name} is on your Home`,
      text: 'Open it any time from here.',
      tap: 'Tap it to open it',
    },
    {
      screen: 'app',
      target: '#app-content',
      title: `This is ${name}`,
      text: 'The group\'s app, made on Homeroom. Use it any time.',
      place: 'bottom',
    },
    {
      screen: 'app',
      target: '#back-btn',
      title: 'Close it with ✕',
      text: 'The app opens full screen. ✕ takes you back to Home.',
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
      title: 'The group lives in Communities',
      text: 'Its hub and its group chat are there.',
      tap: 'Tap Communities',
    },
    {
      screen: 'hub',
      target: '#app-content',
      title: `${name}'s hub`,
      text: 'Communities opens on the group you just joined: who\'s in it, what\'s being built, and what\'s up for a vote.',
      place: 'bottom',
    },
    {
      screen: 'hub',
      target: '[data-ws-tab-btn="discussion"]',
      title: 'Discussion is the group chat',
      text: `Everyone in ${name} talks here.`,
      tap: 'Tap Discussion',
      place: 'bottom',
    },
    {
      screen: 'discussion',
      target: '#gc-messages, #gc-form',
      title: 'The group chat',
      // WP-C: Homeroom bot reads a newcomer's messages here for ideas, and
      // offers to suggest one to the group (homeroom-bot-chat.js
      // maybeOffer), so the tour says that it does.
      text: 'Say hi, or share an idea for what it should do next. Homeroom bot offers to suggest an idea to the group in your name, and the group decides what goes in.',
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
      title: `${name} is on your Home`,
      text: 'Open it any time from here.',
      tap: 'Tap it to open it',
    },
    {
      screen: 'app',
      target: '#app-content',
      title: `${name}, being built`,
      text: 'Until the first version is ready, this shows how the build is going.',
      place: 'bottom',
    },
    {
      screen: 'app',
      target: '#back-btn',
      title: 'Close it with ✕',
      text: 'The app opens full screen. ✕ takes you back to Home.',
      tap: 'Tap ✕',
      place: 'bottom',
    },
    {
      screen: 'home',
      // The same tab as the invited path's step 4 (see there).
      target: '#platform-tab-workshop',
      title: 'Your group lives in Communities',
      text: 'Its hub and its group chat are there.',
      tap: 'Tap Communities',
    },
    {
      screen: 'hub',
      target: '#app-content',
      title: `${name}'s hub`,
      text: 'Who\'s in it, what\'s being built, and what\'s up for a vote, once people join.',
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
      title: 'Homeroom bot is in Messages',
      text: `It's building ${name} now.`,
      tap: 'Tap Messages',
      opensNext: true,
    },
    {
      screen: 'bot',
      target: '.messages-thread-scroll',
      title: 'Your chat with Homeroom bot',
      text: 'It shows how the build is going here, and messages you when it\'s ready to try. Ask it for changes any time.',
      place: 'bottom',
      last: true,
    },
  );
  return steps;
}
