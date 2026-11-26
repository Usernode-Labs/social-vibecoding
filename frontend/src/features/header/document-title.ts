/**
 * THE BROWSER TAB'S TITLE ON A PROJECT'S PAGES (request #7164, point 7).
 *
 * ./document-title-model.ts says what the title is; this reads the stores it
 * needs and writes `document.title`. `App.setHeaderTitle()` in
 * public/js/app.js stays the writer on every other screen and asks `named()`
 * here first, so a title set while a project's page is up does not put the
 * header's stale text back. Between those calls the stores move on their own
 * (a place is picked, Back is pressed, a request's row arrives), and each
 * move runs `sync`.
 *
 * It writes only where it has a title of its own, and once more to hand the
 * tab back to the header's text when the person leaves: the signed-out pages
 * and the waitlist set their own titles, and nothing here touches them.
 * The header's visible text is not changed by any of this.
 */

import { i18n, t } from '../../lib/i18n/runtime';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { livePlace, placeStore } from '../dev-board/workshop/place-store';
import { placeName, placeTitleHandle } from '../dev-board/workshop/places';
import { topicHeadStore } from '../dev-board/topic/topic-store';
import { pageTitle, type TitleWords } from './document-title-model';

const words: TitleWords = {
  place: (project, place) => t('shell:docTitle.place', { project, place }),
  item: (title, project) => t('shell:docTitle.item', { title, project }),
};

/** The unread count Notifications._updateTitle puts before the title. */
const UNREAD_PREFIX = /^\(\d+\+?\)\s*/;

/** Whether the tab's title is one this module wrote. */
let owned = false;

function placeWords(slug: string | null): string {
  const { slug: mounted, place } = placeStore.get();
  if (!slug || mounted !== slug) return '';
  // Never a channel left over from another community (#5683).
  const shown = livePlace(slug, place);
  const handle = placeTitleHandle(shown);
  return handle ? `#${handle}` : placeName(shown);
}

/** The title this page names itself with, or null where the header's text is it. */
export function named(): string | null {
  const improve = improveStore.get();
  const topic = topicHeadStore.get();
  const title = pageTitle({
    screen: navStore.get().screen || null,
    slug: improve.slug || null,
    name: improve.name || '',
    tab: improve.tab || null,
    subTab: improve.subTab || null,
    boardView: improve.boardView || null,
    placeSlug: placeStore.get().slug,
    place: placeWords(improve.slug || null),
    topicSlug: topic.slug || null,
    topicTitle: topic.title || '',
    topicLoading: !!topic.loading,
  }, words);
  owned = !!title;
  return title;
}

function headerText(): string {
  const { text, subtitle } = headerTitleStore.get();
  return subtitle ? `${text} · ${subtitle}` : text;
}

function write(title: string): void {
  if (!title || document.title.replace(UNREAD_PREFIX, '') === title) return;
  document.title = title;
  // The assignment dropped the "(3) " unread prefix: let it come back.
  const w = window as unknown as { Notifications?: { _updateTitle?: () => void } };
  try { w.Notifications?._updateTitle?.(); } catch { /* the title stands without its count */ }
}

function sync(): void {
  const was = owned;
  const title = named();
  if (title) write(title);
  else if (was) write(headerText());
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  improveStore.subscribe(sync);
  navStore.subscribe(sync);
  placeStore.subscribe(sync);
  topicHeadStore.subscribe(sync);
  // The place's words and the pattern are catalog text.
  try { i18n.on('languageChanged', sync); } catch { /* the next move retitles */ }
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.documentTitle = { named };
}
