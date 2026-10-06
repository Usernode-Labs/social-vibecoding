import type { HomeroomBotJob } from './types';

/*
 * What the Homeroom bot's activity tray (./bot-work.tsx) and its activity
 * cards (./bot-activity.tsx) both need: how a piece of work is named, and
 * the window event that says the bot's work moved on. A module of its own
 * so the two can share it without importing each other.
 */

/** public/js/app.js dispatches this on `homeroom_bot_work_changed` and on a socket reconnect. */
export const WORK_CHANGED_EVENT = 'homeroom-bot-work-changed';

type Named = Pick<HomeroomBotJob, 'appName' | 'issueNumber' | 'title' | 'firstVersion'>;

/** "Ear Trainer first version", "Ear Trainer #12": what the header's status line names. */
export function jobName(job: Named): string {
  if (job.firstVersion) return `${job.appName} first version`;
  return job.issueNumber ? `${job.appName} #${job.issueNumber}` : job.appName;
}

/** A tile's or a card's title: the name, and the request's own title when it has one. */
export function jobTitle(job: Named): string {
  const name = jobName(job);
  return !job.firstVersion && job.title ? `${name}: ${job.title}` : name;
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
 * A bot button's way into the platform (`open`, always `#app/…`). A
 * project's App tab opens the way the rest of the shell opens a project's
 * app: App.openAppTab, as an app's icon and its about pane do, which also
 * works when that address is already the one in the bar. Any other address,
 * or no router, goes to the address.
 */
export function openAppTarget(target: string | null | undefined): void {
  if (typeof window === 'undefined' || !target || !target.startsWith('#app/')) return;
  const slug = appTabSlug(target);
  if (slug && typeof window.App?.openAppTab === 'function') {
    window.App.openAppTab(slug, 'app');
    return;
  }
  window.location.hash = target;
}
