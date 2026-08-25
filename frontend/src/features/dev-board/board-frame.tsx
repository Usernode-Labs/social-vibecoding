
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
 *   * `#dev-chat-card-preview`, `#dc-secrets-state` —
 *     leaves the module writes text or `innerHTML` into. They are safe because
 *     React renders their
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
  ChevronRightIcon,
  DiscussionIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { skeletonListHtml } from './card/skeleton';
import { lockedNoticeStore, type LockedNoticeState } from './locked-notice-store';

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
}

/*
 * THE DEV SCREEN'S TWO TABS ARE GONE (#1367 follow-up).
 *
 * `#dev-view-tabs` and its `#dev-view-feed` / `#dev-view-kanban` buttons were a
 * Feed/Kanban strip sitting at the top of this frame. The App/Feed/Kanban
 * toggle in the platform header replaced them: the same two destinations plus
 * the app itself, one control instead of two that disagreed about how many
 * options there were.
 *
 * BOTH FORM FACTORS STILL HAVE A SWITCH, which is what makes the removal safe.
 * The header copy is `hidden sm:inline-flex`, so on a wide screen it is right
 * there; below that breakpoint it steps aside for the copy inside the Improve
 * panel. See frontend/src/features/improve/view-toggle.tsx.
 *
 * `AppView._setViewMode()` and the view-mode store are untouched — only this
 * frame stopped drawing a control for them, and `onSelectViewMode` went with
 * it (the header toggle calls Improve.openDev, which routes to the same place).
 */

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
        'px-3 pt-2.5 pb-1 text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-500 select-none' +
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
    <span className="w-9 h-9 rounded-lg bg-violet-600/15 text-violet-700 flex items-center justify-center shrink-0 dark:text-violet-400">
      <DiscussionIcon className="w-5 h-5" aria-hidden="true" />
    </span>
  );
}

/**
 * `#dev-body`'s initial content, as a constant string — see the header.
 *
 * A SKELETON, not the word "Loading…". The report this answers was that
 * content "loads without you realising it's loading": eleven characters of
 * `text-xs` grey in the top-left of an empty screen is not a state anybody
 * reads, and the eye takes the blank area for an empty board rather than a
 * pending one.
 *
 * Deliberately ONE constant and not a per-mode pair. The prop's identity has
 * to stay stable (see `DEV_BODY_INITIAL` below), and swapping it on a
 * view-toggle would rewrite `#dev-body` out from under whatever
 * `_repaintDevBody` had just painted there. Card-shaped rows are a fair
 * first frame for either mode: the Feed keeps them, and the board replaces
 * the whole host with its own four columns of the same rows the moment it
 * paints (card/skeleton.tsx renders both).
 *
 * Concatenation of literals and one call to the shared builder, evaluated
 * ONCE at module scope — never a template with a live value in it. What the
 * constant has to be is the same bytes on every render; see `DEV_BODY_INITIAL`
 * below for what happens when it is not.
 *
 * The second node this used to carry — `#gc-merged`, the Completed block —
 * is gone: completed work is ordinary activity in the Feed's own stream now
 * (see `AppView._feedItems`), and the kanban Done column renders its own.
 */
const DEV_BODY_INITIAL_HTML =
  '<div id="dev-feed">' + skeletonListHtml(3) + '</div>';

const DEV_BODY_INITIAL = { __html: DEV_BODY_INITIAL_HTML };

export function DevBoardFrame({
  selfHosted,
  readOnly,
  canCollaborate,
  showsMembers,
  cardCls,
  cardHoverCls,
}: DevBoardFrameProps) {
  const { locked } = useStoreState<LockedNoticeState>(lockedNoticeStore);
  return (
    <div className="flex flex-col h-full min-h-0">
      {/*
          THE "DEV" SUB-HEADER ROW IS GONE (#1367 follow-up).

          It carried three things: a "Dev" caption, the Feed/Kanban tabs, and
          the "+" menu. The caption named an area the header already names, the
          tabs are the header's App/Feed/Kanban toggle now (see the note above),
          and with both gone the row was a full-height strip of chrome holding
          one button — so the button moved down to sit with the filter controls
          and the row went.

          `#dev-actions` is that new row, and the "+" sits at its right end with
          the filter controls to its left. The controls are legacy-rendered, so
          the row carries an innerHTML HOST for them rather than the markup —
          the same seam `#dev-body` below already is.

          THE HOST IS OUTSIDE `#dev-body` ON PURPOSE, and it is the whole reason
          this row is shaped this way. `_repaintDevBody()` assigns
          `body.innerHTML` on every view switch; anything living in there is
          destroyed and rebuilt. The "+" is React's — button, menu, listeners —
          so it can never be a child of that node, and moving it in and out
          around each repaint would be a race waiting to happen. Keeping BOTH
          the filter host and the button up here means the row is stable, React
          never reconciles inside the host, and the module never writes outside
          it. `_renderKanbanFilterBar()` fills it on kanban and
          `_clearKanbanFilterBar()` empties it on the feed, which has no filters.
      */}
      <div id="dev-actions" className="flex items-center gap-2 px-3 pt-2 shrink-0">
        {/*
            Legacy innerHTML host for the filter chips. Ships EMPTY and is
            filled by AppView._renderKanbanFilterBar(); `empty:hidden` keeps it
            from claiming the row's width on the feed, where it stays empty.
        */}
        <div id="dev-kanban-filterbar" className="flex-1 min-w-0 empty:hidden" />
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
                    Start a dev session. You pick where it is built, and can change that
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
                      Your computer &middot; your own tools: you have already built it, so
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
                    Renames are proposals, applied once voted in
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
                      className="text-xs font-normal text-zinc-500 dark:text-zinc-500"
                    ></span>
                  </span>
                  <span className={PLUS_SUB_CLS}>
                    {selfHosted
                      ? "The platform's own env, applied on its next deploy"
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
        {/*
            The locked-app banner. It used to be one of the leaves above — a
            host the module toggled `hidden` on and wrote `innerHTML` into —
            which meant TWO owners of one node's class attribute, tolerated only
            because React rendered that class as a constant. It is a field on
            the view-mode store now, so the node has one writer and the banner
            has one spelling.
        */}
        <div id="dev-locked-notice" className={locked ? 'px-3 pt-2' : 'px-3 pt-2 hidden'}>
          {locked ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-400">
              App is locked, so an admin must approve any proposal before it applies.
            </div>
          ) : null}
        </div>
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
            <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" />
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
