/**
 * #app-context-sheet — the surface behind the header's "app name ⌄" tab
 * (Streamlined Concept).
 *
 * The Figma board's app-context sheet: the app's three views as rows (use
 * the app / Activity / Board), then the changes in progress here with a
 * "+ New change" action, then changes running on the viewer's other apps,
 * and finally the app's reference footer (GitHub, Share, versions, fork
 * lineage) — which moved here from the Improve panel, because every line of
 * it is ABOUT the app and this sheet is the app's own surface.
 *
 * ── Ownership and presentation ─────────────────────────────────────────
 *
 * A fully React-owned island on the Improve panel's exact contract: always
 * mounted and translated off-screen (`data-open` slides it in — CSS in
 * public/css/app.css, side panel at `sm`+ and bottom sheet below), adopted
 * into a real kit sheet on touch by ./app-context-controller.js, root
 * className a CONSTANT prop because the kit writes classes to it.
 *
 * ── Data ───────────────────────────────────────────────────────────────
 *
 * Everything renders from ../improve/improve-store.js — the sheet is a
 * second projection of the same app state the Improve panel reads, plus its
 * own `open` flag (./app-context-store.js). First render is the prerender:
 * closed, target-less, empty lists.
 */

import { useCallback, type ReactNode } from 'react';

