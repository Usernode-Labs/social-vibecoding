import { t as tr } from "../../lib/i18n/runtime";
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
  if (job.firstVersion) return tr("community:value1_first_version_4a4b9596", { value1: job.appName });
  return job.issueNumber ? `${job.appName} #${job.issueNumber}` : job.appName;
}

/** A tile's or a card's title: the name, and the request's own title when it has one. */
export function jobTitle(job: Named): string {
  const name = jobName(job);
  return !job.firstVersion && job.title ? `${name}: ${job.title}` : name;
}
