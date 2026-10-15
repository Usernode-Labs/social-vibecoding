/**
 * A newcomer's first visit, after the first session's hand-off (Evan, 15 Oct
 * 2026, the onboarding canvas's "A tip in the app, then 1, 2, 3 on Home" and
 * "An invited person, every screen"). ./index.tsx owes them; this module
 * keeps what is owed and decides, from the screen, when each is due.
 *
 *   tip   The first time they open the app right after the hand-off (the
 *         maker by Go to app, an invited person straight from the link),
 *         one small tip under the Homeroom mark (./app-tip.tsx). A maker
 *         whose first version Homeroom bot is still building gets it the
 *         first time they open the app once it is live (`live`): its own
 *         frame up and uncovered, not the build's screen.
 *   walk  The first time Home shows after that first visit to the app, the
 *         walk on Home (./tour-steps.ts homeWalkSteps). The visit to the
 *         app arms it (`armed`); Home after it, by ✕, the mark menu's "Go to
 *         Homeroom" or a community first, runs it. A maker whose app is
 *         still being built goes to Home first, so theirs runs then
 *         (claimWalk), and somebody who had an account before an invite
 *         gets the tip alone.
 *
 * Each is shown once per person, recorded the way the first session records
 * itself: in this device's localStorage under the account's id (the "seen"
 * mark in ./index.tsx, App._privateHomeVisited in public/js/app.js). Owed is
 * a JSON record from the hand-off; "done" is written as it shows, so a
 * reload, another invite or another project never shows it again.
 */

import { t as translate } from '../../lib/i18n/runtime';
import { appFrameStore } from '../app-frame/app-frame-store.js';
import { appStatusStore } from '../app-frame/app-status-store.js';
import { appOpened, type FrameState, type StatusView } from './tour-wait';

export type TipWho = 'maker' | 'invited';

export type TipRecord = {
  slug: string;
  name: string;
  /** Whose words: the maker's ("Welcome to your app") or an invited person's ("Welcome to <app>"). */
  who: TipWho;
  /** Who sent the invite, by the name they go by, or null when it is not known. */
  inviter?: string | null;
  /** Shown only once the app runs in its own frame: a first version still on its way does not count. */
  live?: boolean;
  /** A screenshot state's tip (./index.tsx tipShot): nothing is written. */
  shot?: boolean;
};

export type WalkRecord = {
  slug: string;
  name: string;
  /** The waitlist card is the walk's fourth (users.private_member_since). */
  privateMember?: boolean;
  /** The maker's walk is told to the server card by card, as their tour was (./made-moments.ts). */
  maker?: boolean;
  /** Their first visit to the app has happened: the next Home runs it. */
  armed?: boolean;
};

export const TIP_PREFIX = 'usernode:first-session:tip:';
export const WALK_PREFIX = 'usernode:first-session:walk:';
export const DONE = 'done';

/** How often the island looks at the screen while a tip or a walk is owed. */
export const FIRST_VISIT_CHECK_MS = 250;

type KeyStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly length?: number;
  key?(index: number): string | null;
};
type Uid = number | string;

function local(): KeyStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function tipKey(uid: Uid): string {
  return `${TIP_PREFIX}${uid}`;
}

export function walkKey(uid: Uid): string {
  return `${WALK_PREFIX}${uid}`;
}

