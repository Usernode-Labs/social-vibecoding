/**
 * The Homeroom bot tab's filter, in its address (5 Nov 2026). The project
 * chips narrow every list on the page to some projects' work, and the page
 * is the desk for everything of yours, so other pages link to it narrowed:
 * a project's Workshop and its Hub open
 *
 *   #homeroom-bot?project=<slug>          that project's work
 *   #homeroom-bot/history                 the History card (./lists.tsx)
 *   #homeroom-bot/history?kind=vote       History, one kind of work
 *   …?project=a,b                         several projects
 *
 * The query rides on whichever place in the tab the address names (Main, a
 * thread, an item in the column), so the column's own address changes keep
 * it (index.tsx showAddress). The router splits the query off before it
 * reads the path (public/js/app.js), so every existing address parses as it
 * did. Pure: no window, no React.
 */

/** History's kinds, as GET /api/ai/history takes them (services/ai-history.js). */
export type HistoryKind = 'change' | 'request' | 'vote' | 'solo';
export const HISTORY_KINDS: readonly HistoryKind[] = ['change', 'request', 'vote', 'solo'];

const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/i;

function queryOf(hash: string | null | undefined): URLSearchParams {
  const raw = String(hash || '');
  const at = raw.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : raw.slice(at + 1));
}

function pathOf(hash: string | null | undefined): string {
  const raw = String(hash || '');
  const at = raw.indexOf('?');
  return at === -1 ? raw : raw.slice(0, at);
}

/** Whether `hash` is one of the tab's own addresses. */
export function isBotTabHash(hash: string | null | undefined): boolean {
  return /^#?(homeroom-bot|ai)(\/|\?|$)/.test(String(hash || ''));
}

/** Pure: the projects the address narrows the lists to, once each, in its order. */
export function projectsOf(hash: string | null | undefined): string[] {
  if (!isBotTabHash(hash)) return [];
  const out: string[] = [];
  for (const value of queryOf(hash).getAll('project')) {
    for (const slug of value.split(',')) {
      const s = slug.trim();
      if (SLUG.test(s) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Pure: the kind the address narrows History to, or null for all of it. */
export function kindOf(hash: string | null | undefined): HistoryKind | null {
  if (!isBotTabHash(hash)) return null;
  const kind = queryOf(hash).get('kind');
  return (HISTORY_KINDS as readonly string[]).includes(String(kind)) ? kind as HistoryKind : null;
}

/** Pure: whether the address asks for the History card. */
export function historyAsked(hash: string | null | undefined): boolean {
  if (!isBotTabHash(hash)) return false;
  const parts = pathOf(hash).replace(/^#/, '').split('/');
  return parts[1] === 'history';
}

/**
 * Pure: `href` (one of the tab's addresses) carrying the filter: the
 * projects, and History's kind when there is one. With neither, the bare
 * address.
 */
export function withFilter(href: string, filter: { projects?: readonly string[]; kind?: HistoryKind | null }): string {
  const path = pathOf(href);
  const query = new URLSearchParams();
  const projects = (filter.projects || []).filter((slug) => SLUG.test(slug));
  if (projects.length) query.set('project', projects.join(','));
  if (filter.kind && (HISTORY_KINDS as readonly string[]).includes(filter.kind)) query.set('kind', filter.kind);
  const qs = query.toString().replace(/%2C/gi, ',');
  return qs ? `${path}?${qs}` : path;
}

/** Pure: the tab narrowed to one project, as a project's Workshop and Hub link to it. */
export function projectTabAddress(slug: string): string {
  return withFilter('#homeroom-bot', { projects: [slug] });
}

/** Pure: the History card, narrowed to a kind (Me's old Your work rows). */
export function historyAddress(kind: HistoryKind | null = null, projects: readonly string[] = []): string {
  return withFilter('#homeroom-bot/history', { projects, kind });
}
