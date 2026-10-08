import { t } from '../../lib/i18n/runtime';
import type { HomeroomBotActivityOutcome, HomeroomBotJob } from './types';

/*
 * What the Homeroom bot's activity tray (./bot-work.tsx) and its activity
 * cards (./bot-activity.tsx) both need: how a piece of work is named, and
 * the window event that says the bot's work moved on. A module of its own
 * so the two can share it without importing each other.
 */

/** public/js/app.js dispatches this on `homeroom_bot_work_changed` and on a socket reconnect. */
export const WORK_CHANGED_EVENT = 'homeroom-bot-work-changed';

/**
 * #4227: the endings that are still moving, drawn with the working card's
 * spinner (./bot-activity.tsx) and read again like work that is going: a
 * change being checked before it is offered, and one going live.
 */
export const SPINNING_OUTCOMES: ReadonlySet<HomeroomBotActivityOutcome> = new Set(['checking', 'going_live']);

type Named = Pick<HomeroomBotJob, 'appName' | 'issueNumber' | 'title' | 'firstVersion'>;

/** "Ear Trainer first version", "Ear Trainer #12": what the header's status line names. */
export function jobName(job: Named): string {
  if (job.firstVersion) return t('messages:bot.job.firstVersion', { project: job.appName });
  return job.issueNumber ? t('messages:bot.job.request', { project: job.appName, number: job.issueNumber }) : job.appName;
}

/**
 * Short independent facts on one status line ("Building · 5m so far"). Each
 * part is a whole message already; what joins two of them is a message too.
 */
export function dotText(parts: readonly (string | null | undefined | false)[]): string {
  const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  if (!said.length) return '';
  return said.reduce((first, second) => t('messages:list.dot', { first, second }));
}

/** A tile's or a card's title: the name, and the request's own title when it has one. */
export function jobTitle(job: Named): string {
  if (job.firstVersion || !job.title) return jobName(job);
  return job.issueNumber
    ? t('messages:bot.job.requestTitled', { project: job.appName, number: job.issueNumber, title: job.title })
    : t('messages:bot.job.titled', { project: job.appName, title: job.title });
}

/**
 * The project an in-app address opens on its App tab (`#app/<slug>/app`, as
 * services/homeroom-bot-dm.js openAppAction writes it), or null for any
 * other address.
 */
export function appTabSlug(target: string | null | undefined): string | null {
  const match = /^#app\/([^/?#]+)\/app$/.exec(String(target || ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

/**
 * #4231: the project whose community page an in-app address opens
 * (`#app/<slug>/workshop`, as services/homeroom-bot-dm.js firstLiveActions
 * writes it), or null for any other address.
 */
export function hubSlug(target: string | null | undefined): string | null {
  const match = /^#app\/([^/?#]+)\/workshop$/.exec(String(target || ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

/**
 * A bot button's way into the platform (`open`, always `#app/…`). A
 * project's App tab opens the way the rest of the shell opens a project's
 * app: App.openAppTab, as an app's icon and its about pane do, which also
 * works when that address is already the one in the bar. A community page
 * is a door that says where it goes, so it lands on the hub, not the tab the
 * page was last left on (AppView._landOnHub, as channel-hub.ts does). Any
 * other address, or no router, goes to the address.
 */
export function openAppTarget(target: string | null | undefined): void {
  if (typeof window === 'undefined' || !target || !target.startsWith('#app/')) return;
  const slug = appTabSlug(target);
  if (slug && typeof window.App?.openAppTab === 'function') {
    window.App.openAppTab(slug, 'app');
    return;
  }
  const hub = hubSlug(target);
  if (hub) {
    const view = (window as unknown as { AppView?: { _landOnHub?: (slug: string) => void } }).AppView;
    try { view?._landOnHub?.(hub); } catch { /* the page opens where it opens */ }
  }
  window.location.hash = target;
}
