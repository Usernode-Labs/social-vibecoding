
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
 *   * the header bar — the "+" button and its dropdown, including every
 *     `data-plus` row and the two `data-plus-group` headings. The Feed/Kanban
 *     tab strip is NOT here any more: the Board's two layouts are a choice
 *     under the Improve panel's Board row now (see improve-panel.tsx), because
 *     a strip whose first tab restated the destination the header chip had
 *     just named was navigation drawn twice;
 *   * `#dev-forum-scroll` and, on the kanban only, the General-discussion
 *     card. See ./discussion-store.ts for why the board carries it and why the
 *     Feed draws the same fact as an activity row instead.
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
 *   * `#dc-secrets-state` —
 *     a leaf the module writes text or `innerHTML` into. It is safe because
 *     React renders its
 *     `className` as a CONSTANT prop: React
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

import { ChatIcon, ChevronRightIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { useDevViewMode } from './view-mode-store';
import { discussionStore, type DiscussionState } from './discussion-store';
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

/**
 * The General-discussion card — the kanban's door to the app's general chat.
 *
 * ── Why it is here and only on the kanban ──────────────────────────────
 *
 * The card shipped, was retired when Activity became a first-class hash for
 * the general chat, and is back because Activity stopped meaning the general
 * chat: the board's recency stream took the name, and the screen it displaced
 * was left reachable only from a notification.
 *
 * It draws on the KANBAN only, because the Feed draws the same fact better.
 * A feed is a stream of what just happened and a conversation is one of the
 * things that just happened, so there it is an ordinary activity row sorted by
 * its latest message (`AppView._discussionCardModel`); a pinned tile above
 * that stream would be saying the discussion is not activity, immediately
 * above the row proving it is. The kanban is a prioritised worklist with no
 * such slot, so there the card is chrome above the columns — which is exactly
 * what it always was.
 *
 * ── An anchor ──────────────────────────────────────────────────────────
 *
 * `#app/<slug>/dev/chat` is a real address, so cmd/ctrl-click and "open in new
 * tab" work on it — the rule tests/nav-new-tab.test.js pins across the shell,
 * and the reason the card it replaces (a `<button>` with a delegated handler)
 * is not simply restored as it was.
 *
 * `href: null` — no app open — renders nothing rather than a dead card.
 */
function DiscussionCard({ cardCls, cardHoverCls }: { cardCls: string; cardHoverCls: string }) {
  const mode = useDevViewMode();
  const { href, preview } = useStoreState<DiscussionState>(discussionStore);
  if (mode !== 'kanban' || !href) return null;
  return (
    <div className="px-3 pt-2">
      <a
        id="dev-chat-card"
        href={href}
        className={`${cardCls} ${cardHoverCls}`}
        title="Open the app's general chat"
      >
        <span className="w-9 h-9 rounded-lg bg-violet-600/15 text-violet-700 flex items-center justify-center shrink-0 dark:text-violet-400">
          <ChatIcon className="w-5 h-5" aria-hidden="true" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
            General discussion
          </span>
          {/* The last thing said in it, or the standing description until the
              one request for it lands. RENDERED, not an innerHTML host: the
              card it replaces had `#dev-chat-card-preview` written into by
              `_loadChatCardPreview`, which is two owners of one node. The
              module publishes the line now (./discussion-store.ts). */}
          <span
            id="dev-chat-card-preview"
            className="block text-xs text-zinc-500 dark:text-zinc-400 truncate"
          >
            {preview}
          </span>
        </span>
        <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" />
      </a>
    </div>
  );
}

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
        {/*
            `ml-auto` is load-bearing on the FEED: the filter host above is
            `empty:hidden` there, so it stops claiming the row's width and
            without the margin the "+" (the row's only remaining item) would
            collapse to the LEFT edge — where its `right-0` dropdown then
            opens off the left side of the viewport. On kanban the host's
            `flex-1` already fills the row, so the auto margin is a no-op.
        */}
        <div className={`relative ml-auto ${readOnly && selfHosted ? 'hidden' : ''}`}>
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
                      Your computer &middot; your own tools. You have already built it, so
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
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-400">
              App is locked. An admin must approve any proposal before it applies.
            </div>
          ) : null}
        </div>
        <DiscussionCard cardCls={cardCls} cardHoverCls={cardHoverCls} />
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
