/**
 * The account row at the foot of Home — the entrance to the Profile screen.
 *
 * ── Why Home carries it ───────────────────────────────────────────────
 *
 * Profile's only link used to be a row in the hamburger drawer, and the
 * Streamlined Concept retired the hamburger. That left Profile, and through
 * it Settings and Admin, with no entrance at all — reachable only by typing
 * the hash. Home is the root screen and the one already about "your stuff",
 * so it is where the door goes.
 *
 * LAST in the reading order, which the home screen states for itself: your
 * apps, then what to try next, then what the group is working towards, then
 * make something — and then you. An account entry belongs at the foot of that
 * sentence, not the head of it; putting it first would push the launcher grid
 * down for something nobody opens Home to do.
 *
 * ── The avatar is app.js's, by id ─────────────────────────────────────
 *
 * `App.applyUserAvatar` swaps which of `#home-account-avatar` /
 * `#home-account-glyph` carries `hidden`, from `App.user.avatarUrl`. Both
 * ship as this component renders them and neither has children, so the write
 * is a `hidden` toggle on a constant className — the same sanctioned seam the
 * drawer row it replaces ran under. The `<img>` ships with no `src`, so a
 * signed-out shell and an account with no picture both keep the glyph and
 * nothing requests `/avatars/` until there is something to request.
 */

import { ChevronRightIcon, UserCircleIcon } from '@/components/ui/icons';

export function AccountPanel() {
  return (
    <a
      id="home-account-row"
      href="#profile"
      className={'flex items-center gap-3 rounded-sm border border-[var(--frame-line)] bg-white dark:bg-zinc-900 '
        + 'px-3 min-h-[56px] hover:bg-zinc-50 dark:hover:bg-zinc-800'}
    >
      <span className="relative w-9 h-9 shrink-0 flex items-center justify-center">
        <UserCircleIcon
          id="home-account-glyph"
          className="w-9 h-9 text-zinc-400 dark:text-zinc-500"
          aria-hidden="true"
        />
        <img
          id="home-account-avatar"
          alt=""
          className="hidden absolute inset-0 w-9 h-9 rounded-full object-cover"
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Profile
        </span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
          Your points, settings and account
        </span>
      </span>
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
    </a>
  );
}
