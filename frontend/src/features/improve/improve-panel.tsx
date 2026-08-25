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
  GitHubIcon,
  PlusIcon,
  ShareIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { NativeAppVersionRow } from '../header/native-app-version-row';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { ImproveViewToggle } from './view-toggle';

const ROW_CLASS =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

const ROW_LABEL_CLASS = 'text-sm font-medium flex-1 min-w-0 truncate';

const SECTION_LABEL_CLASS =
  'px-4 pt-3 pb-1 text-[0.7rem] font-semibold '
  + 'text-zinc-500 dark:text-zinc-400';

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

/** A session row — the compact shape the cog drawer used, minus the app column. */
function SessionRow({
  session,
  showApp,
}: {
  session: {
    id: number;
    appSlug: string | null;
    appName: string;
    title: string;
    status: string | null;
    busy: boolean;
  };
  showApp: boolean;
}) {
  return (
    <a
      href={`#app/${session.appSlug}/dev/sessions/${session.id}`}
      className="flex items-center gap-2 px-4 min-h-[44px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
      onClick={() => Improve.dismissForNav()}
    >
      {/* The busy dot is the whole reason a session row is worth scanning:
          it says an AI turn is in flight right now. Pulsing only while busy —
          a static dot on every row would say nothing. */}
      <span
        className={
          session.busy
            ? 'w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse'
            : 'w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0'
        }
        aria-hidden="true"
      />
      {showApp ? (
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[35%] truncate">
          {session.appName}
        </span>
      ) : null}
      <span className="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">
        {session.title}
      </span>
      {session.status ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          {session.status}
        </span>
      ) : null}
    </a>
  );
}

