/**
 * The browse screen's rendered state (#1191 slice 6, conversion 3).
 *
 * ./browse.js keeps every decision it already made — the sort, the search
 * filter, the level derivation, the contributor cache, the fetches — and stops
 * making HTML. It pushes descriptors here; ./browse-list.tsx and
 * ./browse-detail.tsx render them.
 *
 * `level` moved in here too. _syncLevel() used to toggle `hidden` on
 * #browse-list-level, #browse-detail and #browse-search-bar from outside
 * React; those three nodes are rendered by ./browse-screen.tsx, so the toggle
 * is now a store field the component reads. (The SCREEN's own visibility is
 * still the shell's visibility-store — that is App._showOnlyScreen's business,
 * not this module's.)
 *
 * The initial value is the PRERENDER state: level 'list', nothing loaded. The
 * hand-written shell shipped #browse-list and #browse-empty empty, #browse-
 * empty and #browse-detail hidden, and #browse-list-level and the search bar
 * visible — which is exactly what these values render. Data loads in effects,
 * never here.
 */

import { createStore } from '../../lib/plain-store.js';

export const browseStore = createStore({
  /** 'list' | 'detail' — which of the two levels inside #browse-screen shows. */
  level: 'list',
  /** null until the first _renderList; else an array of row descriptors. */
  rows: null,
  /**
   * The "Open site" row's descriptor ({ href, label }) while the search text
   * is a web address (#5364), else null — so the prerender, which has no
   * query, renders no site row and hydration is silent.
   */
  site: null,
  curated: true,
  grouped: true,
  moreExpanded: false,
  /**
   * The #browse-empty line: null hides it, a string shows it. A separate field
   * from `rows` because the load-failure state has neither rows nor an empty
   * hint — it has `error`.
   */
  empty: null,
  /** True after a failed /api/apps read, while the list level is showing. */
  error: false,
  /** null until the detail level is entered; else a detail descriptor. */
  detail: null,
  /**
   * Which of Browse.SORTS orders the list (#1383). 'recommended' is the
   * PRERENDER value: the persisted choice and the ?sort= override are read on
   * screen entry (Browse._applyInitialSort), never during render — neither
   * localStorage nor location.search exists in the SSG pass, and a first
   * client render that disagreed with the prerendered markup is a hydration
   * console.error, which fails proposal checks.
   */
  sort: 'recommended',
  /**
   * Which chip is on: a key of Browse.FILTERS ('all' | 'featured' |
   * 'notjoined' | 'yours' | 'new') or, for an admin, of Browse.ADMIN_FILTERS.
   * 'all' is the PRERENDER value, for the same reason as `sort`: ?filter= and
   * the session's own choice are applied on screen entry
   * (Browse._applyInitialFilter), never during render.
   */
  filter: 'all',
  /**
   * Whether the admin-only chips (Browse.ADMIN_FILTERS) are drawn (#5267).
   * False is the PRERENDER value: who is viewing is known only after boot,
   * so the chip appears on screen entry, never in the first render.
   */
  adminFilters: false,
  /**
   * The "Filter by type" row (#3962): the type chips Browse.presentCategories
   * found ({ key, label } each), in order. Empty hides the whole row, and is
   * the PRERENDER value: which types the directory holds is known only once
   * /api/apps answers, so the row never appears in the first render.
   */
  categories: [],
  /** The pressed type chip: 'all' or a key of Browse.CATEGORIES. */
  category: 'all',
});
