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

import {
  BoardIcon,
  ChatIcon,
  ChevronRightIcon,
  GitHubIcon,
  ListLinesIcon,
  PlusIcon,
  ShareIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

const ROW_CLASS =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

const ROW_LABEL_CLASS = 'text-sm font-medium flex-1 min-w-0 truncate';

const SECTION_LABEL_CLASS =
  'px-4 pt-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
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
  const { open, slug, name, sessions, otherSessions } = state;

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
      <div
        id="improve-panel"
        role="dialog"
        aria-label="Improve this app"
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
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <div
          id="improve-body"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll"
        >
          {/* Feedback first, and deliberately: it is the one action that needs
              nothing of the viewer — no collaborator bit, no session, no repo.
              Everything below it asks for progressively more. */}
          <ImproveRow
            id="improve-row-feedback"
            icon={<ChatIcon className="w-5 h-5 shrink-0" />}
            label="Give feedback"
            onClick={() => Improve.giveFeedback()}
          />

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

          <div className={SECTION_LABEL_CLASS}>Development</div>
          <ImproveRow
            id="improve-row-kanban"
            icon={<BoardIcon className="w-5 h-5 shrink-0" aria-hidden="true" />}
            label="Development kanban"
            detail={<ChevronRightIcon className="w-4 h-4 text-zinc-400 shrink-0" />}
            onClick={() => Improve.openDev('kanban')}
          />
          <ImproveRow
            id="improve-row-feed"
            icon={<ListLinesIcon className="w-5 h-5 shrink-0" aria-hidden="true" />}
            label="Latest development activity"
            detail={<ChevronRightIcon className="w-4 h-4 text-zinc-400 shrink-0" />}
            onClick={() => Improve.openDev('feed')}
          />
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

          <div
            id="improve-footer"
            className="mt-2 border-t border-zinc-100 dark:border-zinc-800"
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
            {/* Version last, and as text rather than a row: it is the one thing
                here you read instead of act on. `slug` gates it so a
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
          </div>
        </div>
      </div>
    </>
  );
}
