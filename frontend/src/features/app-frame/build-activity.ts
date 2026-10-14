/**
 * Run six (14 Oct 2026): the maker's first version on their Lock Screen.
 *
 * A first version takes about 23 minutes, so its maker puts the phone down
 * while it builds. The Homeroom app on iOS 16.1+ can show it as a Live
 * Activity (the project, the stage and the time left, on the Lock Screen and
 * in the Dynamic Island) through the bridge's `setBuildActivity`
 * (NATIVE-BRIDGE.md, "Build Live Activity"). This keeps that activity in
 * step with what the screen says, while the page is open in the app.
 *
 * ONE FUNCTION, TWO CALLERS. Both screens that read the maker's first
 * version call `syncBuildActivity` with what they read:
 *
 *   the made screen  after Submit, on every read of GET /api/apps/:slug and
 *                    with its own line ("Starting the build" from the moment
 *                    Submit goes through), so the activity starts there
 *                    (../first-session/made.tsx)
 *   the App tab      every answer the server gave for the project
 *                    (public/js/app-view.js _noteAppRecordRead, through
 *                    `window.UsernodeReact.buildActivity.syncRecord`), never
 *                    the service worker's copy
 *
 * WHAT IT SENDS. One activity per build, `first-version:<slug>`, titled with
 * the project's name:
 *
 *   Building it, Testing it   `active`, with the stage in the build line's
 *                             own words (phaseLine, BUILD_LINE_WORDS: never
 *                             words of its own), and the estimate's `etaAt`
 *                             while the screen counts down. Once the step
 *                             under way runs past its own estimate the screen
 *                             says it is taking a little longer than usual,
 *                             and the activity drops its countdown with it.
 *                             These two lines may start one.
 *   Ready to try              `active` while it goes live on its own
 *                             (`approval.noVote` or `soon`), else `ended`,
 *                             "<name> is ready to try": it waits for
 *                             somebody's Yes, which can take days.
 *   Live, or gone             `ended`, "<name> is live". A running app whose
 *                             answer has no first version any more is live:
 *                             the App tab mounts it, and the made screen says
 *                             Live.
 *   any other line            the running activity's stage, when there is
 *                             one ("Homeroom bot has a question for you");
 *                             none is started for it.
 *
 * WHEN. Only inside the app, on a build that advertises `setBuildActivity`;
 * only for the maker (`first_version.mine`); only when what it would show
 * changed (the line, the stage's words, the minute the countdown ends);
 * `ended` once per build, and nothing for that build after it. A
 * `started: false` (ActivityKit starts one only in the foreground) is tried
 * again the next time the page comes back to the foreground. Nothing here
 * throws into a screen: a refusal is a console.warn.
 *
 * What it last sent is remembered on this device (localStorage, one build at
 * a time), so a page loaded later can still end the activity it started:
 * the maker taps "<name> is live" in the bell, the app opens the project,
 * and the activity on the Lock Screen says so too.
 *
 * Kept on `globalThis`, as ../first-session/tour-running.ts is, so a chunk
 * that bundles its own copy of this module shares the one instance.
 */

import { t as translate } from '../../lib/i18n/runtime';
import { BUILD_LINE_WORDS, buildLineOf, phaseLine } from '../first-session/build-line';
import { stepsOf } from '../first-session/build-line-words.js';
import { countsDown, estimateOf } from './first-version-eta';

/** The bridge capability that says the call has a visible effect. */
export const BUILD_ACTIVITY_CAPABILITY = 'setBuildActivity';

/** The ended headlines, message ids (frontend/locales/en/onboarding.json). */
export const ENDED_WORDS = Object.freeze({
  live: 'onboarding:buildLine.activity.live',
  ready: 'onboarding:buildLine.activity.readyToTry',
});