function readRecord<T extends { slug: string }>(key: string, store: KeyStore | null): T | typeof DONE | null {
  let raw: string | null = null;
  try { raw = store ? store.getItem(key) : null; } catch { return null; }
  if (!raw) return null;
  if (raw === DONE) return DONE;
  try {
    const value = JSON.parse(raw) as T | null;
    return value && typeof value === 'object' && typeof value.slug === 'string' && value.slug ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string, store: KeyStore | null): void {
  try { store?.setItem(key, value); } catch { /* private mode: shown on this page only */ }
}

/** The tip owed to this person, or null (none, or shown already). */
export function owedTip(uid: Uid, store: KeyStore | null = local()): TipRecord | null {
  const record = readRecord<TipRecord>(tipKey(uid), store);
  return record && record !== DONE ? record : null;
}

/** Owe this person the tip. Answers false when they have had it already: it is shown once per person. */
export function oweTip(uid: Uid, tip: TipRecord, store: KeyStore | null = local()): boolean {
  if (readRecord(tipKey(uid), store) === DONE) return false;
  const { slug, name, who, inviter = null, live = false } = tip;
  write(tipKey(uid), JSON.stringify({ slug, name, who, inviter: inviter || null, live: !!live }), store);
  return true;
}

/** The tip is on screen: never again for this person. */
export function noteTipShown(uid: Uid, store: KeyStore | null = local()): void {
  write(tipKey(uid), DONE, store);
}

/** The walk owed to this person, or null (none, or run already). */
export function owedWalk(uid: Uid, store: KeyStore | null = local()): WalkRecord | null {
  const record = readRecord<WalkRecord>(walkKey(uid), store);
  return record && record !== DONE ? record : null;
}

/** Owe this person the walk, unarmed until they have been in the app. False when they have had it. */
export function oweWalk(uid: Uid, walk: WalkRecord, store: KeyStore | null = local()): boolean {
  if (readRecord(walkKey(uid), store) === DONE) return false;
  const { slug, name, privateMember = false, maker = false } = walk;
  write(walkKey(uid), JSON.stringify({ slug, name, privateMember: !!privateMember, maker: !!maker, armed: false }), store);
  return true;
}

/** Their first visit to the app has happened: the walk runs on the next Home. */
export function armWalk(uid: Uid, store: KeyStore | null = local()): void {
  const walk = owedWalk(uid, store);
  if (walk && !walk.armed) write(walkKey(uid), JSON.stringify({ ...walk, armed: true }), store);
}

/** The walk is running: never again for this person. */
export function noteWalkRun(uid: Uid, store: KeyStore | null = local()): void {
  write(walkKey(uid), DONE, store);
}

/**
 * A walk that runs now rather than after the app (a maker whose app is
 * still being built goes to Home first): true, and recorded as run, unless
 * this person has had it.
 */
export function claimWalk(uid: Uid, store: KeyStore | null = local()): boolean {
  if (readRecord(walkKey(uid), store) === DONE) return false;
  noteWalkRun(uid, store);
  return true;
}

/**
 * Whether anything is owed on this device, to anybody: read once as the
 * island mounts (a reload in the middle of a first visit), so it looks at
 * the screen only while something is.
 */
export function anyOwed(store: KeyStore | null = local()): boolean {
  if (!store || typeof store.length !== 'number' || typeof store.key !== 'function') return false;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !(key.startsWith(TIP_PREFIX) || key.startsWith(WALK_PREFIX))) continue;
      const value = store.getItem(key);
      if (value && value !== DONE) return true;
    }
  } catch { /* nothing read: nothing owed */ }
  return false;
}

/** What the screen shows, as the tip and the walk read it (readScreen). */
export type FirstVisitScreen = {
  /** The app on screen: #app-view up and Home not, else null. */
  app: string | null;
  /** That app's tab ('app' for the app itself, 'dev' for its project page). */
  tab: string | null;
  /** Home is the screen, with no app over it. */
  home: boolean;
  /** The Homeroom mark is drawn in the header. */
  mark: boolean;
  /** The app has opened past its loading screens (./tour-wait.ts appOpened). */
  opened: boolean;
  /** The app runs in its own frame, uncovered: it is live. */
  live: boolean;
};

/** The tip shows on its app's own tab, under a mark that is drawn, once the app has opened (or is live, for `live`). */
export function tipDue(tip: Pick<TipRecord, 'slug' | 'live'>, screen: FirstVisitScreen): boolean {
  return screen.app === tip.slug && screen.tab === 'app' && screen.mark && (tip.live ? screen.live : screen.opened);
}

/** Their first visit to the app: any of its tabs counts. */
export function walkArms(walk: WalkRecord, screen: FirstVisitScreen): boolean {
  return !walk.armed && screen.app === walk.slug;
}

/** Home, after the app. */
export function walkDue(walk: WalkRecord, screen: FirstVisitScreen): boolean {
  return !!walk.armed && screen.home;
}

type ScreenHost = {
  App?: { currentApp?: string | null; currentTab?: string | null; _isScreenVisible?: (id: string) => boolean } | null;
};

/** Pure: the frame's own state says the app is live: its frame, for this app, on screen and uncovered. */
export function frameLive(slug: string, frame: FrameState): boolean {
  return frame.slug === slug && frame.active && (!frame.cover || !!frame.cover.out);
}

/** The App tab's own state, as the screen read takes it (the stores, unless a test hands its own). */
export type AppTabState = { frame: FrameState; view: StatusView };

function appTabState(): AppTabState {
  return { frame: appFrameStore.get() as FrameState, view: (appStatusStore.get() as { view: StatusView }).view };
}

/** The screen now, from the shell (App) and the App tab's stores. */
export function readScreen(
  host: ScreenHost = (typeof window === 'undefined' ? {} : window) as unknown as ScreenHost,
  doc: Pick<Document, 'getElementById'> | null = typeof document === 'undefined' ? null : document,
  appTab: AppTabState = appTabState(),
): FirstVisitScreen {
  const App = host.App;
  const visible = (id: string) => !!App?._isScreenVisible?.(id);
  const appUp = visible('app-view');
  const homeUp = visible('home-screen');
  const app = appUp && !homeUp ? (App?.currentApp || null) : null;
  // The mark is measured only over an app: nothing is laid out for it elsewhere.
  const rect = app ? doc?.getElementById('platform-mark-btn')?.getBoundingClientRect() : undefined;
  const { frame, view } = appTab;
  return {
    app,
    tab: app ? (App?.currentTab || null) : null,
    home: homeUp && !appUp,
    mark: !!rect && rect.width > 0 && rect.height > 0,
    opened: !!app && appOpened(app, frame, view, translate('changes:appStatus.checking')),
    live: !!app && frameLive(app, frame),
  };
}