import {
  AppWindowIcon,
  BoardIcon,
  GitHubIcon,
  HomeIcon,
  NewspaperIcon,
  PlusIcon,
  ShareIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { SessionRow } from '../improve/session-row';
import { NativeAppVersionRow } from '../header/native-app-version-row';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';

const ROW_CLASS =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

const SECTION_LABEL_CLASS =
  'px-4 pt-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-500 dark:text-zinc-400';

/** A destination row: label + one-line description, per the Figma board. */
function ContextRow({
  id,
  row,
  icon,
  label,
  detail,
  onClick,
  href,
}: {
  id?: string;
  row: string;
  icon: ReactNode;
  label: string;
  detail: string;
  onClick?: () => void;
  href?: string;
}) {
  // ONE line per row (owner review): the name leads, the description sits
  // beside it on the same baseline and truncates — the Figma board's row.
  const body = (
    <>
      {icon}
      <span className="flex-1 min-w-0 flex items-baseline gap-2">
        {/* The name may itself be long (it can be the app's display name),
            so it truncates rather than pushing the row wide; the detail
            takes what is left and truncates after it. */}
        <span className="text-sm font-medium truncate max-w-[55%] shrink-0 text-zinc-800 dark:text-zinc-200">
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate min-w-0">
          {detail}
        </span>
      </span>
    </>
  );
  if (href) {
    return (
      <a
        id={id}
        data-context-row={row}
        href={href}
        className={ROW_CLASS}
        onClick={() => AppContext.dismissForNav()}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      id={id}
      data-context-row={row}
      type="button"
      className={ROW_CLASS}
      onClick={onClick}
    >
      {body}
    </button>
  );
}

export function AppContextSheet() {
  const state = useStoreState(improveStore);
  const { open } = useStoreState(appContextStore);
  const { slug, name, selfHosted, sessions, otherSessions } = state;

  const close = useCallback(() => AppContext.close(), []);
  const dismissForNav = useCallback(() => AppContext.dismissForNav(), []);
  // Every action here takes the sheet down first. The Improve.* methods all
  // call `Improve.close()`, which closes the improve PANEL — a different
  // surface — so without this the sheet stayed up over whatever the action
  // opened (owner review: "+ New change" left the sheet on screen).
  const act = useCallback((run: () => void) => {
    AppContext.dismissForNav();
    run();
  }, []);

  const AppRowIcon = selfHosted ? HomeIcon : AppWindowIcon;

  return (
    <>
      <div
        id="app-context-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={close}
      >
      </div>
      <div
        id="app-context-sheet"
        role="dialog"
        aria-label={name ? `${name} — views and changes` : 'App views and changes'}
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-2xl app-context-transition"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <span className="flex-1 min-w-0 block text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
            {name}
          </span>
          <button
            id="app-context-close"
            type="button"
            className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/*
            A COLUMN FLEX so the reference footer bottom-anchors with
            `mt-auto` — the same layout #improve-body used while the footer
            lived there.
        */}
        <div
          id="app-context-body"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll flex flex-col"
        >
          <div className="shrink-0">
            {/* The three views, per the Figma board — where you ARE is the
                header tab's label; these are where you can GO. */}
            <ContextRow
              id="app-context-row-app"
              row="app"
              icon={<AppRowIcon className="w-5 h-5 shrink-0" />}
              label={selfHosted ? 'Home' : name || 'App'}
              detail={selfHosted ? 'The platform itself' : 'View and use the app'}
              onClick={() => act(() => Improve.openApp())}
            />
            <ContextRow
              id="app-context-row-activity"
              row="activity"
              icon={<NewspaperIcon className="w-5 h-5 shrink-0" />}
              label="Activity"
              detail="Project updates and discussions"
              href={slug ? `#app/${slug}/activity` : undefined}
            />
            <ContextRow
              id="app-context-row-board"
              row="board"
              icon={<BoardIcon className="w-5 h-5 shrink-0" />}
              label="Board"
              detail="All feedback and changes"
              href={slug ? `#app/${slug}/board` : undefined}
            />

            {/* Changes in progress — this app's sessions, with the Figma
                board's "+ New change" beside the heading. */}
            <div className="flex items-center pr-4">
              <div className={`${SECTION_LABEL_CLASS} flex-1`}>
                Changes in progress
              </div>
              {state.readOnly ? null : (
                <button
                  id="app-context-new-change"
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline un-touch-target"
                  onClick={() => act(() => Improve.startSession())}
                >
                  <PlusIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  New change
                </button>
              )}
            </div>
            {state.loadingSessions && !state.sessionsLoaded ? (
              <div className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                Loading…
              </div>
            ) : null}
            {sessions.map((session) => (
              <SessionRow
                key={session.key}
                session={session}
                showApp={false}
                onNavigate={dismissForNav}
              />
            ))}
            {state.sessionsLoaded && sessions.length === 0 ? (
              <div
                id="app-context-sessions-empty"
                className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400"
              >
                No changes in progress on this app.
              </div>
            ) : null}

            {/* The overflow area: changes running on the viewer's OTHER apps.
                Rendered only when there are any. */}
            {otherSessions.length > 0 ? (
              <>
                <div className={SECTION_LABEL_CLASS}>
                  Changes in other apps
                </div>
                {otherSessions.map((session) => (
                  <SessionRow
                    key={session.key}
                    session={session}
                    showApp={true}
                    onNavigate={dismissForNav}
                  />
                ))}
              </>
            ) : null}

            {/* The developer terminal — shown on the same DevConsole signal
                that showed it in the Improve panel; it is about the running
                app, which makes it this sheet's business now. */}
            {state.showTerminal ? (
              <button
                id="improve-row-terminal"
                type="button"
                className={ROW_CLASS}
                onClick={() => act(() => Improve.openTerminal())}
              >
                <TerminalIcon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                  Developer terminal
                </span>
              </button>
            ) : null}
          </div>

          {/*
              The reference footer, moved WHOLE from the Improve panel
              (Streamlined Concept): GitHub, Share, the version lines and the
              fork lineage are facts about this app, and this sheet is the
              app's surface. Ids and legacy writers unchanged —
              App.loadVersion, native-app-version.js and
              AppView.renderForkBadge resolve their slots by getElementById.
          */}
          <div
            id="improve-footer"
            className="mt-auto shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800"
          >
            {state.repoUrl ? (
              <a
                id="improve-row-github"
                href={state.repoUrl}
                target="_blank"
                rel="noreferrer"
                className={ROW_CLASS}
                onClick={() => AppContext.dismissForNav()}
              >
                <GitHubIcon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                  View on GitHub
                </span>
              </a>
            ) : null}
            {state.canShare ? (
              <button
                id="improve-row-share"
                type="button"
                className={ROW_CLASS}
                onClick={() => {
                  // Share presents a dialog of its own, so it waits for the
                  // sheet to be GONE rather than fading in across its exit.
                  void AppContext.close().then(() => Improve.share());
                }}
              >
                <ShareIcon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                  Share app
                </span>
              </button>
            ) : null}
            {slug ? (
              <div
                id="improve-row-version"
                className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400"
              >
                <span>
                  Version
                </span>
                <span
                  id="improve-version-value"
                  className="ml-auto font-mono truncate"
                >
                  {state.deploying ? 'deploying…' : state.version || 'unknown'}
                </span>
              </div>
            ) : null}
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
            {/* Installed Flutter app release (#1101) — store-driven since the
                widget-library migration (#1400): the bridge publishes into
                nativeAppVersionStore and the component shows/hides itself. */}
            <NativeAppVersionRow />
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
