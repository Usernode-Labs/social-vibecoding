/**
 * Whether to ask somebody to turn notifications on, here and now.
 *
 * Asked at a MOMENT, when they have just started waiting on something and
 * the ask can say what they will hear about (services/notification-asks.js
 * lists them). Homeroom pushes only to its app on a phone; a browser has no
 * push. So the ask is one of two things:
 *
 *   app  in the Homeroom app: an in-app "Notify me / Not now" first, and the
 *        OS prompt only behind Notify me. iOS presents its prompt once and
 *        Android twice, so it is not spent on somebody who has not said yes
 *        to the idea.
 *   web  in a browser: "Get the app so we can tell you", with the store link
 *        on a phone and a code to scan on a computer, and "or we'll email
 *        you" where email really does stand in for that moment's push
 *        (services/activity-mail.js).
 *
 * One pure function, so every rule is a test (tests/notify-ask.test.js). The
 * rules are all reasons NOT to ask:
 *   - the moment was asked about on this surface already;
 *   - two "Not now"s on this surface;
 *   - in the app: the permission is allowed (nothing to ask) or denied (the OS
 *     shows no prompt; Settings has the way to its settings page), or this
 *     build cannot ask;
 *   - on the web: a phone of theirs takes the push already, they said yes to
 *     getting the app before, or there is no app to get.
 */

/** services/notification-asks.js MOMENTS. */
export type NotifyMoment =
  | 'app_building'
  | 'invite_sent'
  | 'suggestion'
  | 'reply'
  | 'community'
  | 'project_opens';

export type AskSurface = 'app' | 'web';
export type AskAnswer = 'yes' | 'not_now';

export interface AskRecord {
  surface: AskSurface;
  moment: NotifyMoment;
  answer: AskAnswer;
}

/** GET /api/me/notification-asks. */
export interface AskState {
  asks: AskRecord[];
  /** A phone of theirs can take a push now. */
  phone: boolean;
  /** Homeroom would email them in a push's place (confirmed, not turned off). */
  email: boolean;
}

/** The OS notification permission, as NativeChrome reads it. */
export type OsPermission = 'granted' | 'denied' | 'undetermined' | null;

/**
 * The moments whose push Homeroom emails when no phone can take it, so the
 * web ask may say "or we'll email you": a first version going live and a
 * build ready to try (homeroom-bot-dm.js), invite news (invite-activity.js),
 * the votes owed (vote-digest.js) and a project opening (first-version
 * live, to its members). A reply is not emailed.
 */
export const EMAILED_MOMENTS: ReadonlySet<NotifyMoment> = new Set<NotifyMoment>([
  'app_building', 'invite_sent', 'suggestion', 'community', 'project_opens',
]);

/** Two "Not now"s on a surface and it stops asking. */
export const NOT_NOW_LIMIT = 2;

export interface AskInput {
  moment: NotifyMoment;
  /** null: the account's answers could not be read, so nothing is asked. */
  state: AskState | null;
  /** Inside the Homeroom app. */
  native: boolean;
  /** In the app: the OS permission. */
  permission?: OsPermission;
  /** In the app: this build can ask the OS. */
  canRequest?: boolean;
  /** On the web: there is an app to get on this device (a link, or a code to scan). */
  appToGet?: boolean;
}

export type AskPlan =
  | { show: 'app' }
  | { show: 'web'; email: boolean }
  | { show: null; reason: string };

export function decideNotifyAsk(input: AskInput): AskPlan {
  const { moment, state } = input;
  if (!state) return { show: null, reason: 'the answers could not be read' };
  const surface: AskSurface = input.native ? 'app' : 'web';
  const mine = state.asks.filter((a) => a.surface === surface);
  if (mine.some((a) => a.moment === moment)) {
    return { show: null, reason: 'asked at this moment already' };
  }
  if (mine.filter((a) => a.answer === 'not_now').length >= NOT_NOW_LIMIT) {
    return { show: null, reason: 'two Not nows' };
  }
  if (surface === 'app') {
    if (input.permission === 'granted') return { show: null, reason: 'notifications are allowed' };
    if (input.permission === 'denied') {
      return { show: null, reason: 'notifications are denied, and the OS shows no prompt for that' };
    }
    if (input.canRequest !== true) return { show: null, reason: 'this app build cannot ask' };
    return { show: 'app' };
  }
  if (state.phone) return { show: null, reason: 'a phone of theirs takes the push' };
  if (mine.some((a) => a.answer === 'yes')) return { show: null, reason: 'they were given the app already' };
  if (input.appToGet !== true) return { show: null, reason: 'no app to get' };
  return { show: 'web', email: state.email && EMAILED_MOMENTS.has(moment) };
}
