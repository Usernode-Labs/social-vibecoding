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

import { useCallback, type ReactNode } from 'react';

import {
  GitHubIcon,
  ShareIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { NativeAppVersionRow } from '../header/native-app-version-row';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { SessionRow } from './session-row';
import { AppViewTabs, IMPROVE_VIEW_IDS } from './view-tabs';

/** Close the panel before whatever the row does next. */
function dismissForNav(): void {
  Improve.dismissForNav();
}

// Sentence case, not uppercase: the board's own labels read "Changes in
// progress", and the app name above them is the app's name as written.
const SECTION_LABEL_CLASS =
  'px-4 pt-2.5 pb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400';

const ROW_BASE =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left';
const ROW_REST =
  ' text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800';

/**
 * One primary action, as its own button.
 *
 * ── Why they are not a divided well any more ───────────────────────────
 *
 * Feedback, New change and Share shipped as three equal thirds of one recessed
 * group with hairline dividers, on the argument that they are peers and a
 * group says so in half the height. Two things undid it. Share left (it is a
 * fact about the app, so it sits with "View on GitHub" in the footer), and a
 * divided well of two is not a group, it is a control with a seam down the
 * middle. And the well read as ONE control with segments — the thing it looks
 * like elsewhere in this bundle is the view strip directly below it, which IS
 * a segmented control, so the panel opened with two identical shapes meaning
 * two different kinds of thing.
 *
 * So they are buttons, shaped like the control that opens this panel:
 * `h-9 rounded-full`, the same pill #improve-btn is. "New change" carries the
 * filled violet, because it is the thing this panel is FOR; Feedback takes the
 * tinted rest state, so the pair reads as primary-and-secondary rather than as
 * two equal halves of a switch.
 *
 * Every id is the one it has always had: `#improve-row-feedback` is what the
 * outbox dot's writer selects and `#improve-row-new-session` has named
 * Improve.startSession() since this panel existed.
 */
const ACTION_BASE =
  'inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-9 px-3 '
  + 'rounded-full text-sm font-semibold transition-colors un-touch-target';

const ACTION_PRIMARY = 'bg-violet-600 hover:bg-violet-500 text-white';

const ACTION_SECONDARY =
  'bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-400';

function QuickAction({ id, label, primary, onClick }: {
  id: string;
  label: string;
  primary?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      className={ACTION_BASE + ' ' + (primary ? ACTION_PRIMARY : ACTION_SECONDARY)}
    >
      <span className="min-w-0 truncate">
        {label}
      </span>
    </button>
  );
}

/**
 * A reference row in the footer: a glyph, a label, and an optional value.
 *
 * Restored with the footer (#1443). The one caller that needs `external` is
 * the GitHub link, which is the only thing in this panel that leaves the app
 * — hence target=_blank, and hence NOT a hash route the sheet controller
 * would want to dismiss for.
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
}): ReactNode {
  const body = (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {detail}
    </>
  );
  if (href) {
    return (
      <a
        id={id}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className={ROW_BASE + ROW_REST}
        onClick={() => Improve.dismissForNav()}
      >
        {body}
      </a>
    );
  }
  return (
    <button id={id} type="button" className={ROW_BASE + ROW_REST} onClick={onClick}>
      {body}
    </button>
  );
}

export function ImprovePanel() {
  const state = useStoreState(improveStore);
  const {
    open, adopted, target, name, slug, selfHosted, sessions, otherSessions,
  } = state;

  const close = useCallback(() => Improve.close(), []);

  // "Nothing anywhere", which is a different state from "nothing on this app"
  // — and the only one that has spare vertical space to spend.
  const nothingRunning = state.sessionsLoaded
    && sessions.length === 0 && otherSessions.length === 0;

  // Everything below renders unconditionally — the panel is always mounted and
  // slid off-screen, never unmounted — so a closed panel is inert markup rather
  // than a tree React has to rebuild on every open.
  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop dims the scene (and fades with its spring), so
          raising this one too both over-dimmed and, on close, held the dim at
          full strength until the teardown — the background snapped clear
          instead of fading with the slide. */}
      <div
        id="improve-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
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
        {/*
            ONE LINE. It was a stacked title-over-subtitle pair with `py-3`,
            which spent about seventy points saying two words. "Improve" and
            the app's name are the same fact read at two altitudes, so they sit
            on one baseline with the name muted after it — and the sheet starts
            where its content starts.

            The name keeps its id and its job: on the home screen the target is
            the platform itself, and this is the only cue that says "Improve"
            there means Social Vibecoding rather than an app.
        */}
        <div className="flex items-center gap-2 px-4 py-2 shrink-0">
          <h2 className="shrink-0 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Improve
          </h2>
          <p
            id="improve-target-name"
            className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400"
          >
            {name}
          </p>
          <button
            id="improve-close"
            type="button"
            className="shrink-0 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 un-touch-target dark:text-zinc-400"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/*
            A COLUMN FLEX with EXACTLY ONE SCROLLER in it. The quick actions
            and the view rows are `shrink-0`; #improve-sessions is
            `flex-1 min-h-0 overflow-y-auto`. That is the whole layout rule,
            and it gives both idioms their behaviour for free: a full-height
            desktop side panel scrolls its list inside a fixed column, and a
            mobile bottom sheet is content-sized until it reaches its cap and
            then scrolls the same list — which is what the board draws.
            No measurement, no fold, nothing pushed past the bottom.
        */}
        <div
          id="improve-body"
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          {/*
              ── Zone 1: the two actions ────────────────────────────────

              Feedback and New change, as two BUTTONS — see the note on
              QuickAction above for why the divided well of three retired.
              "Give feedback", not "Feedback": both of these are things you DO,
              and a bare noun beside the verb phrase "New change" read as a
              category label sitting next to an action. The two labels are the
              same part of speech now. It still leads, because it is the one
              action that needs nothing of the viewer — no collaborator bit, no
              session, no repo. New change carries the fill, because starting
              one is what this panel is for.

              Share was the third segment and is not here any more: it is a
              fact ABOUT the app rather than something you do to it, so it
              sits with "View on GitHub" in the footer, which is where the
              app's other outward-facing facts already are. It keeps its
              `#improve-row-share` id and its `canShare` gate.

              The two ids that stayed keep their meaning:
              `#improve-row-feedback` is what the outbox dot's writer selects,
              and `#improve-row-new-session` has named Improve.startSession()
              since this panel existed. The drawer's own
              `#app-context-new-change` retires INTO the second — two ids
              calling one method was the duplication the merge removed.
          */}
          <div
            id="improve-quick-actions"
            className="shrink-0 flex items-stretch gap-2 px-4 pt-1 pb-2"
          >
            <QuickAction
              id="improve-row-feedback"
              label="Give feedback"
              onClick={() => Improve.giveFeedback()}
            />
            {state.readOnly ? null : (
              <QuickAction
                id="improve-row-new-session"
                label="New change"
                primary
                onClick={() => Improve.startSession()}
              />
            )}
          </div>

          {/*
              ── Zone 2: the app's three views ──────────────────────────

              ONE segmented control, not three rows and a sub-strip. See
              ./view-tabs.tsx for why the Kanban|Feed pair underneath Board
              retired into it: those two WERE Board and Activity, so the
              hierarchy was a choice between three things drawn as four
              controls on two levels.

              #1443 moved these to the chip's menu on the argument that they
              are destinations and destinations belong there, then moved them
              back. Both surfaces carry the strip now, which is the answer
              that argument was reaching for: the menu answers "which app",
              this answers "which part of it", and either is a fair place to
              ask the second question.

              `mx-4 mb-2` and not a wrapper: #improve-views is a DIRECT child
              of #improve-body, which is the band order dapp.json's declared
              check selects on.
          */}
          <AppViewTabs
            ids={IMPROVE_VIEW_IDS}
            onNavigate={dismissForNav}
            className="mx-4 mb-2"
          />

          {/*
              ── Zone 3: the work in flight, and the only scroller ──────

              THE ONE SCROLLER in this panel, which is what lets the two zones
              above stay on screen at any viewport: they are `shrink-0`, this
              is `flex-1 min-h-0 overflow-y-auto`. On the desktop side panel
              that means the list scrolls inside a full-height column; on the
              mobile sheet the panel is content-sized until it hits its cap
              and then this scrolls, which is the bottom-sheet behaviour the
              board draws.
          */}
          <div
            id="improve-sessions"
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {/* THE HEADING ONLY EARNS ITS LINE WHEN THERE IS A LIST UNDER IT.
                A section label over an empty section is a label describing
                nothing, and it was the reason the empty state read as
                squeezed: two cramped lines in the rhythm a full list needs. */}
            {nothingRunning ? null : (
              <div className={SECTION_LABEL_CLASS}>
                Changes in progress
              </div>
            )}
            {state.loadingSessions && !state.sessionsLoaded ? (
              <div className="px-4 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
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
            {/*
                NOTHING RUNNING ANYWHERE — the one state with room to spare, so
                it gets some. Everything else in this panel is tuned for a
                contested column; here the list is the thing that is absent,
                and a centred block with real air says "nothing is running"
                far better than a muted fragment tucked under a heading.

                `text-sm`, not the `text-xs` the metadata around it uses: this
                is the only prose on the surface, and prose has a floor.
            */}
            {nothingRunning ? (
              <div id="improve-sessions-empty" className="px-6 py-9 text-center">
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  No changes in progress.
                </p>
                <p className="mt-1 text-sm text-zinc-500 text-pretty dark:text-zinc-400">
                  Start one with New change, or send feedback and let someone
                  else pick it up.
                </p>
              </div>
            ) : null}
            {/* This app is quiet but another is not: the space is contested
                again, so the note goes back to one muted line. */}
            {state.sessionsLoaded && sessions.length === 0 && otherSessions.length > 0 ? (
              <div className="px-4 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
                Nothing running on this app.
              </div>
            ) : null}

            {/* The overflow area: changes running on the viewer's OTHER apps —
                the board's own second section, and the reason its sticky calls
                this surface "not focused on a selected app". */}
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

            {state.showTerminal ? (
              <button
                id="improve-row-terminal"
                type="button"
                className={ROW_BASE + ROW_REST}
                onClick={() => Improve.openTerminal()}
              >
                <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
                  <TerminalIcon />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  Developer terminal
                </span>
              </button>
            ) : null}
          </div>

          {/*
              ── Zone 4: what this app IS ───────────────────────────────

              #1431 dissolved this block and rehomed its contents: the GitHub
              link to Home's per-app menu, the app's version deleted as a
              duplicate of the chip on the app's own page, and the two build
              lines to a new About block in Settings. Each move was defensible
              on its own and the sum was not — you are INSIDE the app when this
              panel is open, and every one of those facts had become something
              you leave the app to read.

              So they are back, as CONSTANT markup with empty slots: the
              modules that fill them (App.loadVersion,
              features/header/native-app-version.js) resolve their slot by
              getElementById and toggle `hidden` on the row, so only the parent
              changed. `.drawer-ver-row` keeps its name because app.css draws
              both rows off it and renaming would be a restyle rather than a
              move.

              Fork lineage did NOT come back. #1431 put it on the app's detail
              page (#browse-detail-fork) and that is the better home — lineage
              is a fact about an app, not about the panel you have open.

              DrawerStatus.refreshDeployDot() reads the deploying pill out of
              whichever of these is painted, which is why #improve-version-dot
              lights amber while a deploy is in flight. #1431 rescoped that
              query to #settings-about; it is scoped back here, and
              tests/improve-panel-versions.test.js pins it rather than trusting
              the selector.
          */}
          <div
            id="improve-footer"
            className="shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800 platform-safe-scroll"
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
            {/* Share, next to the repository link, because the two are the
                same KIND of thing: the app as something you point other people
                at. It was the third segment of the action well at the top,
                where it sat among things you do TO the app — and it is
                conditional (`canShare` is false for an app that is still
                creating, errored, or waiting on its secrets), so it was also
                the one segment that could leave a three-up control drawn as
                two. Same id, same gate, same dialog. */}
            {state.canShare ? (
              <ImproveRow
                id="improve-row-share"
                icon={<ShareIcon className="w-5 h-5 shrink-0" />}
                label="Share app"
                onClick={() => Improve.share()}
              />
            ) : null}
            {/*
                Versions as text rather than rows: they are the things here you
                read instead of act on. `slug` gates the app's own so a
                target-less panel never renders a dangling label.

                ── and NOT on the platform's own panel ────────────────

                `!selfHosted` is the second gate, and it removes a genuine
                duplicate: the self-hosted row IS the platform, so "Version"
                and "Platform version" directly below it were the same seven
                characters twice, two lines apart.

                They are not the same FACT — this row is the app's latest
                merged main, and the row below is the commit the running
                deployment was built from — but on every app except this one
                that distinction is invisible, and on this one the two only
                diverge while a deploy is in flight or a tab has gone stale.
                Both of those states the Platform version row already names on
                its own (`.drawer-ver--deploying`, `.drawer-ver--stale`, which
                is also what ImproveStatus.refreshDeployDot reads — it selects
                inside #platform-version-pill-slot, never here, so nothing about
                the deploy dot depends on this row existing).

                So what is lost is one SHA in one state that is already
                labelled, and what is gained is that the platform's own footer
                stops repeating itself.
            */}
            {slug && !selfHosted ? (
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
          </div>
        </div>
      </div>
    </>
  );
}
