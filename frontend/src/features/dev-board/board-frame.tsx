
/**
 * The Dev board's frame, converted from the `innerHTML` template that used to
 * live in `AppView.renderDevView()`'s card-list branch (#1084 chunk G).
 *
 * ── What React owns here, and what it deliberately does not ────────────
 *
 * Exactly the split chunk F established: React owns the FRAME plus the one
 * piece of state that genuinely changes hands (the view mode), and every deep
 * subtree that a `public/js/**` module writes into stays that module's host.
 * Nothing below is a redesign — every element, id, class string, `data-*`
 * attribute and `hidden` semantic is the one the template emitted.
 *
 * React-owned, and now stateful:
 *   * the header bar — the "Dev" caption, the Feed/Kanban tab strip, the "+"
 *     button and its dropdown, including every `data-plus` row and the two
 *     `data-plus-group` headings;
 *   * `#dev-forum-scroll` and the General-chat card.
 *
 * Legacy-owned hosts, rendered by React but never reconciled into:
 *   * `#dev-body` — `AppView._repaintDevBody()` replaces its `innerHTML` on
 *     every tab switch and feed reload, so its initial content is a CONSTANT
 *     `dangerouslySetInnerHTML` OBJECT (`DEV_BODY_INITIAL`). React writes it
 *     once at mount and, because the object's identity never changes, never
 *     looks inside again. The identity is what matters: React 19 diffs host
 *     props by reference and re-assigns `innerHTML` whenever the `{__html}`
 *     wrapper is a new object, even for an identical string — an inline
 *     literal here made every tab click wipe the module's paint back to
 *     "Loading…". Rendering `#dev-feed` as a JSX child instead would make
 *     every view-mode re-render reconcile against nodes the module has since
 *     replaced.
 *   * `#dev-locked-notice`, `#dev-chat-card-preview`, `#dc-secrets-state` —
 *     leaves the module writes text or `innerHTML` into, and in the notice's
 *     case toggles `hidden` on. They are safe because React renders their
 *     `className` (and the preview's placeholder text) as CONSTANT props: React
 *     only writes an attribute when the prop CHANGES, so a re-render of this
 *     component does not clobber a class or a string the module has since
 *     written. That is the same rule the dialog islands run under — see the
 *     header of ../../lib/legacy-dom.ts.
 *
 * ── Why the wiring stays in app-view.js ────────────────────────────────
 *
 * `_wirePlusMenu`, `_wireViewToggle`'s companion behaviour, `_attrInit`,
 * `_cardMenuInit`, `PlatformUI.pullToRefresh` and the delegated `#dev-body`
 * click/keydown handlers all attach LISTENERS and toggle `hidden` — the two
 * mutations the migration explicitly sanctions on React-rendered nodes. Moving
 * them would be a rewrite, and this chunk is a conversion. The one exception is
 * `_updateViewToggleUI()`, which assigned `btn.className` outright; that is
 * retired in favour of ./view-mode-store.ts.
 *
 * The frame is mounted by an interim root (../../lib/interim-root.ts) rather
 * than by `<Shell/>`, because `#app-content` ships empty and this surface only
 * exists on the Dev route. Chunk H (#1085) folds it into the main tree.
 */

import {
  BoardIcon,
  ChevronRightIcon,
  DiscussionIcon,
  ListLinesIcon,
} from '@/components/ui/icons';

import { useDevViewMode, type DevViewMode } from './view-mode-store';

/** `AppView.DEV_CARD_CLS`, unchanged. Passed in so there is one source of truth. */
export interface DevBoardFrameProps {
  /** `AppView.appData?.self_hosted` — gates the "Dev" caption and several rows. */
  selfHosted: boolean;
  /** `AppView.readOnly`. */
  readOnly: boolean;
  /** `AppView.appData?.can_collaborate` — gates the Import-from-PR row. */
  canCollaborate: boolean;
  /** `AppView._plusMenuShowsMembers()` — the full predicate stays in the module. */
  showsMembers: boolean;
  /** `AppView.DEV_CARD_CLS`. */
  cardCls: string;
  /** `AppView.DEV_CARD_HOVER_CLS`. */
  cardHoverCls: string;
  /** Called when a tab is pressed — `AppView._setViewMode` + repaint. */
  onSelectViewMode: (mode: DevViewMode) => void;
}

