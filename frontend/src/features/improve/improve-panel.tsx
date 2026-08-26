/**
 * #improve-panel — the one surface for everything you can do *to* the thing on
 * screen, rather than *with* it.
 *
 * It replaced the header's App/Dev segmented switch. An app is now just an app;
 * "Improve" is the second half. That reframing is what let three header icons
 * (the switch, the feedback bubble, the work cog) collapse into one button, and
 * it is why the rows below span what used to be four different places — the
 * feedback dialog, the Dev "+" menu, the cog drawer's session list and the
 * hamburger's Share row.
 *
 * ── A fully React-owned island ─────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes a node inside this subtree, so under
 * AGENTS.md's stateful-island rule the whole thing may hold state — and it
 * does, through ./improve-store.js. The classic scripts publish what the panel
 * is about via `window.Improve` (./improve-controller.js) and never touch the
 * DOM here.
 *
 * Two nodes are still handled the careful way, because the native kit writes
 * classes to the panel root at runtime (`platform-sheet-adopted`):
 * `#improve-panel`'s `className` is a CONSTANT prop rendered once, and the only
 * thing that varies on it is `data-open`, an attribute the kit never touches.
 *
 * ── Desktop side panel, mobile bottom sheet ────────────────────────────
 *
 * Both idioms come out of one element. The panel is always mounted and
 * translated off-screen; `data-open` slides it in. `public/css/app.css` draws it
 * from the RIGHT EDGE at `sm` and up and from the BOTTOM below it, so the
 * requirement holds even in a mobile browser with no native kit loaded. On touch
 * WITH the kit, `adoptKitSurface` presents this element as a real kit sheet with
 * its own drag-to-dismiss and `.platform-sheet-adopted` neutralises the fixed
 * chrome — the same contract the work drawer runs under.
 *
 * ── First render is the prerender ──────────────────────────────────────
 *
 * The store's initial value is the closed, empty, target-less panel, so the SSG
 * pass in frontend/scripts/build-shell.mjs emits exactly what hydration
 * produces. Sessions load from `Improve.open()`, never from render.
 */

import { useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

export function ImprovePanel() {
  const state = useStoreState(improveStore);
  const { open, target, name } = state;

  const close = useCallback(() => Improve.close(), []);

  // Everything below renders unconditionally — the panel is always mounted and
  // slid off-screen, never unmounted — so a closed panel is inert markup rather
  // than a tree React has to rebuild on every open.
  return (
    <>
      <div
        id="improve-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={close}
      >
      </div>
      {/* "this app" is wrong on home, where the target is the platform itself
          (#1367), so the label follows the target rather than assuming one.
          #improve-target-name inside the header spells out which app. */}
      <div
        id="improve-panel"
        role="dialog"
        aria-label={target === 'platform' ? 'Improve the platform' : 'Improve this app'}
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-2xl improve-panel-transition"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Improve
            </span>
            {/* The app's own name, so the panel says WHAT it is about — on the
                home screen that is the platform itself, which is the only cue
                telling you that "Improve" there means Social Vibecoding. */}
            <span
              id="improve-target-name"
              className="block text-xs text-zinc-500 dark:text-zinc-400 truncate"
            >
              {name}
            </span>
          </span>
          <button
            id="improve-close"
            type="button"
            className="text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 un-touch-target dark:text-zinc-400"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/*
            A COLUMN FLEX that does NOT scroll. Everything in this panel is a
            control, and every one of them is `shrink-0`, so the three actions
            stay on screen at any viewport — no measurement, no fold. The
            session list that used to push them off the bottom is the drawer's
            now (../app-context/app-context-rows.tsx), and the GitHub / version
            footer that sat below it has moved on too; only Share stayed, as an
            action rather than a reference row.
        */}
        <div
          id="improve-body"
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          {/*
              ── The Figma board's two primary actions ──────────────────

              "Give feedback — Share an idea or report a problem" and
              "Build a change — Describe what you want to change". Feedback
              first, deliberately: it is the one action that needs nothing of
              the viewer — no collaborator bit, no session, no repo.

              Both keep their ids: `#improve-row-feedback` is what the outbox
              dot's writer and the checks select on, and
              `#improve-row-new-session` keeps naming Improve.startSession()
              even though its label is the board's "Build a change" now.
          */}
          <div className="px-4 pt-3 pb-2 flex flex-col gap-3 shrink-0">
            {/* One line per action, always: the button label never wraps
                (whitespace-nowrap, no icon to steal width) and the
                description truncates rather than folding (owner review). */}
            <div className="flex items-center gap-3">
              <Button
                id="improve-row-feedback"
                type="button"
                size="sm"
                className="un-touch-target shrink-0 whitespace-nowrap"
                onClick={() => Improve.giveFeedback()}
              >
                Give feedback
              </Button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 min-w-0 truncate">
                Share an idea or report a problem
              </span>
            </div>
            {state.readOnly ? null : (
              <div className="flex items-center gap-3">
                <Button
                  id="improve-row-new-session"
                  type="button"
                  size="sm"
                  className="un-touch-target shrink-0 whitespace-nowrap"
                  onClick={() => Improve.startSession()}
                >
                  Build a change
                </Button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400 min-w-0 truncate">
                  Describe what you want to change
                </span>
              </div>
            )}
            {/*
                Third action, and deliberately last: sharing is the one thing
                here that changes nothing about the app. It was a drawer row
                until the board took the drawer down to navigation and work —
                and a row labelled "Share app" sitting under the app's version
                lines never read as an action anyway. `canShare` is already on
                this store (App.ImproveStatus.setAppOpen publishes it: a running
                app with a real URL), so the gate is the same one the drawer
                used, and #improve-row-share keeps its id.
            */}
            {state.canShare ? (
              <div className="flex items-center gap-3">
                <Button
                  id="improve-row-share"
                  type="button"
                  size="sm"
                  variant="neutral"
                  ink="neutral"
                  className="un-touch-target shrink-0 whitespace-nowrap"
                  onClick={() => Improve.share()}
                >
                  Share app
                </Button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400 min-w-0 truncate">
                  Send someone a link to the live app
                </span>
              </div>
            ) : null}
            {/*
                The transitional App/Feed/Kanban toggle is gone (Streamlined
                Concept, final step): the app-context sheet's rows are the
                navigation between views, and the Board draws its own
                Kanban|Feed control (dev-board/board-frame.tsx).
            */}
          </div>
        </div>
      </div>
    </>
  );
}
