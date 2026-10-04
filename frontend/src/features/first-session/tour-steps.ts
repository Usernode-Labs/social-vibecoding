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

export type TourScreen = 'home' | 'app' | 'hub' | 'discussion';

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
  last?: boolean;
};

export type TourProject = { slug: string; name: string };

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
      // Homeroom bot does not read a group's chat yet, so this does not
      // promise that it turns a message into a request; it says what the
      // chat is for today.
      text: 'Say hi, or share an idea for what it should do next. The group decides what goes in.',
      place: { above: '#gc-form' },
      last: true,
    },
  ];
}
