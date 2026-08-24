/**
 * #improve-panel — the one surface for everything you can do *to* the thing on
 * screen, rather than *with* it.
 *
 * It replaced the header's App/Dev segmented switch. An app is now just an app;
 * "Improve" is the second half. That reframing is what let three header icons
 * (the switch, the feedback bubble, the work cog) collapse into one button, and
 * it is why the rows below span what used to be four different places — the
 * feedback dialog, the Dev "+" menu, the cog drawer's session list and the
 * hamburger's GitHub / Share / version footer.
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

import { useCallback, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  ChatIcon,
  PlusIcon,
  XIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { ImproveViewToggle } from './view-toggle';

const ROW_CLASS =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

const ROW_LABEL_CLASS = 'text-sm font-medium flex-1 min-w-0 truncate';

/**
 * One tappable row.
 *
 * Rendered as a `<button>` rather than an `<a>` unless an `href` is given: the
 * navigating rows go through `App`'s router so the panel can dismiss itself
 * first, and only the two genuinely external destinations (the repo, a shared
 * link) are real anchors.
 */
function ImproveRow({
  id,
  icon,
  label,
  detail,
  onClick,
  href,
  external,
}: {
  id?: string;
  icon: ReactNode;
  label: string;
  detail?: ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}) {
  const body = (
    <>
      {icon}
      <span className={ROW_LABEL_CLASS}>{label}</span>
      {detail}
    </>
  );
  if (href) {
    return (
      <a
        id={id}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className={ROW_CLASS}
        onClick={() => Improve.dismissForNav()}
      >
        {body}
      </a>
    );
  }
  return (
    <button id={id} type="button" className={ROW_CLASS} onClick={onClick}>
      {body}
    </button>
  );
}

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
            A COLUMN FLEX, so #improve-footer can be bottom-anchored with
            `mt-auto` (#1367): the version, GitHub and Share block hugs the
            foot of the panel whenever the rows above it leave free space, and
            degrades to "just at the end of the scroll" when they do not — a
            long session list, a short viewport, the kit sheet. One rule, both
            behaviours, no measurement, and the same trick the hamburger's own
            footer used before those rows moved here.
        */}
        {/*
            A COLUMN FLEX that does NOT scroll. Everything in this panel is a
            control except the session list, and the list was the thing
            pushing the controls off the bottom: with a handful of sessions
            running, "Start a new session", "Developer terminal" and the
            GitHub / Share / version footer all sat below the fold behind a
            scroll. The list flexes and scrolls inside itself now (see the
            wrapper below); every control is `shrink-0` and stays on screen.

            `platform-safe-scroll` moves onto the scroller with the scrolling.
        */}
        <div
          id="improve-body"
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          {/*
              ── The two controls at the top (#1367) ────────────────────

              Feedback first, and deliberately: it is the one action that needs
              nothing of the viewer — no collaborator bit, no session, no repo.
              Everything below it asks for progressively more.

              It is a BUTTON now rather than a list row. The panel is a stack of
              rows that all look alike, and the one thing here that every
              viewer can always do looked exactly like the six they mostly
              cannot. Same handler, same id — `#improve-row-feedback` is what
              the dot's writer and the checks select on — only the chrome
              changed.
          */}
          <div className="px-4 pt-3 pb-2 flex flex-col gap-2 shrink-0">
            <Button
              id="improve-row-feedback"
              type="button"
              layout="fullIconRow"
              size="sm"
              className="un-touch-target"
              onClick={() => Improve.giveFeedback()}
            >
              <ChatIcon className="w-4 h-4 shrink-0" />
              Give feedback
            </Button>
            {/*
                The App / Feed / Kanban toggle, directly under it. `sm:hidden`
                lives on the component: on a wide screen this copy steps aside
                and the header's takes over, immediately left of #improve-btn.
                See ./view-toggle.tsx for why both are always rendered.
            */}
            <ImproveViewToggle compact={false} />
          </div>

          {/*
              THE SESSION SECTIONS AND THE REFERENCE FOOTER ARE GONE
              (Streamlined Concept): both moved to the app-context sheet
              behind the header's "app name ⌄" tab —
              features/app-context/app-context-sheet.tsx — which is the
              app's own surface now. What stays here is what Improve IS:
              feedback, and starting a change.
          */}
          <div className="shrink-0">
            {state.readOnly ? null : (
              <ImproveRow
                id="improve-row-new-session"
                icon={<PlusIcon className="w-5 h-5 shrink-0" />}
                label="Start a new session"
                onClick={() => Improve.startSession()}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
