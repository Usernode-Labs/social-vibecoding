/**
 * `#dev-actions` — the Dev screen's toolbar: the shared Board/Workshop filter
 * strip and the "+" menu beside it.
 *
 * ── Why it is its own file now ─────────────────────────────────────────
 *
 * It lived in ./board-frame.tsx, in the frame's own chrome above
 * `#dev-forum-scroll`, and that placement carried a hard constraint worth
 * repeating because it still holds HERE:
 *
 *   `_repaintDevBody()` assigns `body.innerHTML` on every view-mode switch, so
 *   anything inside `#dev-body` is destroyed and rebuilt. The "+" is React's —
 *   button, menu, listeners — so it must never be a child that the MODULE
 *   rewrites. What makes the Workshop placement legal is that `#dev-workshop`
 *   is React-owned end to end: the module creates that host once per surface
 *   occupancy and never writes inside it again, so a React subtree mounted
 *   there is reconciled, not clobbered. A Workshop↔Board switch does rebuild
 *   the host, which is why the filter bar is REMOUNTED across that switch and
 *   re-seeds from the persisted per-app filters rather than from the DOM.
 *
 * `#dev-kanban-filterbar` stays an innerHTML host that the module fills
 * (`_renderKanbanFilterBar()`); React renders it empty, with a constant
 * className, and never reconciles inside it.
 *
 * EXACTLY ONE of the two call sites renders at a time — ./board-frame.tsx when
 * the Dev screen is on the Board, ./workshop/workshop.tsx when it is on the
 * Workshop — which is what keeps `#dev-actions`, `#dev-plus-btn` and
 * `#dev-plus-menu` unique ids. board-frame reads the view mode to decide.
 *
 * tests/dev-plus-menu.test.js, tests/pr-import-menu.test.js and
 * tests/board-plus-menu-rows.test.js read this file's TEXT and compare row
 * positions, so the rows stay spelled out one per call rather than mapped from
 * a table.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';

import type { ReactNode } from 'react';

import {
  AppWindowIcon, GitHubIcon, KeyIcon, PencilSquareIcon, UserGroupIcon,
} from '@/components/ui/icons';

import { FeaturedIllustrationEditor } from '../apps/featured-illustration-editor';

export interface DevActionsRowProps {
  illustrationApp?: any;
  canManageIllustration?: boolean;
  selfHosted: boolean;
  readOnly: boolean;
  canCollaborate: boolean;
  showsMembers: boolean;
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

/**
 * The shared row shell for every `data-plus` action.
 *
 * #1615: the same shape as the app chip's menu — a leading glyph, `gap-3`,
 * `px-5`, a 44px floor and that menu's hover tint — so the two lists in this
 * shell read as one kind of thing. What it deliberately does NOT copy is the
 * chip menu's single-line row: every action here has a subtitle explaining
 * what it does ("Renames are proposals, applied once voted in"), and those
 * lines are the reason this menu is legible at all.
 *
 * The row's title carries `data-plus-title`, and `AppView._wirePlusMenu` reads
 * THAT for its touch action sheet. It used to take `querySelector('span')` —
 * the first span in the row — which was the title only by accident of source
 * order, and any wrapper introduced above it (this layout needs one for the
 * text column) would have handed every sheet row the wrong label, or none.
 */
const PLUS_ROW_CLS =
  'w-full text-left flex items-start gap-3 px-5 py-2.5 min-h-[44px] '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';
const PLUS_ROW_DIVIDER_CLS = ' border-t border-zinc-200 dark:border-zinc-800';
const PLUS_ICON_CLS = 'shrink-0 mt-0.5 w-5 h-5 text-zinc-500 dark:text-zinc-400';
const PLUS_TITLE_CLS = 'block text-sm font-medium text-zinc-800 dark:text-zinc-200';
const PLUS_SUB_CLS = 'block text-xs text-zinc-500 dark:text-zinc-400';

/**
 * One `data-plus` action, as the row shell above.
 *
 * The action and the divider come in spelled exactly as the markup spells
 * them, rather than as an `action` string and a boolean. Two reasons, and the
 * second is why it is worth the slightly odd prop name: the source stays
 * greppable per row, which is how tests/dev-plus-menu.test.js and
 * tests/pr-import-menu.test.js locate each one and prove its gate (they read
 * this file's TEXT and compare positions, so no example row name appears in
 * this comment); and the divider EXPRESSIONS stay visible at the call site,
 * where the condition ("does the members row render above me?") is the
 * interesting part.
 */
