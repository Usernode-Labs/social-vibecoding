// The browse-all-apps screen (#apps) as a React island — #1083 chunk F step 1.
//
// Like every island so far this is a STATIC subtree: the markup below is the
// hand-written shell's #browse-screen character for character (same ids, class
// strings, `hidden` semantics), and ./browse.js still owns every node inside
// #browse-list / #browse-empty / #browse-detail through innerHTML. What the
// island changes is ownership of the *frame*: the two search-bar controls and
// the three hosts are rendered here instead of being parsed out of
// public/index.html, and the module that fills them is a bundle import rather
// than a classic <script>.
//
// Nothing here is stateful, deliberately. Making the row list a React list
// would mean React reconciling over DOM that browse.js writes — the exact
// thing the stateful-islands rule forbids — so the conversion that matters
// (rows as components) waits until the module's render path moves inside
// React. This step's job is the seam and the shared app-card component.
//
// Visibility comes from the store rather than a `hidden` class this component
// owns: App._showOnlyScreen publishes (screenId, visible) for every id in
// App.REACT_SCREEN_IDS, and useVisibilityHiddenClass writes the class
// synchronously inside that notification, because _showOnlyScreen runs inside
// PlatformUI.transition(fn) and the native kit snapshots the DOM before fn
// returns. `false` is the shipped state: the shell ships this screen hidden.

import { useRef } from 'react';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import './browse.js';

export function BrowseScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'browse-screen', false);

  return (
    <main
      ref={screenRef}
      id="browse-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
    >
      <div id="browse-search-bar" className="sticky top-0 z-20 px-3 pt-3 pb-2 bg-white dark:bg-zinc-950">
        <div className="relative max-w-xl">
          <svg
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            id="browse-search-input"
            type="text"
            autoComplete="off"
            placeholder="Search all apps…"
            aria-label="Search all apps"
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
          />
          <button
            id="browse-search-clear"
            className="hidden absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none"
            title="Clear search"
            aria-label="Clear search"
          >
            &times;
          </button>
        </div>
      </div>
      {/*
          Level 1: the app-store list. ONE row markup, two layouts, and the
          switch is pure CSS — no matchMedia, no re-render on resize.
          Narrow: a hairline-divided vertical list of full-width rows (the
          App Store idiom). md and up: a 2/3-column grid whose rows pick up
          a bordered-box treatment from .browse-row in app.css.
      */}
      <div id="browse-list-level">
        {/*
            Grid only. Every border — the phone hairline AND the desktop box —
            is .browse-row in app.css; a divide-* utility here would win the
            cascade against it and strip the boxes' top/bottom edges.
        */}
        <div id="browse-list" className="md:grid md:grid-cols-2 lg:grid-cols-3 md:gap-3 md:p-3">
        </div>
        <div id="browse-empty" className="hidden px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400">
        </div>
      </div>
      {/*
          Level 2: the per-app detail page (#apps/<slug>). Absorbs what the
          browse rows' "…" menu used to offer — see Browse._renderDetail.
      */}
      <div id="browse-detail" className="hidden max-w-2xl mx-auto p-4">
      </div>
    </main>
  );
}