// The contract's limits (NATIVE-BRIDGE.md).
const ID_MAX = 128;
const TITLE_MAX = 80;
const STAGE_MAX = 80;
const ENDED_TITLE_MAX = 120;
const DEEP_LINK_MAX = 1024;
const ID_PATTERN = /^[A-Za-z0-9][\w.:-]*$/;
// What the app reads as a time: anything outside is a unit mistake.
const MIN_EPOCH_MS = 1577836800000;
const MAX_EPOCH_MS = 4102444800000;
const MINUTE_MS = 60000;

/** What this device remembers of the build it last sent, for a later page. */
export const RECORD_KEY = 'usernode:build-activity';
/** Past this a remembered build is forgotten: iOS has ended its activity by then. */
export const RECORD_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const INSTANCE_KEY = '__usernodeBuildActivity';

export type BuildActivityArgs = {
  activityId: string;
  state: 'active' | 'ended';
  title: string;
  stage?: string;
  startedAt: number;
  etaAt: number | null;
  deepLink?: string;
  endedTitle?: string;
};

/** What a screen read about the project. */
export type BuildActivityInput = {
  slug: string;
  /** The project's name. */
  name: string | null;
  /** The reader is its maker (`first_version.mine`). */
  mine: boolean;
  /** The build line the screen says (`first_version.line`, or the made screen's own), or null. */
  line: string | null;
  /** `first_version.phase`, `.steps`, `.estimate` and `.approval`, as the server sent them. */
  phase?: unknown;
  steps?: unknown;
  estimate?: unknown;
  approval?: unknown;
  /** No first version any more, on a running app: it went live. */
  gone?: boolean;
};

/** The build this device last sent. */
export type BuildActivityRecord = {
  id: string;
  startedAt: number;
  /** What the last call showed (planBuildActivity's `sig`). */
  sig: string;
  ended: boolean;
  /** The last answer's `started`: null before one came, or when it failed. */
  started: boolean | null;
  /** When it was sent (ms). */
  at: number;
};

export type BuildActivityReply = { supported: boolean; started?: boolean; pushToken?: string };

