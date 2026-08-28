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
  AppWindowIcon,
  BoardIcon,
  ChevronRightIcon,
  GitHubIcon,
  HomeIcon,
  NewspaperIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { NativeAppVersionRow } from '../header/native-app-version-row';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { SessionRow } from './session-row';

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
const ROW_SELECTED =
  ' bg-violet-500/10 text-violet-700 dark:text-violet-400';

/**
 * One quick action — a segment of the action group, not a control of its own.
 *
 * ── Why there is no disc ───────────────────────────────────────────────
 *
 * It shipped as a 56px filled circle with the caption beneath, which cost 100
 * vertical points and, worse, put a family of CIRCLES immediately above the
 * view rows' family of SQUARES. Two decorative icon containers stacked with
 * nothing between them read as clutter rather than as two groups — and a
 * decorative container around an icon is something to avoid on its own.
 * The glyph is the glyph now, and the GROUP does the separating.
 *
 * ── Why there is no glyph either, and why the thirds are equal ─────────
 *
 * These two facts are one decision. The segments were `flex-auto` — sized
 * from content, then sharing the slack — because equal thirds truncated "New
 * change": with a 16px glyph and its 6px gap the label needs 109px, and the
 * panel is 320px WIDE ON DESKTOP (it is a fixed side panel, not a fluid one),
 * which leaves a 287px well and 95px thirds. That constraint is real and the
 * earlier note recorded it correctly; only its conclusion was avoidable.
 *
 * Content-sizing bought the fit with raggedness — 134 / 155 / 109px at 430pt,
 * so the two hairlines landed at arbitrary offsets and a well whose divisions
 * track label length reads as a lopsided accident rather than as one control
 * with three equal choices. Dropping the glyphs returns those 22px per
 * segment: the widest label is 87px, every third is 95px at the narrowest
 * width either idiom draws, and nothing truncates from 320pt up. So the
 * segments can be `flex-1 basis-0` — actually equal — and the hairlines sit
 * still when a label changes or Share (which is conditional) is absent.
 *
 * The glyphs were decoration, not affordance: three verbs in a divided well
 * are already unambiguous, and this is the same argument that took the discs
 * away one step further. Nothing selected them — `#feedback-queue-dot`, the
 * one piece of state that ever rode this row, lives on #improve-btn.
 */
function QuickAction({ id, label, onClick }: {
  id: string;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      className="flex flex-1 basis-0 min-w-0 items-center justify-center px-1 py-2.5 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400 un-touch-target"
    >
      <span className="min-w-0 truncate text-sm font-medium">
        {label}
      </span>
    </button>
  );
}

/**
 * The platform's deploy state, as words on the row that names its version.
 *
 * ── Why it is here and not on #improve-btn ─────────────────────────────
 *
 * It was an 8px dot in that button's bottom-right corner, and it failed on
 * three counts at once. `stale` drew `violet-400` on the button's own
 * `violet-600` fill — the same hue two steps apart, so the state anybody was
 * most likely to meet read as a rendering artefact. `deploying` drew AMBER,
 * which the same button already used bottom-left for an unsent feedback
 * draft, so one colour meant two unrelated things eight pixels apart. And
 * neither is about your app or your work: this says THIS TAB IS BEHIND THE
 * PLATFORM, which is a thing to read, not a thing to act on.
 *
 * So it says it in words, on the row whose whole job is to name the version.
 * The dot is retired (see tests/shell-id-inventory.test.js) and #improve-btn
 * keeps one badge with one meaning.
 *
 * `idle` renders NOTHING — not an empty span. A row that reserves space for
 * a state it does not have is the same mistake in a quieter register, and
 * the label + value pair sits correctly on its own.
 */
function ImprovePlatformVersionState({ state }: { state: string }): ReactNode {
  if (state !== 'deploying' && state !== 'stale') return null;
  const deploying = state === 'deploying';
  return (
    <span
      id="improve-platform-version-state"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
    >
      <span
        className={'w-1.5 h-1.5 rounded-full shrink-0 '
          + (deploying ? 'bg-amber-500' : 'bg-violet-500')}
        aria-hidden="true"
      >
      </span>
      {deploying ? 'Deploying' : 'Update available'}
    </span>
  );
}

/**
 * A destination row: label left, one-line detail right, chevron.
 *
 * ONE LINE, deliberately. It shipped as a stacked label-over-detail pair in
 * the drawer and the board draws it flat — vertical space in this panel is
 * the sessions list's, and three two-line rows cost a session row each. The
 * label truncates at 55% before the detail starts giving ground, so a long
 * app name shortens rather than evicting "View and use the app".
 */
