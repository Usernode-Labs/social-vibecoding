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
 *   * the header bar — caption, the four-button view toggle, the "+" button and
 *     its dropdown, including every `data-plus` row and the two
 *     `data-plus-group` headings;
 *   * `#dev-forum-scroll` and the General-chat card.
 *
 * Legacy-owned hosts, rendered by React but never reconciled into:
 *   * `#dev-body` — `AppView._repaintDevBody()` replaces its `innerHTML` on
 *     every mode switch and feed reload, so its initial content is a CONSTANT
 *     `dangerouslySetInnerHTML` string. React writes it once at mount and,
 *     because the string never changes, never looks inside again. Rendering
 *     `#dev-feed` and `#gc-merged` as JSX children instead would make every
 *     view-mode re-render reconcile against nodes the module has since
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
  /** Called when a toggle button is pressed — `AppView._setViewMode` + repaint. */
  onSelectViewMode: (mode: DevViewMode) => void;
}

/**
 * `AppView._viewToggleBtnCls(active)`, character for character.
 *
 * Kept here rather than imported from the module because this is the only
 * remaining caller: `_updateViewToggleUI()` is gone and `_renderViewToggle()`
 * with it.
 */
function viewToggleBtnCls(active: boolean): string {
  return (
    'dev-view-btn w-7 h-7 flex items-center justify-center transition-colors ' +
    (active
      ? 'bg-violet-600 text-white'
      : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800')
  );
}

/** The four inline SVGs the template built, as JSX. Same paths, same order. */
const VIEW_ICON_PATHS: Record<DevViewMode, string> = {
  // List-lines (three rows).
  list: 'M4 6h16M4 12h16M4 18h16',
  // Board / columns.
  kanban: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  // People (two-person silhouette) for the PM assignment overview.
  pm: 'M17 20h5v-1a4 4 0 00-3-3.87M9 20H4v-1a4 4 0 013-3.87m6 4.87v-1a4 4 0 00-3-3.87M12 7a3 3 0 11-6 0 3 3 0 016 0zm7 3a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  // #1100: document-with-lines for the read-only progress report.
  report: 'M8 4h8l4 4v12H8zM8 4H6a2 2 0 00-2 2v12M11 12h6M11 16h6M11 8h2',
};

const VIEW_BUTTONS: {
  mode: DevViewMode;
  id: string;
  title: string;
}[] = [
  { mode: 'list', id: 'dev-view-list', title: 'List view' },
  { mode: 'kanban', id: 'dev-view-kanban', title: 'Kanban view' },
  { mode: 'pm', id: 'dev-view-pm', title: 'PM view — tasks by assignee' },
  { mode: 'report', id: 'dev-view-report', title: 'Reporting — progress report' },
];

function ViewToggle({
  active,
  onSelect,
}: {
  active: DevViewMode;
  onSelect: (mode: DevViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden mr-1"
      role="group"
      aria-label="Dev view mode"
    >
      {VIEW_BUTTONS.map(({ mode, id, title }) => (
        <button
          key={mode}
          id={id}
          data-view={mode}
          className={viewToggleBtnCls(active === mode)}
          aria-pressed={active === mode}
          title={title}
          aria-label={title}
          onClick={() => onSelect(mode)}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d={VIEW_ICON_PATHS[mode]} />
          </svg>
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
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
        />
      </svg>
    </span>
  );
}

/**
 * `#dev-body`'s initial content, as a constant string — see the header.
 *
 * Byte-for-byte what the template put there, so the first paint (before
 * `_repaintDevBody()` runs) is the "Loading…" placeholder it always was.
 */
const DEV_BODY_INITIAL_HTML =
  '<div id="dev-feed"><div class="text-xs text-zinc-500 dark:text-zinc-400">Loading…</div></div>' +
  '<div id="gc-merged" class="mt-4"></div>';

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
      {/* Header bar: caption + view-mode toggle + the "+" menu (top right).
          The "DEV" caption renders ONLY when the header's #app-mode-switch is
          hidden — i.e. on the self-hosted platform row. Everywhere else the
          header now says "Dev" a few pixels above this row, and printing it
          twice reads as a bug. The flex-1 spacer keeps the toggle and "+"
          right-aligned either way. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        {selfHosted ? (
          <span className="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider flex-1">
            Dev
          </span>
        ) : (
          <span className="flex-1"></span>
        )}
        <ViewToggle active={mode} onSelect={onSelectViewMode} />
        <div className={`relative ${readOnly && selfHosted ? 'hidden' : ''}`}>
          <button
            id="dev-plus-btn"
            aria-haspopup="true"
            aria-expanded="false"
            className="rounded-lg bg-violet-600 hover:bg-violet-500 w-7 h-7 flex items-center justify-center text-base font-bold leading-none text-white transition-colors"
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
            className="hidden absolute right-0 top-9 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
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
            <svg
              className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        {/* Body region: list mode mounts #dev-feed + #gc-merged here; kanban
            mode mounts #dev-kanban. _repaintDevBody() owns the swap. The
            wrapper node is stable across mode switches so the delegated
            card-open handler (bound by the module) survives both. */}
        <div
          id="dev-body"
          className="px-3 py-2"
          dangerouslySetInnerHTML={{ __html: DEV_BODY_INITIAL_HTML }}
        />
      </div>
    </div>
  );
}