/** One line of at most `max` characters, as the app collapses it, ending in "…" when cut. Pure. */
export function oneLine(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The activity's id for project `slug`, or null when the contract cannot carry it. Pure. */
export function activityIdOf(slug: unknown): string | null {
  if (typeof slug !== 'string' || !slug) return null;
  const id = `first-version:${slug}`;
  return id.length <= ID_MAX && ID_PATTERN.test(id) ? id : null;
}

/** The project's App tab, absolute, when this page is served over https; else none. Pure. */
export function deepLinkOf(origin: unknown, slug: string): string | null {
  if (typeof origin !== 'string' || !/^https:\/\/[^/@\s]+$/.test(origin)) return null;
  const link = `${origin}/app/${encodeURIComponent(slug)}`;
  return link.length <= DEEP_LINK_MAX ? link : null;
}

/**
 * When the build started (its plan decided, the start of "Screens drawn"),
 * from the step list: the step under way's `since`, less the minutes of the
 * steps done since the plan. Null before it is built, or without a time. Pure.
 */
export function buildStartOf(steps: unknown): number | null {
  const list = stepsOf(steps);
  const at = list.findIndex((s) => s.state === 'now');
  if (at < 0 || list[at].key === 'plan' || !list[at].since) return null;
  let start = Date.parse(list[at].since as string);
  for (const s of list.slice(0, at)) {
    if (s.key !== 'plan' && s.state === 'done' && typeof s.minutes === 'number') start -= s.minutes * MINUTE_MS;
  }
  return Number.isFinite(start) ? start : null;
}

/**
 * When it should be live, for the countdown: the estimate's `etaAt` while
 * the screen counts down (Building it, Testing it, the step under way not
 * yet past its own estimate), else null. Never at or before `startedAt`. Pure.
 */
export function etaOf(line: string | null, estimate: unknown, startedAt: number, now: number): number | null {
  if (!countsDown(line)) return null;
  const e = estimateOf(estimate);
  if (!e) return null;
  const stepEnd = Date.parse(e.stepEtaAt);
  const end = Date.parse(e.etaAt);
  if (!(now < stepEnd)) return null;
  if (!(end > startedAt) || end > MAX_EPOCH_MS) return null;
  return end;
}

/** Whether a first version that is ready goes live by itself (true), waits on somebody (false), or neither is known (null). Pure. */
export function goesLiveOnItsOwn(approval: unknown): boolean | null {
  if (!approval || typeof approval !== 'object') return null;
  const a = approval as { noVote?: unknown; soon?: unknown };
  return a.noVote === true || a.soon === true;
}

/** Which way the build has ended, by what the screen read: 'live', 'ready' (it waits for a Yes), or null while it is on its way. Pure. */
export function endingOf(input: BuildActivityInput, line: string | null): 'live' | 'ready' | null {
  if (input.gone === true || line === 'live') return 'live';
  if (line === 'ready' && goesLiveOnItsOwn(input.approval) === false) return 'ready';
  return null;
}

/** A call's signature: its arguments, with the countdown's end to the minute. Pure. */
export function signatureOf(args: BuildActivityArgs): string {
  return JSON.stringify({ ...args, etaAt: args.etaAt == null ? null : Math.round(args.etaAt / MINUTE_MS) });
}

/**
 * The call to make for what a screen read, given the build this device last
 * sent (`record`), or null for none: not the maker's, nothing of ours to
 * update or end, or a build already ended. Pure.
 */
export function planBuildActivity(
  input: BuildActivityInput | null,
  record: BuildActivityRecord | null,
  { now, origin = null }: { now: number; origin?: string | null },
): { args: BuildActivityArgs; sig: string } | null {
  if (!input || typeof input !== 'object' || !Number.isFinite(now)) return null;
  const id = activityIdOf(input.slug);
  if (!id) return null;
  const own = record && record.id === id ? record : null;
  if (own && own.ended) return null;
  const title = oneLine(input.name, TITLE_MAX) || oneLine(input.slug, TITLE_MAX);
  const link = deepLinkOf(origin, input.slug);
  const line = buildLineOf(input.line);
  const ending = endingOf(input, line);
  if (ending) {
    // Only an activity this device started is ended: on a page that never
    // showed one there is nothing on the Lock Screen to end.
    if (!own) return null;
    const endedTitle = oneLine(translate(ENDED_WORDS[ending], { name: title }), ENDED_TITLE_MAX);
    const args: BuildActivityArgs = {
      activityId: id, state: 'ended', title, startedAt: own.startedAt, etaAt: null,
      ...(link ? { deepLink: link } : {}),
      ...(endedTitle ? { endedTitle } : {}),
    };
    return { args, sig: signatureOf(args) };
  }
  if (input.mine !== true || !line) return null;
  // Building it and Testing it start one; any other line only updates it.
  if (!own && line !== 'building' && line !== 'testing') return null;
  const stage = oneLine(phaseLine(line, input.phase ?? null, now).words || translate(BUILD_LINE_WORDS[line]), STAGE_MAX);
  if (!stage) return null;
  const derived = own ? own.startedAt : buildStartOf(input.steps);
  const startedAt = derived != null && derived >= MIN_EPOCH_MS && derived <= now ? derived : now;
  const args: BuildActivityArgs = {
    activityId: id, state: 'active', title, stage, startedAt,
    etaAt: etaOf(line, input.estimate, startedAt, now),
    ...(link ? { deepLink: link } : {}),
  };
  return { args, sig: signatureOf(args) };
}

/**
 * What the App tab reads from an app record (GET /api/apps/:slug `{ app }`),
 * as the screen reads it (AppView._firstVersionThumb): its line, else ready
 * or planning; or, with no first version on an app that runs, gone. Pure.
 */
export function inputOfRecord(app: unknown): BuildActivityInput | null {
  if (!app || typeof app !== 'object') return null;
  const a = app as Record<string, unknown>;
  if (typeof a.slug !== 'string' || !a.slug) return null;
  const name = typeof a.name === 'string' && a.name.trim() ? a.name : a.slug;
  const fv = a.first_version && typeof a.first_version === 'object' ? (a.first_version as Record<string, unknown>) : null;
  if (!fv) return { slug: a.slug, name, mine: false, line: null, gone: a.status === 'running' };
  return {
    slug: a.slug,
    name,
    mine: fv.mine === true,
    line: typeof fv.line === 'string' && fv.line ? fv.line : fv.ready ? 'ready' : 'planning',
    phase: fv.phase,
    steps: fv.steps,
    estimate: fv.estimate,
    approval: fv.approval,
  };
}

/** A remembered build, if it is one and recent. Pure. */
export function recordOf(raw: unknown, now: number): BuildActivityRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.startsWith('first-version:') || r.id.length > ID_MAX || !ID_PATTERN.test(r.id)) return null;
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null;
  if (typeof r.at !== 'number' || !(now - r.at <= RECORD_MAX_AGE_MS)) return null;
  return {
    id: r.id,
    startedAt: r.startedAt,
    sig: typeof r.sig === 'string' ? r.sig : '',
    ended: r.ended === true,
    started: typeof r.started === 'boolean' ? r.started : null,
    at: r.at,
  };
}

