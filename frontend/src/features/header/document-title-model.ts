/**
 * WHAT THE BROWSER TAB SAYS (request #7164, point 7). Pure: no store, no
 * catalog, so the root suite can run it (tests/document-title.test.js).
 *
 * The tab's title used to be the header's text and nothing else
 * (`App.setHeaderTitle`). A project's page and a request's page set no header
 * text of their own, since the header there draws the project from the
 * Improve store, so the tab kept the name of the screen the person came from:
 * "Communities" on every place of a project, "Homeroom" on a request.
 *
 * `pageTitle` answers with the title for those pages, or null where the
 * header's text is already the page's name (Home, Messages, Settings, an app
 * running in its frame, ...), which ./document-title.ts then leaves alone.
 */

export interface TitleFacts {
  /** The screen root on show (navStore.screen). */
  screen: string | null;
  /** The project the app view is on, its name, and which half and sub-view. */
  slug: string | null;
  name: string;
  tab: string | null;
  subTab: string | null;
  /** The board's layout: the project page (places) or the Kanban board. */
  boardView: string | null;
  /** The project page that is mounted, and the place it shows, as words. */
  placeSlug: string | null;
  place: string;
  /** The opened request, change or decision: whose it is, and its title. */
  topicSlug: string | null;
  topicTitle: string;
  topicLoading: boolean;
}

export interface TitleWords {
  /** "Plant Pal · Workshop". */
  place: (project: string, place: string) => string;
  /** "Add a watering reminder · Plant Pal". */
  item: (title: string, project: string) => string;
}

/** A request's title is a sentence somebody typed: the tab gets its start. */
export const ITEM_TITLE_MAX = 60;

export function trimItemTitle(title: string, max = ITEM_TITLE_MAX): string {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function pageTitle(facts: TitleFacts, words: TitleWords): string | null {
  if (facts.screen !== 'app-view' || facts.tab !== 'dev') return null;
  const project = String(facts.name || '').trim();
  if (!facts.slug || !project) return null;
  if (facts.subTab === 'topic') {
    const title = !facts.topicLoading && facts.topicSlug === facts.slug
      ? trimItemTitle(facts.topicTitle) : '';
    return title ? words.item(title, project) : project;
  }
  if (facts.subTab === 'forum' && facts.boardView !== 'kanban'
    && facts.placeSlug === facts.slug && facts.place) {
    return words.place(project, facts.place);
  }
  return project;
}
