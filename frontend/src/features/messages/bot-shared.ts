import { t } from '../../lib/i18n/runtime';
import type { ConversationMessage, HomeroomBotActivityOutcome, HomeroomBotJob, HomeroomBotMeta, HomeroomBotWork } from './types';

/*
 * What the Homeroom bot's activity tray (./bot-work.tsx), its activity cards
 * (./bot-activity.tsx) and its plan layout (./bot-plan.tsx) all need: how a
 * piece of work is named, the window event that says the bot's work moved
 * on, and the request a bot message is about. A module of its own so they can share it without
 * importing each other. It imports types and the message runtime only, and
 * reads a message's metadata inline — the other modules' own rule.
 */

/*
 * ── Threads in the chat with Homeroom bot ──────────────────────────────
 * Every request the bot works on for someone has one story: an activity
 * card in their chat with the bot, which is the root of that request's own
 * reply thread (services/homeroom-bot-activity.js). Its quiet step lines,
 * questions, plan, answers and ending are replies in that thread. (14 Nov
 * 2026: the four moments that ring were also listed in Main Chat, under a
 * "↳ in {request} · {project}" label, by an `alsoInChat` stamp. There is no
 * Main Chat to list them in, nothing writes the stamp, and nothing here
 * reads it.)
 *
 * A direct chat between people keeps no threads (#2387): a thread is how a
 * room keeps a side conversation out of everyone's way, and a DM has no one
 * else in it. The chat with the bot is the one exception, because there each
 * request is its own conversation. `threadsAllowed` is the one place that
 * says so on the client (the row's thread menu, the composer, the store).
 */

/** Whether a conversation can carry reply threads: a room, or the viewer's chat with Homeroom bot. */
export function threadsAllowed(conversation: { kind?: string; homeroomBot?: boolean } | null | undefined): boolean {
  if (!conversation) return false;
  return conversation.kind !== 'direct' || conversation.homeroomBot === true;
}

/**
 * Whether a message is a position in the main stream, as the server counts
 * unread and moves the read cursor: a message of the conversation itself,
 * never a reply in one of its threads.
 */
export function inMainStream(message: { threadRootId?: number | null }): boolean {
  return !message.threadRootId;
}

/** What a request's thread is called, from any of its messages' metadata. */
export interface BotRequestNames {
  /** The project's name (or the stand-in for one nobody can name). */
  project: string;
  /** The request's own title, when it has one; null for a first version. */
  title: string | null;
  /** Its number on the project's board, when known. */
  number: number | null;
  firstVersion: boolean;
}

type RequestMeta = Pick<HomeroomBotMeta, 'appName' | 'appSlug' | 'issueNumber' | 'issueTitle' | 'firstVersion' | 'requestTitle'>;

/** Pure: the names a request's thread goes by, from a bot message's metadata. */
export function botRequestNames(meta: RequestMeta | null | undefined): BotRequestNames {
  const project = meta?.appName || meta?.appSlug || t('messages:bot.job.unnamedProject');
  const firstVersion = !!meta?.firstVersion;
  const title = firstVersion ? null : (meta?.requestTitle || meta?.issueTitle || null);
  const number = meta?.issueNumber && meta.issueNumber > 0 ? meta.issueNumber : null;
  return { project, title, number, firstVersion };
}

/** "Dark mode", "Plant Pal first version", "Request #12": a request's thread by its own name. */
export function botThreadTitle(names: BotRequestNames): string {
  if (names.firstVersion) return t('messages:bot.job.firstVersion', { project: names.project });
  if (names.title) return names.title;
  return names.number ? t('messages:bot.activity.requestNumber', { number: String(names.number) }) : names.project;
}

/** public/js/app.js dispatches this on `homeroom_bot_work_changed` and on a socket reconnect. */
export const WORK_CHANGED_EVENT = 'homeroom-bot-work-changed';

/**
 * #4227: the endings that are still moving, drawn with the working card's
 * spinner (./bot-activity.tsx) and read again like work that is going: a
 * change being checked before it is offered, and one going live.
 */
export const SPINNING_OUTCOMES: ReadonlySet<HomeroomBotActivityOutcome> = new Set(['checking', 'going_live']);

/**
 * `appUnnamed`: `appName` is the stand-in for a project nobody can name. The
 * names below then use their unnamed wording, and never take the stand-in as
 * a project's name.
 */
type Named = Pick<HomeroomBotJob, 'appName' | 'appUnnamed' | 'issueNumber' | 'title' | 'firstVersion'>;

/** "Ear Trainer first version", "Ear Trainer #12": what the header's status line names. */
export function jobName(job: Named): string {
  if (job.appUnnamed) {
    if (job.firstVersion) return t('messages:bot.job.firstVersionUnnamed');
    return job.issueNumber ? t('messages:bot.job.requestUnnamed', { number: job.issueNumber }) : job.appName;
  }
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
  if (job.appUnnamed) {
    return job.issueNumber
      ? t('messages:bot.job.requestTitledUnnamed', { number: job.issueNumber, title: job.title })
      : t('messages:bot.job.titledUnnamed', { title: job.title });
  }
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
  const match = /^#app\/([^/?#]+)\/(?:workshop|dev\/hub)$/.exec(String(target || ''));
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

/**
 * Pure: which change a bot message is about, as "app#number", or null for
 * anything that is not the bot's own live message about one request: a
 * person's message, a deleted one, one still sending, or bot words about
 * the project alone (no request number). A first version carries request
 * number 1 under its own project, so its messages group by project, which
 * is how a first version's plans are ordered (./bot-plan.tsx planLayout).
 */
export function changeKey(message: ConversationMessage): string | null {
  if (!message.sender.bot || message.deleted || !(message.id > 0)) return null;
  const meta = message.metadata?.homeroomBot;
  if (!meta || typeof meta !== 'object') return null;
  const n = Number(meta.issueNumber);
  if (!Number.isInteger(n) || n <= 0) return null;
  const app = meta.appSlug || meta.appName;
  return app ? `${app}#${n}` : null;
}

/**
 * Pure: the project's icon as the strip has it. A bot message names its
 * project but carries no artwork, so a project's card at the head of a
 * message (./bot-head-card.tsx) takes its requests' tracks', so the chat
 * shows the project's own icon; with none, the card draws its glyph.
 */
export function newsIcon(work: HomeroomBotWork | null, slug: string | null | undefined, name: string | null | undefined = null): { iconUrl: string | null; iconEmoji: string | null } {
  if (work && (slug || name)) {
    for (const job of work.tracks) {
      // A project with no slug (the staging demo's) is known by its name.
      const same = slug ? job.appSlug === slug : !job.appSlug && job.appName === name;
      if (same && (job.iconUrl || job.iconEmoji)) return { iconUrl: job.iconUrl, iconEmoji: job.iconEmoji };
    }
  }
  return { iconUrl: null, iconEmoji: null };
}
