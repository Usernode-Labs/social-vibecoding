/**
 * The shell's top-right anchored dropdown panel.
 *
 * #notifications-panel and #work-drawer-panel are the same surface with
 * different contents, and #1079 chunk B made both React. This is the shared
 * chassis they render through.
 *
 * ── Why this is a local primitive and not Radix Popover ────────────────
 *
 * A Radix popover portals its content and UNMOUNTS it while closed. Both of
 * these panels must exist in the prerendered public/index.html — hidden, but
 * present:
 *
 *   - tests/shell-id-inventory.test.js checks their ids in the built document;
 *   - dapp.json's declared UI tests select `#notifications-panel:not(.hidden)`
 *     and friends, i.e. the CLASS is the open/closed contract, not presence;
 *   - the native kit's `PlatformUI.sheet()` adopts the real element on touch
 *     platforms, so there has to be a real element to adopt.
 *
 * So the panel is always mounted and `hidden` is toggled on it, exactly as the
 * hand-written markup did. No new dependency: @radix-ui/* is deliberately
 * absent from frontend/package.json.
 *
 * ── Why the class string is a constant ────────────────────────────────
 *
 * It goes nowhere near `cn`. tailwind-merge treats `hidden` and `flex` as one
 * group and would drop the first — and this string needs both, for the same
 * reason the view-as-non-admin banner does (see features/shell/banners.tsx).
 * It is also never re-rendered: on touch the kit writes
 * `platform-sheet-adopted` onto this very node, and a re-render of `className`
 * would wipe it.
 */

import type { ReactNode, Ref } from 'react';

/** The exact class string both panels shipped with, character for character. */
export const ANCHORED_PANEL_CLASS = 'hidden fixed top-14 right-3 z-50 w-80 max-w-[95vw] max-h-[70vh] flex flex-col bg-white dark:bg-zinc-900 border border-[var(--frame-line)] rounded-sm shadow-2xl overflow-hidden';

export function AnchoredPanel({
  id,
  ref,
  children,
}: {
  id: string;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  return (
    <div ref={ref} id={id} className={ANCHORED_PANEL_CLASS}>
      {children}
    </div>
  );
}

/**
 * The panel's header row: title on the left, a flex spacer, then whatever
 * actions the panel wants on the right.
 */
export function AnchoredPanelHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {title}
      </span>
      <span className="flex-1">
      </span>
      {children}
    </div>
  );
}
