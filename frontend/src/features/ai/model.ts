/**
 * The AI tab's main view (#6019 follow-up), its pure part: what each list
 * holds and what each row says. ./index.tsx draws it.
 *
 *   Your work   what needs you first (the Needs you feed, GET
 *               /api/workshop/needs-feed), each with one pill for what you
 *               owe; then your private threads, with a lock on the tile; then
 *               yours waiting on someone, saying where each stands.
 *   Up next     yours moving without you, soonest first (GET /api/ai/work).
 *   Live        yours that went live this week, folded.
 *
 * A row's words are phrases (an id and its values), translated where they
 * are drawn, so this module needs no i18n runtime and its tests read it bare.
 */

export interface AiApp {
  slug: string;
  name: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
}

export interface AiPrivate {
  rootId: number;
  title: string;
  kind: string;
  app: AiApp | null;
  at: string | null;
}

export interface AiThread {
  threadId: number;
  number: number | null;
  kind: string;
  title: string | null;
  app: AiApp | null;
  change: { id: number; number: number | null } | null;
  href: string;
  group: 'next' | 'waiting' | 'live';
  what: 'going_live' | 'merging' | 'vote' | 'building' | 'not_picked_up' | 'live';
  at: string | null;
  quietDays?: number;
}

export interface AiWork {
  private: AiPrivate[];
  next: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
}

/** One card of the Needs you feed, as much of it as a row needs. */
export interface NeedItem {
  kind: string;
  id: number;
  number?: number | null;
  title?: string | null;
  app?: AiApp | null;
  href?: string | null;
}

export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

/** Who is in a thread, drawn on its tile: everyone in its community, only you inside one, or only you. */
export type Who = 'all' | 'me' | 'solo';

export interface WorkRow {
  key: string;
  title: string;
  app: AiApp | null;
  who: Who;
  sub: Phrase;
  /** What you owe, on the row's one pill. */
  pill: Phrase | null;
  /** Where the row goes: a page, or a private thread of Main. */
  href: string | null;
  rootId: number | null;
}

/** How many rows of Your work, and of Up next, show before Show more. */
export const WORK_FIRST = 8;
export const NEXT_FIRST = 4;

const PILLS: Record<string, string> = {
  proposal: 'messages:ai.pill.vote',
  governance: 'messages:ai.pill.vote',
  ballot: 'messages:ai.pill.pick',
  question: 'messages:ai.pill.answer',
  bot_question: 'messages:ai.pill.answer',
  plan: 'messages:ai.pill.buildIt',
};

/** Pure: the page a Needs you card is decided on. */
export function needHref(item: NeedItem): string | null {
  if (item.href) return item.href;
  const slug = item.app?.slug;
  if (!slug) return null;
  const app = encodeURIComponent(slug);
  if (item.kind === 'governance') return `#app/${app}/dev/governance/${Number(item.id)}`;
  if (item.number) {
    return item.kind === 'proposal' || item.kind === 'ballot'
      ? `#app/${app}/dev/changes/${Number(item.number)}`
      : `#app/${app}/dev/issues/${Number(item.number)}`;
  }
  return `#app/${app}/workshop`;
}

function where(app: AiApp | null, number: number | null | undefined): Record<string, string | number> {
  return { project: app?.name || app?.slug || '', number: number || '' };
}

/** Pure: Your work, in order: what needs you, your private threads, then yours waiting on someone. */
export function yourWork(needs: NeedItem[] | null, work: AiWork | null): WorkRow[] {
  const rows: WorkRow[] = [];
  const owed = new Set<string>();
  for (const item of needs || []) {
    const app = item.app || null;
    if (app && item.number) owed.add(`${app.slug}#${item.number}`);
    rows.push({
      key: `need:${item.kind}:${item.id}`,
      title: item.title || '',
      app,
      who: 'all',
      sub: item.number
        ? { id: 'messages:ai.row.where', values: where(app, item.number) }
        : { id: 'messages:ai.row.project', values: where(app, null) },
      pill: { id: PILLS[item.kind] || 'messages:ai.pill.needsYou' },
      href: needHref(item),
      rootId: null,
    });
  }
  for (const p of work?.private || []) {
    rows.push({
      key: `private:${p.rootId}`,
      title: p.title,
      app: p.app,
      who: p.app ? 'me' : 'solo',
      sub: p.app
        ? { id: 'messages:ai.row.privateDraft', values: { project: p.app.name || p.app.slug } }
        : { id: 'messages:ai.row.privateIdea' },
      pill: null,
      href: null,
      rootId: p.rootId,
    });
  }
  for (const t of work?.waiting || []) {
    // A thread whose vote you owe is already the Needs you row above.
    if (t.app && t.number && owed.has(`${t.app.slug}#${t.number}`)) continue;
    rows.push({
      key: `waiting:${t.threadId}`,
      title: t.title || '',
      app: t.app,
      who: 'all',
      sub: t.quietDays
        ? { id: 'messages:ai.row.quiet', values: { ...where(t.app, t.number), count: t.quietDays } }
        : { id: 'messages:ai.row.notPickedUp', values: where(t.app, t.number) },
      pill: null,
      href: t.href,
      rootId: null,
    });
  }
  return rows;
}

const NEXT_WORDS: Record<string, string> = {
  going_live: 'messages:ai.next.goingLive',
  merging: 'messages:ai.next.merging',
  vote: 'messages:ai.next.vote',
  building: 'messages:ai.next.building',
};

/** Pure: one Up next row's second line: its project, and what happens next. */
export function nextWords(t: AiThread): Phrase {
  return { id: NEXT_WORDS[t.what] || 'messages:ai.next.vote', values: where(t.app, t.number) };
}

/** Pure: the hero's line under the bot's name: what needs you, what is up next. */
export function heroWords(needs: number, next: number): Phrase {
  if (needs > 0) return { id: 'messages:ai.hero.both', values: { needs, next } };
  return { id: 'messages:ai.hero.next', values: { next } };
}