export function ImprovePanel() {
  const state = useStoreState(improveStore);
  const { open, target, slug, name, sessions, otherSessions } = state;

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
        <div
          id="improve-body"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll flex flex-col"
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
              THE MIDDLE BLOCK, in one `shrink-0` wrapper.

              #improve-body is a column flex now (so the footer can hug the
              bottom), and a flex item is shrinkable by default: once the rows
              here overflow the panel they would compress to fit instead of
              handing the overflow to the scroller. Most of what is inside is
              text, whose `min-height: auto` already refuses to shrink — but
              the session rows carry an explicit `min-h-[44px]`, which REPLACES
              that floor and is exactly the kind of thing that squeezes a
              44px tap target down on a short viewport. One wrapper settles it
              for everything between the header controls and the footer.

              A wrapper and not `shrink-0` on each row, because the footer has
              to stay a DIRECT child of #improve-body: dapp.json checks
              `#improve-body > #improve-footer > #improve-row-github`, and
              `mt-auto` only anchors against the flex container it is a child
              of.
          */}
          <div className="shrink-0">
          <div className={SECTION_LABEL_CLASS}>Sessions</div>
          {state.loadingSessions && !state.sessionsLoaded ? (
            <div className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              Loading…
            </div>
          ) : null}
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} showApp={false} />
          ))}
          {state.sessionsLoaded && sessions.length === 0 ? (
            <div
              id="improve-sessions-empty"
              className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400"
            >
              No sessions running on this app.
            </div>
          ) : null}
          {state.readOnly ? null : (
            <ImproveRow
              id="improve-row-new-session"
              icon={<PlusIcon className="w-5 h-5 shrink-0" />}
              label="Start a new session"
              onClick={() => Improve.startSession()}
            />
          )}

          {/*
              THE "DEVELOPMENT" SECTION'S TWO NAVIGATION ROWS ARE GONE (#1367).

              `#improve-row-kanban` and `#improve-row-feed` were list rows with
              a chevron — "Development kanban" and "Latest development
              activity" — and they are the App/Feed/Kanban toggle at the top of
              this panel now. Three mutually exclusive views of one app, one of
              them always current, is a segmented control rather than two
              one-way links; and as links they could say where to GO but never
              where you WERE, which is why following one left no way back to
              the app. Improve.openDev(mode) is unchanged and is still what the
              two segments call.

              The heading went with them: the terminal below is the only row
              left under it, and a section label over a single conditional row
              is a heading that vanishes.
          */}
          {/* The developer terminal — the header's #dev-console-btn, as a row.
              Shown on exactly the signal that used to show that button: an app
              iframe is on screen and the console has something to attach to. */}
          {state.showTerminal ? (
            <ImproveRow
              id="improve-row-terminal"
              icon={<TerminalIcon className="w-5 h-5 shrink-0" />}
              label="Developer terminal"
              onClick={() => Improve.openTerminal()}
            />
          ) : null}

          {/* The overflow area: sessions running on OTHER apps. Rendered only
              when there are any, so the common case — one app, one session —
              never pays for a heading it does not need. */}
          {otherSessions.length > 0 ? (
            <>
              <div className={SECTION_LABEL_CLASS}>Running on your other apps</div>
              {otherSessions.map((session) => (
                <SessionRow key={session.id} session={session} showApp={true} />
              ))}
            </>
          ) : null}

          </div>

          {/*
              `mt-auto` (#1367) — the version, GitHub and Share block is pinned
              to the FOOT of the panel whenever the rows above it leave free
              space, which on a tall desktop sidebar with one session is most
              of it. #improve-body is the column flex that makes it work; when
              the rows DO fill the panel there is no free space to collect and
              this degrades to "at the end of the scroll", exactly as before.
              `mt-2` stays as the floor so the border never crowds the row
              above it in that case.
          */}
          <div
            id="improve-footer"
            className="mt-auto shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800"
          >
            {state.repoUrl ? (
              <ImproveRow
                id="improve-row-github"
                icon={<GitHubIcon className="w-5 h-5 shrink-0" />}
                label="View on GitHub"
                href={state.repoUrl}
                external={true}
              />
            ) : null}
            {state.canShare ? (
              <ImproveRow
                id="improve-row-share"
                icon={<ShareIcon className="w-5 h-5 shrink-0" />}
                label="Share app"
                onClick={() => Improve.share()}
              />
            ) : null}
            {/* Versions last, and as text rather than rows: they are the things
                here you read instead of act on. `slug` gates the app's own so a
                target-less panel never renders a dangling label. */}
            {slug ? (
              <div
                id="improve-row-version"
                className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400"
              >
                <span>Version</span>
                <span
                  id="improve-version-value"
                  className="ml-auto font-mono truncate"
                >
                  {state.deploying ? 'deploying…' : state.version || 'unknown'}
                </span>
              </div>
            ) : null}
            {/*
                THE THREE ROWS BELOW CAME FROM #drawer-footer, ids and renderers
                intact, because every one of them is a fact about the platform
                or the open app rather than a navigation action — which is what
                the hamburger is for now.

                They are rendered here as CONSTANT markup with empty slots: the
                modules that fill them (App.loadVersion,
                features/header/native-app-version.js, AppView.renderForkBadge)
                all resolve their slot by getElementById and toggle `hidden` on
                the row, so only the parent changed. `.drawer-ver-row` keeps its
                name for the same reason — app.css draws all three off it, and
                renaming would be a restyle rather than a move.

                DrawerStatus.refreshDeployDot() reads the deploying pill out of
                whichever of these is painted, which is why the amber dot on the
                hamburger still lights when a deploy is in flight.
            */}
            <div id="drawer-row-platform-version" className="drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                Platform version
              </span>
              <span
                id="platform-version-pill-slot"
                className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end"
              >
              </span>
            </div>
            {/* Installed Flutter app release (#1101) — version/build, e.g.
                0.4.0/1223. Deliberately independent of the platform version
                above and never the open app's commit. Hidden outside the
                mobile app. */}
            <NativeAppVersionRow />
            {/* Fork lineage: the amber "⑂ Forked from <name>" label, written by
                AppView.renderForkBadge() and revealed by
                App.DrawerStatus.setForkVisible(). App context, not a version. */}
            <div id="drawer-row-app-fork" className="hidden drawer-ver-row items-center gap-2 px-4">
              <span id="app-fork-badge-slot" className="ml-auto inline-flex min-w-0 justify-end">
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
