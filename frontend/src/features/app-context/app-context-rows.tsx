/**
 * The APP'S OWN rows — the body of the hamburger drawer (Streamlined Concept).
 *
 * The Figma board draws ONE app-scoped drawer: the app itself, its Board, its
 * Activity, a "+ New change" action, the changes in progress here and the
 * changes running on the viewer's other apps. This is that content.
 *
 * NAVIGATION AND WORK, nothing else. The reference block the drawer used to
 * carry at its foot — View on GitHub, Share app, the two version lines, the
 * fork lineage — is gone from here, because the board draws no such footer and
 * because each of those four things has a truer home:
 *
 *   - "View on GitHub" is a Home.menuItemsFor item now, so it appears on the
 *     app's own page (#apps/<slug>) alongside everything else you can do with
 *     the app, and in the home card's menu for free.
 *   - Fork lineage renders from the same page's descriptor
 *     (../apps/browse-detail.tsx), off the `forked_from` the app fetch already
 *     returns, rather than through a slot a legacy module wrote into.
 *   - "Share app" is the Improve panel's third action (../improve/improve-panel.tsx).
 *   - The platform and installed-app versions are Settings' About block
 *     (../settings/index.tsx) — they describe the platform, not this app, and
 *     were the one part of the footer that never belonged to an app at all.
 *
 * ── Why it lives here rather than in a sheet of its own ────────────────
 *
 * It shipped first as `#app-context-sheet`, a second surface behind the
 * header's "app name ⌄" tab, while the drawer carried Notifications, Messages
 * and a Your-apps list. The board has no such split: the hamburger IS this
 * surface, alerting lives on the two header glyphs, and switching apps is the
 * Apps sheet behind the title tab. So the rows moved into the drawer and kept
 * every id — the declared checks address them by id, and none of them care
 * which panel they sit in.
 *
 * ── Dismissal ──────────────────────────────────────────────────────────
 *
 * Every action takes the DRAWER down first. The `Improve.*` methods close the
 * improve panel, which is a different surface, so without this the drawer
 * stayed open over whatever the action opened.
 */

import { useCallback, type ReactNode } from 'react';

import {
  AppWindowIcon,
  BoardIcon,
  HomeIcon,
  NewspaperIcon,
  PlusIcon,
  TerminalIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { SessionRow } from '../improve/session-row';

const ROW_CLASS =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

// Sentence case, not uppercase: the board's own labels read "Changes in
// progress", and the app name above them is the app's name as written.
const SECTION_LABEL_CLASS =
  'px-4 pt-3 pb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400';

/** Close the drawer. The controller is app.js's, reached the classic way. */
function closeDrawer(): void {
  (window as any).HeaderMenu?.close?.();
}

/** A destination row: label + one-line description, per the Figma board. */
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
}) {
  // The board marks the row you are ON with a tinted surface — the drawer is
  // the app's own navigation now, so it says where you are as well as where
  // you can go.
  const cls = selected
    ? ROW_CLASS.replace('hover:bg-zinc-50 dark:hover:bg-zinc-800', 'bg-violet-500/10 text-violet-700 dark:text-violet-400')
    : ROW_CLASS;
  const body = (
    <>
      {icon}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">
          {label}
        </span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
          {detail}
        </span>
      </span>
    </>
  );
  if (href) {
    return (
      <a id={id} data-context-row={row} href={href} className={cls} onClick={closeDrawer}>
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

export function AppContextRows(): ReactNode {
  const state = useStoreState(improveStore);
  const { slug, name, selfHosted, sessions, otherSessions, tab, subTab } = state;

  const act = useCallback((run: () => void) => {
    closeDrawer();
    run();
  }, []);

  const AppRowIcon = selfHosted ? HomeIcon : AppWindowIcon;
  const onApp = tab !== 'dev';
  const onActivity = tab === 'dev' && subTab === 'chat';
  const onBoard = tab === 'dev' && (subTab === 'forum' || subTab === 'topic');

  return (
    <>
      <div id="drawer-app-rows" className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {/* The app's name leads the drawer, exactly as the board draws it. */}
        <div className={SECTION_LABEL_CLASS}>
          {name || 'App'}
        </div>
        <ContextRow
          id="app-context-row-app"
          row="app"
          icon={<AppRowIcon className="w-5 h-5 shrink-0" />}
          label={selfHosted ? 'Home' : name || 'App'}
          detail={selfHosted ? 'The platform itself' : 'View and use the app'}
          selected={onApp}
          onClick={() => act(() => Improve.openApp())}
        />
        <ContextRow
          id="app-context-row-board"
          row="board"
          icon={<BoardIcon className="w-5 h-5 shrink-0" />}
          label="Board"
          detail="All feedback and changes"
          selected={onBoard}
          href={slug ? `#app/${slug}/board` : undefined}
        />
        <ContextRow
          id="app-context-row-activity"
          row="activity"
          icon={<NewspaperIcon className="w-5 h-5 shrink-0" />}
          label="Activity"
          detail="Updates and discussions"
          selected={onActivity}
          href={slug ? `#app/${slug}/activity` : undefined}
        />

        {/* "+ New change" stands on its own line under the three views, the
            way the board draws it — an action, not a destination. */}
        {state.readOnly ? null : (
          <button
            id="app-context-new-change"
            type="button"
            className={`${ROW_CLASS} border-b border-zinc-100 dark:border-zinc-800`}
            onClick={() => act(() => Improve.startSession())}
          >
            <PlusIcon className="w-5 h-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              New change
            </span>
          </button>
        )}

        <div className={SECTION_LABEL_CLASS}>
          Changes in progress
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
            onNavigate={closeDrawer}
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

        {/* The overflow area: changes running on the viewer's OTHER apps —
            the board's own second section, and the reason its sticky calls
            the drawer "not focused on a selected app". */}
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
                onNavigate={closeDrawer}
              />
            ))}
          </>
        ) : null}

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
    </>
  );
}