function PlusRow({
  'data-plus': action, icon, title, sub, dividerCls = '', titleNode, onClick,
}: {
  'data-plus': string;
  onClick?: () => void;
  icon: ReactNode;
  title?: string;
  sub: ReactNode;
  dividerCls?: string;
  /** For the one row whose title carries a legacy-owned leaf beside it. */
  titleNode?: ReactNode;
}): ReactNode {
  return (
    <button
      data-plus={action}
      onClick={onClick}
      className={PLUS_ROW_CLS + dividerCls}
    >
      {icon}
      <span className="min-w-0 flex-1">
        {titleNode ?? (
          <span data-plus-title className={PLUS_TITLE_CLS}>{title}</span>
        )}
        <span className={PLUS_SUB_CLS}>{sub}</span>
      </span>
    </button>
  );
}

export function DevActionsRow({
  illustrationApp,
  canManageIllustration,
  selfHosted,
  readOnly,
  canCollaborate,
  showsMembers,
}: DevActionsRowProps): ReactNode {
  const [editingIllustration, setEditingIllustration] = useState(false);
  return (
    <>
  {/* The native modal reparents its card under body. Portal there too so React's delegated events stay on the card's ancestor. */}
  {editingIllustration && illustrationApp ? createPortal(<FeaturedIllustrationEditor key={illustrationApp.slug} app={illustrationApp} onClose={() => setEditingIllustration(false)} />, document.body) : null}
  <div id="dev-actions" className="flex items-center gap-2 px-3 pt-2 shrink-0">
    {/*
        Legacy portal host for the filter strip. It ships EMPTY because the
        store is published only after the first data load, but `min-h-8`
        reserves the search field's one-row height from the frame's first
        paint. Without that reservation, a read-only self-hosted view —
        where the adjacent "+" is hidden — grows by 32px when the search
        arrives and pushes the scrolling board down. `min-height`, rather
        than a fixed height, still lets active chips wrap onto extra rows.
    */}
    <div id="dev-kanban-filterbar" className="flex-1 min-w-0 min-h-8" />
    {/*
        The filter host's `flex-1` places the "+" at the right edge on both
        Board and Activity. Keep `ml-auto` as the button wrapper's own
        defensive alignment; with the always-present host it is a no-op.
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
            : 'Import a PR or manage this app'
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
            {/* New change and Give feedback live in Improve (#1490). */}
            {canCollaborate ? (
              <>
                <PlusMenuHeading label="Import a change" groupKey="build" divider={false} />
                <PlusRow
                  data-plus="import-pr"
                  icon={<GitHubIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                  title="Import Feature from a PR"
                  sub={(
                    <>
                      Your computer &middot; your own tools. You have already built it, so
                      there is no chat for this one
                    </>
                  )}
                />
              </>
            ) : null}
            <PlusMenuHeading
              label="Settings &amp; rules"
              groupKey="settings"
              divider={canCollaborate}
            />
            {canManageIllustration ? <PlusRow
              data-plus="featured-illustration"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="Featured illustration"
              sub="Preview and adjust the Discover card image"
              onClick={() => setEditingIllustration(true)}
            /> : null}
            {showsMembers ? (
              <>
                {selfHosted ? (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title="Proposal approvals"
                    sub="Who approves proposals and how many approvals are needed"
                  />
                ) : (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title="Members &amp; visibility"
                    sub="Who can build and see this app"
                  />
                )}
              </>
            ) : null}
            <PlusRow
              data-plus="rename"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="App display name"
              sub="Renames are proposals, applied once voted in"
              dividerCls={showsMembers ? PLUS_ROW_DIVIDER_CLS : ''}
            />
            <PlusRow
              data-plus="secrets"
              icon={<KeyIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              titleNode={(
                <span
                  data-plus-title
                  className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200"
                >
                  {selfHosted ? 'Platform variables' : 'App secrets'}
                  {/* Filled by AppView.refreshDevChatSecretsState() — a
                      legacy-owned leaf, so it renders empty and React never
                      writes its text again. */}
                  <span
                    id="dc-secrets-state"
                    className="text-xs font-normal text-zinc-500 dark:text-zinc-500"
                  ></span>
                </span>
              )}
              sub={selfHosted
                ? "The platform's own env, applied on its next deploy"
                : 'Set or update secret values'}
              dividerCls={PLUS_ROW_DIVIDER_CLS}
            />
          </>
        )}
        {selfHosted ? null : (
          <PlusRow
            data-plus="fork"
            icon={<AppWindowIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
            title="Fork this app"
            sub="Stand up your own independent copy"
            dividerCls={readOnly ? '' : PLUS_ROW_DIVIDER_CLS}
          />
        )}
      </div>
    </div>
  </div>
    </>
  );
}