function ContextRow({
  id, row, icon, label, detail, onClick, href, selected,
}: {
  id?: string;
  row: string;
  icon: ReactNode;
  label: string;
  detail: string;
  onClick?: () => void;
  href?: string;
  selected?: boolean;
}): ReactNode {
  // The board marks the row you are ON with a tinted surface — this panel is
  // the app's navigation now, so it says where you are as well as where you
  // can go.
  const cls = ROW_BASE + (selected ? ROW_SELECTED : ROW_REST);
  const body = (
    <>
      {/* The glyph, undressed. It sat in an IconTile square until the quick
          actions above lost their circles — two decorative container shapes
          in one column was the clutter, and removing only one of them would
          have left the other looking arbitrary. */}
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 max-w-[55%] shrink truncate text-sm font-medium">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-500 dark:text-zinc-400">
        {detail}
      </span>
      <ChevronRightIcon
        className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500"
        aria-hidden="true"
      />
    </>
  );
  if (href) {
    return (
      <a id={id} data-context-row={row} href={href} className={cls} onClick={dismissForNav}>
        {body}
      </a>
    );
  }
  return (
    <button id={id} data-context-row={row} type="button" className={cls} onClick={onClick}>
      {body}
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
    open, target, name, slug, selfHosted, sessions, otherSessions, tab, subTab,
  } = state;

  const AppRowIcon = selfHosted ? HomeIcon : AppWindowIcon;
  const onApp = tab !== 'dev';
  const onActivity = tab === 'dev' && subTab === 'chat';
  const onBoard = tab === 'dev' && (subTab === 'forum' || subTab === 'topic');

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
              ── Zone 1: the quick actions ──────────────────────────────

              Three circular controls with their captions BENEATH, which is
              what makes three fit across a 390pt screen at all — a label
              beside a disc costs the width three times over. Feedback first,
              deliberately: it is the one action that needs nothing of the
              viewer — no collaborator bit, no session, no repo.

              Every id here predates the merge and keeps its meaning:
              `#improve-row-feedback` is what the outbox dot's writer selects,
              `#improve-row-new-session` has named Improve.startSession() since
              this panel existed, and `#improve-row-share` keeps its canShare
              gate. The drawer's own `#app-context-new-change` retires INTO
              the middle one — two ids calling one method was the duplication
              the merge exists to remove.
          */}
          <div className="shrink-0 px-4 pt-1 pb-2">
            {/* ONE GROUP, not three controls in a row. A recessed well with
                hairline dividers is the lightest treatment that still says
                "these belong together and the list below is something else" —
                which is the separation the stacked-circles version never had.
                Overflow-hidden so the segments' hover fill respects the
                rounded corners.

                The segments are `flex-1 basis-0`, i.e. EQUAL thirds, not
                `flex-auto`. Content-proportional sizing gave "New change" half
                again the width of "Share" and put the two hairlines at
                arbitrary offsets — a divided well whose divisions track label
                length reads as a lopsided accident rather than as one control
                with three equal choices. Equal segments also keep the hairlines
                still when a label changes (the Share segment is conditional). */}
            <div
              id="improve-quick-actions"
              className="flex items-stretch divide-x divide-zinc-950/5 dark:divide-white/10 overflow-hidden rounded-xl bg-zinc-100 dark:bg-white/5"
            >
              <QuickAction
                id="improve-row-feedback"
                label="Feedback"
                onClick={() => Improve.giveFeedback()}
              />
              {state.readOnly ? null : (
                <QuickAction
                  id="improve-row-new-session"
                  label="New change"
                  onClick={() => Improve.startSession()}
                />
              )}
              {state.canShare ? (
                <QuickAction
                  id="improve-row-share"
                  label="Share"
                  onClick={() => Improve.share()}
                />
              ) : null}
            </div>
          </div>

          {/*
              ── Zone 2: the app's three views ──────────────────────────

              One line each: the label leads, the detail is muted and
              right-aligned, and the row you are ON carries a tint — so the
              block says where you are as well as where you can go.

              #1443 moved these to the chip's menu on the argument that they
              are destinations and destinations belong there, then moved them
              back. The consistency argument was real but it was the weaker
              one: these three are the app's OWN views, and the panel you open
              from inside an app is where you look for them. The menu answers
              "which app"; this answers "which part of it".

              A KANBAN|FEED PAIR SAT UNDER THE BOARD ROW and does not any
              more. It was a LAYOUT control filed among DESTINATIONS, shown
              only while you were already on the Board — rendering it anywhere
              else would have put a control in front of people who could not
              see its effect — and it cost this panel two rows of the vertical
              space the session list below is always short of. The Board has
              one strip of its own now, All plus one tab per column at every
              width, so there is no layout left to pick. See
              ../dev-board/board-tabs.tsx.
          */}
          <div id="improve-views" className="shrink-0">
            <ContextRow
              id="app-context-row-app"
              row="app"
              icon={<AppRowIcon />}
              label={selfHosted ? 'Home' : name || 'App'}
              detail={selfHosted ? 'The platform itself' : 'View and use the app'}
              selected={onApp}
              onClick={() => Improve.openApp()}
            />
            <ContextRow
              id="app-context-row-board"
              row="board"
              icon={<BoardIcon />}
              label="Board"
              detail="All feedback and changes"
              selected={onBoard}
              href={slug ? `#app/${slug}/board` : undefined}
            />
            <ContextRow
              id="app-context-row-activity"
              row="activity"
              icon={<NewspaperIcon />}
              label="Activity"
              detail="Updates and discussions"
              selected={onActivity}
              href={slug ? `#app/${slug}/activity` : undefined}
            />
          </div>

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
              whichever of these is painted, which is what publishes
              `versionState`. #1431 rescoped that query to #settings-about; it
              is scoped back here, and tests/improve-panel-versions.test.js
              pins it rather than trusting the selector. What CONSUMES the
              answer moved: it was #improve-version-dot on the button, it is
              <ImprovePlatformVersionState/> on the row below now.
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
            {/* Versions as text rather than rows: they are the things here you
                read instead of act on. `slug` gates the app's own so a
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
            <div id="drawer-row-platform-version" className="drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                Platform version
              </span>
              <ImprovePlatformVersionState state={state.versionState} />
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