type BridgeLike = {
  isNative?: unknown;
  setBuildActivity?: (args: BuildActivityArgs) => Promise<unknown>;
  getBridgeInfo?: () => Promise<unknown>;
};
type BridgeInfo = { capabilities?: unknown; degraded?: unknown } | null | undefined;

export type BuildActivityDeps = {
  /** `window.usernode`, or null. */
  bridge: () => BridgeLike | null;
  /** The app's capabilities (NativeChrome.getInfo, else getBridgeInfo). */
  info: () => Promise<BridgeInfo>;
  now?: () => number;
  /** This page's origin, for the link a tap opens. */
  origin?: () => string | null;
  /** The remembered build, as a string, and where it is written. */
  load?: () => string | null;
  save?: (value: string | null) => void;
  warn?: (...args: unknown[]) => void;
};

export type BuildActivity = {
  /** Bring the activity in step with what a screen read. Never rejects; resolves the app's answer, or null for no call. */
  sync(input: BuildActivityInput | null): Promise<BuildActivityReply | null>;
  /** The same, from an app record (inputOfRecord). */
  syncRecord(app: unknown): Promise<BuildActivityReply | null>;
  /** The page came back to the foreground: a refused start may be tried again. */
  noteReturn(): void;
  /** The build this device last sent (tests). */
  record(): BuildActivityRecord | null;
};

