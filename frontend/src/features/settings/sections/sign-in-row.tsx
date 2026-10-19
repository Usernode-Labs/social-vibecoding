import type { ReactNode } from 'react';

import { ListRow } from '@/components/ui/grouped-list';

/**
 * The Account page's sign-in rows (#5281): Username, Email & recovery and
 * Password, each READ first. The page used to open on three forms at once,
 * each with its own full-width button, so a person who came to look at their
 * email address met a password field. Now each part is one row (what it is,
 * what it holds) with a Change link, and the form opens under its row only
 * when asked, with a Cancel beside its submit. One is open at a time:
 * settings.js closes the other two (`_openAccountEditor`), and the Email part,
 * which is React-owned, follows the same event.
 *
 * Static on purpose, like the sections that use it: no state, no effects.
 * Username and Password are bound by id from settings.js, which writes the
 * value line and toggles the form; a React re-render over those nodes is the
 * failure ./index.tsx describes.
 */

/** The Change / Add link at the end of a row: a button, because it opens a
 * form in place rather than going anywhere. */
export const ROW_ACTION = 'shrink-0 -my-1 rounded-lg px-2 py-1 text-[15px] font-medium '
  + 'text-violet-700 hover:text-violet-500 dark:text-violet-400 dark:hover:text-violet-300 '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';

/** The open form under its row: inset to the row's text, a hairline above. */
export const ROW_EDITOR = 'border-t border-zinc-200 dark:border-zinc-800 px-4 pt-3 pb-4 space-y-3';

/** A form's own small title, which says what the open form will do. */
export const EDITOR_TITLE = 'text-[15px] font-[650] text-zinc-900 dark:text-zinc-100';

/** The small print under a form. */
export const EDITOR_NOTE = 'text-xs text-zinc-500 dark:text-zinc-400';

/** Submit and Cancel, side by side and as wide as their words. */
export const EDITOR_ACTIONS = 'flex flex-wrap items-center gap-2';

export function SignInRow({ title, value, action }: {
  title: ReactNode;
  value: ReactNode;
  action: ReactNode;
}) {
  return (
    <ListRow
      title={title}
      subtitle={value}
      chevron={false}
      inset="none"
      trailing={action}
    />
  );
}