/**
 * The Dev screen's two tabs.
 *
 * THE UI OVERHAUL replaced a four-icon segmented control — List, Kanban, PM,
 * Reporting — with this. Two things drove that. The icons were unlabelled, so
 * the two overviews almost nobody switched to were also the two nobody could
 * identify; and a "display preference" toggle had quietly accumulated four
 * genuinely different products behind it, one of which (Reporting) generated a
 * document. What is left is the two answers a board is actually asked for:
 * what just happened, and what is in flight.
 *
 * Labelled text tabs rather than icons, and an underline rather than a filled
 * pill, because these are now the primary navigation WITHIN the Dev area
 * rather than a corner control — the Improve panel links straight to either
 * one, so a viewer can arrive on a tab without having chosen it and needs to
 * read where they are.
 */
function viewTabCls(active: boolean): string {
  return (
    // The 44px kit tap halo on a 36px box, exactly as the retired icon
    // buttons carried it.
    'dev-view-btn un-touch-target h-9 px-3 inline-flex items-center gap-1.5 '
    + 'text-sm font-medium border-b-2 -mb-px transition-colors '
    + (active
      ? 'border-violet-600 text-violet-600 dark:text-violet-400'
      : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')
  );
}

const VIEW_TABS: {
  mode: DevViewMode;
  id: string;
  label: string;
  title: string;
  Icon: typeof BoardIcon;
}[] = [
  {
    mode: 'feed',
    id: 'dev-view-feed',
    label: 'Feed',
    title: 'Feed — recent activity, newest first',
    Icon: ListLinesIcon,
  },
  {
    mode: 'kanban',
    id: 'dev-view-kanban',
    label: 'Kanban',
    title: 'Kanban — work in flight, by column',
    Icon: BoardIcon,
  },
];

function ViewTabs({
  active,
  onSelect,
}: {
  active: DevViewMode;
  onSelect: (mode: DevViewMode) => void;
}) {
  return (
    <div
      id="dev-view-tabs"
      className="inline-flex items-stretch gap-4 border-b border-zinc-200 dark:border-zinc-700"
      role="tablist"
      aria-label="Dev view"
    >
      {VIEW_TABS.map(({ mode, id, label, title, Icon }) => (
        <button
          key={mode}
          id={id}
          role="tab"
          data-view={mode}
          className={viewTabCls(active === mode)}
          aria-selected={active === mode}
          title={title}
          onClick={() => onSelect(mode)}
        >
          <Icon className="w-4 h-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * `AppView._plusMenuHeading(label, key, divider)`, as JSX.
 *
 * Still a `<div>`, not a `<button>`, and for the same reason the template said
 * so: `_wirePlusMenu` collects `button[data-plus]` for the touch action sheet,
 * so anything that is not an action must not be a button or it would arrive in
 * that sheet as a tappable row that does nothing. It does carry
 * `data-plus-group`, which is how the sheet picks headings up in DOM order.
 */
function PlusMenuHeading({
  label,
  groupKey,
  divider,
}: {
  label: string;
  groupKey: string;
  divider: boolean;
}) {
  return (
    <div
      data-plus-group={groupKey}
      className={
        'px-3 pt-2.5 pb-1 text-[10px] uppercase font-semibold tracking-wider text-zinc-400 dark:text-zinc-500 select-none' +
        (divider ? ' border-t border-zinc-200 dark:border-zinc-800 mt-1' : '')
      }
    >
      {label}
    </div>
  );
}

/** The shared row shell for every `data-plus` action. */
const PLUS_ROW_CLS =
  'w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';
const PLUS_ROW_DIVIDER_CLS = ' border-t border-zinc-200 dark:border-zinc-800';
const PLUS_TITLE_CLS = 'block text-sm font-medium text-zinc-800 dark:text-zinc-200';
const PLUS_SUB_CLS = 'block text-xs text-zinc-500 dark:text-zinc-400';

/**
 * The General-chat card's tinted icon chip — `AppView._devCardIcon('chat')`.
 *
 * Only the `chat` entry is duplicated here, on purpose. The rest of
 * `AppView.DEV_CARD_ICONS` is still consumed by the feed, kanban, PM and
 * merged-section row builders, which write HTML strings into hosts this
 * component does not own, so the table stays in app-view.js as the single
 * source of truth for those. Duplicating the whole table to serve one card
 * would create exactly the drift risk the migration is trying to avoid.
 */
function ChatCardIcon() {
  return (
    <span className="w-9 h-9 rounded-lg bg-violet-600/15 text-violet-500 flex items-center justify-center shrink-0">
      <DiscussionIcon className="w-5 h-5" aria-hidden="true" />
    </span>
  );
}

/**
 * `#dev-body`'s initial content, as a constant string — see the header.
 *
 * The "Loading…" placeholder the template always put there. The second node
 * it used to carry — `#gc-merged`, the Completed block — is gone: completed
 * work is ordinary activity in the Feed's own stream now (see
 * `AppView._feedItems`), and the kanban Done column renders its own.
 */
const DEV_BODY_INITIAL_HTML =
  '<div id="dev-feed"><div class="text-xs text-zinc-500 dark:text-zinc-400">Loading…</div></div>';

/**
 * Module-level so the prop's IDENTITY is stable across renders. React 19's
 * host-prop diff is `nextProp !== lastProp` and its dangerouslySetInnerHTML
 * setter assigns `innerHTML` unconditionally (the `__html` string comparison
 * React 18 did is gone) — with an inline `{{ __html: … }}` literal, every
 * re-render of this frame (i.e. every view-toggle click, via the view-mode
 * store) rewrote #dev-body back to the placeholder right after
 * `_repaintDevBody()` painted it.
 */
const DEV_BODY_INITIAL = { __html: DEV_BODY_INITIAL_HTML };

export function DevBoardFrame({
  selfHosted,
  readOnly,
  canCollaborate,
  showsMembers,
  cardCls,
  cardHoverCls,
  onSelectViewMode,
}: DevBoardFrameProps) {
  const mode = useDevViewMode();

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header bar: the "Dev" caption, the Feed/Kanban tabs, and the "+"
          menu (top right).

          The caption used to render ONLY for the self-hosted platform row,
          because everywhere else the header's #app-mode-switch already said
          "Dev" a few pixels above this row and printing it twice read as a
          bug. THE UI OVERHAUL retired that switch, so nothing above says it
          any more and the caption is unconditional — it is the only thing
          naming the area the two tabs sit under, which is exactly what the
          product spec asks for ("reformatted to be under the Dev area").

          The tab strip carries the bottom border now, so this row does not:
          two stacked hairlines a few pixels apart read as a rendering fault. */}
      <div className="flex items-end gap-3 px-3 pt-2 shrink-0 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider pb-2.5">
          Dev
        </span>
        <span className="flex-1"></span>
        <ViewTabs active={mode} onSelect={onSelectViewMode} />
        <div className={`relative ${readOnly && selfHosted ? 'hidden' : ''}`}>
          <button
            id="dev-plus-btn"
            aria-haspopup="true"
            aria-expanded="false"
            className="un-touch-target rounded-lg bg-violet-600 hover:bg-violet-500 w-9 h-9 flex items-center justify-center text-lg font-bold leading-none text-white transition-colors"
            title={
              readOnly
                ? 'Fork this app'
                : 'Propose a change, file an issue, or manage this app'
            }
          >
            +
          </button>
          <div
            id="dev-plus-menu"
            className="hidden absolute right-0 top-11 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
          >
            {readOnly ? null : (
              <>
                <PlusMenuHeading label="Build a change" groupKey="build" divider={false} />
                <button data-plus="proposal" className={PLUS_ROW_CLS}>
                  <span className={PLUS_TITLE_CLS}>Propose a change</span>
                  <span className={PLUS_SUB_CLS}>
                    Start a dev session — you pick where it is built, and can change that
                    any time
                  </span>
                </button>
                {canCollaborate ? (
                  <button
                    data-plus="import-pr"
                    className={PLUS_ROW_CLS + PLUS_ROW_DIVIDER_CLS}
                  >
                    <span className={PLUS_TITLE_CLS}>Import Feature from a PR</span>
                    <span className={PLUS_SUB_CLS}>
                      Your computer &middot; your own tools — you have already built it, so
                      there is no chat for this one
                    </span>
                  </button>
                ) : null}
                <button data-plus="issue" className={PLUS_ROW_CLS + PLUS_ROW_DIVIDER_CLS}>
                  <span className={PLUS_TITLE_CLS}>New issue</span>
                  <span className={PLUS_SUB_CLS}>
                    Report a problem or idea without building it yourself
                  </span>
                </button>
                <PlusMenuHeading
                  label="Settings &amp; rules"
                  groupKey="settings"
                  divider={true}
                />
                {showsMembers ? (
                  <button data-plus="members" className={PLUS_ROW_CLS}>
                    {selfHosted ? (
                      <>
                        <span className={PLUS_TITLE_CLS}>Proposal approvals</span>
                        <span className={PLUS_SUB_CLS}>
                          Who approves proposals and how many approvals are needed
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={PLUS_TITLE_CLS}>Members &amp; visibility</span>
                        <span className={PLUS_SUB_CLS}>Who can build and see this app</span>
                      </>
                    )}
                  </button>
                ) : null}
                <button
                  data-plus="rename"
                  className={PLUS_ROW_CLS + (showsMembers ? PLUS_ROW_DIVIDER_CLS : '')}
                >
                  <span className={PLUS_TITLE_CLS}>App display name</span>
                  <span className={PLUS_SUB_CLS}>
                    Renames are proposals — applied once voted in
                  </span>
                </button>
                <button data-plus="secrets" className={PLUS_ROW_CLS + PLUS_ROW_DIVIDER_CLS}>
                  <span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    {selfHosted ? 'Platform variables' : 'App secrets'}
                    {/* Filled by AppView.refreshDevChatSecretsState() — a
                        legacy-owned leaf, so it renders empty and React never
                        writes its text again. */}
                    <span
                      id="dc-secrets-state"
                      className="text-xs font-normal text-zinc-400 dark:text-zinc-500"
                    ></span>
                  </span>
                  <span className={PLUS_SUB_CLS}>
                    {selfHosted
                      ? "The platform's own env — applied on its next deploy"
                      : 'Set or update secret values'}
                  </span>
                </button>
              </>
            )}
            {selfHosted ? null : (
              <button
                data-plus="fork"
                className={PLUS_ROW_CLS + (readOnly ? '' : PLUS_ROW_DIVIDER_CLS)}
              >
                <span className={PLUS_TITLE_CLS}>Fork this app</span>
                <span className={PLUS_SUB_CLS}>Stand up your own independent copy</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* The card list: locked notice, general-chat card, session rows, the
          intermixed feed, and the Completed section. */}
      <div
        id="dev-forum-scroll"
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll"
      >
        <div id="dev-locked-notice" className="px-3 pt-2 hidden"></div>
        <div className="px-3 pt-2">
          <button
            id="dev-chat-card"
            className={`${cardCls} ${cardHoverCls}`}
            title="Open the general chat"
          >
            <ChatCardIcon />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                General chat
              </span>
              <span
                id="dev-chat-card-preview"
                className="block text-xs text-zinc-500 dark:text-zinc-400 truncate"
              >
                Talk with everyone building this app
              </span>
            </span>
            <ChevronRightIcon className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
          </button>
        </div>
        {/* Body region: the Feed mounts #dev-feed here; Kanban mounts
            #dev-kanban-filterbar + #dev-kanban-board. _repaintDevBody() owns
            the swap. The wrapper node is stable across tab switches so the
            delegated card-open handler (bound by the module) survives both. */}
        <div
          id="dev-body"
          className="px-3 py-2"
          dangerouslySetInnerHTML={DEV_BODY_INITIAL}
        />
      </div>
    </div>
  );
}