export function createBuildActivity(deps: BuildActivityDeps): BuildActivity {
  const now = deps.now || (() => Date.now());
  const warn = deps.warn || ((...args: unknown[]) => console.warn(...args));
  let record: BuildActivityRecord | null = null;
  try {
    const raw = deps.load ? deps.load() : null;
    record = raw ? recordOf(JSON.parse(raw), now()) : null;
  } catch {
    record = null;
  }
  // A page loaded since the last call counts as a return.
  let returnedAt = now();
  let support: Promise<boolean> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const remember = (next: BuildActivityRecord | null) => {
    record = next;
    try {
      deps.save?.(next ? JSON.stringify(next) : null);
    } catch { /* private mode, or storage blocked: this page still remembers */ }
  };

  // Asked once per page; a degraded probe is "don't know", asked again next time.
  const supported = (): Promise<boolean> => {
    const bridge = deps.bridge();
    if (!bridge || bridge.isNative !== true || typeof bridge.setBuildActivity !== 'function') return Promise.resolve(false);
    if (support) return support;
    let conclusive = false;
    const probe: Promise<boolean> = Promise.resolve()
      .then(() => deps.info())
      .then((info) => {
        if (!info || info.degraded === true) return false;
        conclusive = true;
        return Array.isArray(info.capabilities) && info.capabilities.includes(BUILD_ACTIVITY_CAPABILITY);
      })
      .catch(() => false)
      .then((ok) => {
        if (!conclusive && support === probe) support = null;
        return ok;
      });
    support = probe;
    return probe;
  };

  const runOnce = async (input: BuildActivityInput | null): Promise<BuildActivityReply | null> => {
    const at = now();
    const planned = planBuildActivity(input, record, { now: at, origin: deps.origin ? deps.origin() : null });
    if (!planned) return null;
    const { args, sig } = planned;
    const same = !!record && record.id === args.activityId && record.sig === sig;
    const retry = same && args.state === 'active' && record!.started === false && returnedAt > record!.at;
    if (same && !retry) return null;
    if (!(await supported())) return null;
    const sent: BuildActivityRecord = { id: args.activityId, startedAt: args.startedAt, sig, ended: args.state === 'ended', started: null, at };
    remember(sent);
    let reply: BuildActivityReply | null = null;
    try {
      const value = await deps.bridge()!.setBuildActivity!(args);
      const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      reply = {
        supported: v.supported === true,
        ...(v.supported === true ? { started: v.started === true } : {}),
        ...(typeof v.pushToken === 'string' && v.pushToken ? { pushToken: v.pushToken } : {}),
      };
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as { usernodeCode?: unknown }).usernodeCode : null;
      warn('[build-activity] setBuildActivity was refused:', code || (err instanceof Error ? err.message : err));
      return null;
    }
    if (record === sent) remember({ ...sent, started: reply.supported ? reply.started === true : false });
    return reply;
  };

  const instance: BuildActivity = {
    sync(input) {
      const run = queue.then(() => runOnce(input)).catch((err) => {
        warn('[build-activity] could not sync:', err instanceof Error ? err.message : err);
        return null;
      });
      queue = run;
      return run;
    },
    syncRecord(app) {
      return instance.sync(inputOfRecord(app));
    },
    noteReturn() {
      returnedAt = now();
    },
    record() {
      return record;
    },
  };
  return instance;
}

type BuildActivityHost = {
  usernode?: BridgeLike;
  NativeChrome?: { getInfo?: () => Promise<BridgeInfo> };
};

function pageDeps(): BuildActivityDeps {
  const host = window as unknown as BuildActivityHost;
  return {
    bridge: () => host.usernode || null,
    info: () => {
      const chrome = host.NativeChrome;
      if (chrome && typeof chrome.getInfo === 'function') return chrome.getInfo();
      const bridge = host.usernode;
      return bridge && typeof bridge.getBridgeInfo === 'function'
        ? (bridge.getBridgeInfo() as Promise<BridgeInfo>)
        : Promise.resolve(null);
    },
    origin: () => (typeof location !== 'undefined' ? location.origin : null),
    load: () => window.localStorage.getItem(RECORD_KEY),
    save: (value) => {
      if (value == null) window.localStorage.removeItem(RECORD_KEY);
      else window.localStorage.setItem(RECORD_KEY, value);
    },
  };
}

/** The page's one instance, made on first use (never in the prerender). */
export function buildActivity(): BuildActivity | null {
  if (typeof window === 'undefined') return null;
  const g = globalThis as unknown as Record<string, BuildActivity | undefined>;
  let instance = g[INSTANCE_KEY];
  if (!instance) {
    const made = createBuildActivity(pageDeps());
    instance = made;
    g[INSTANCE_KEY] = made;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') made.noteReturn();
      });
    }
  }
  return instance;
}

/** Bring the maker's Live Activity in step with what a screen read. Fire and forget: never throws. */
export function syncBuildActivity(input: BuildActivityInput | null): void {
  try {
    void buildActivity()?.sync(input);
  } catch (err) {
    console.warn('[build-activity] could not sync:', err instanceof Error ? err.message : err);
  }
}

/** The same, from an app record: the App tab's door (public/js/app-view.js). */
export function syncBuildActivityRecord(app: unknown): void {
  syncBuildActivity(inputOfRecord(app));
}
