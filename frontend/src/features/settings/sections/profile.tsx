import { useCallback, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { ChevronRightIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';
import { displayNameOf, initialOf } from '../../profile/profile-store.js';

/**
 * The Profile part — the head of the Account page.
 *
 * Name, photo, bio and the public page are edited in Me's Edit profile
 * sheet, which Settings had no way to reach: someone who came to Settings to
 * change their name found a username form and nothing else. This part is
 * that way in. It shows who is signed in and links to `#profile?edit`, which
 * opens Me with the sheet already up (features/profile/profile.js,
 * `_takeSheetAsk('edit')`), the same address shape as `#profile?friends`.
 *
 * STATEFUL, like ./theme.tsx and for the same reason: settings.js binds
 * nothing inside it, so React is the only writer here. It reads App.user on
 * mount and again whenever a page is shown (`usernode:settings-section`), so
 * a name changed in the sheet is current when the viewer comes back. It
 * renders the empty card until then; the panes mount on reveal, never in the
 * prerender, so there is no server markup to match.
 */

interface ProfileUser {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

function readUser(): ProfileUser | null {
  const user = (window as { App?: { user?: ProfileUser | null } }).App?.user;
  return user && typeof user === 'object' ? user : null;
}

function Avatar({ user }: { user: ProfileUser | null }) {
  if (user?.avatarUrl) {
    return (
      <img
        className="w-11 h-11 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={user.avatarUrl}
        alt=""
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="w-11 h-11 text-lg rounded-full shrink-0 flex items-center justify-center font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
    >
      {initialOf(user)}
    </span>
  );
}

export function ProfileSection() {
  const t = useMessages('settings');
  const [user, setUser] = useState<ProfileUser | null>(null);
  const sync = useCallback(() => setUser(readUser()), []);
  useIsomorphicLayoutEffect(() => { sync(); }, [sync]);
  useWindowEvent('usernode:settings-section', sync);

  // The handle line only when a display name is the headline; otherwise the
  // name already IS the handle (displayNameOf falls back to "@username").
  const named = !!(user?.displayName && String(user.displayName).trim());
  const handle = named && user?.username ? `@${user.username}` : null;

  return (
    <div data-settings-section="profile" className="hidden">
      <div id="settings-profile-section">
        <SectionHeading title={t('settings:profile.title')}>
          {t('settings:profile.intro')}
        </SectionHeading>
        <a
          id="settings-profile-card"
          href="#profile?edit"
          className="flex items-center gap-3 rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
        >
          <Avatar user={user} />
          <span className="flex-1 min-w-0">
            <span className="block text-[17px] font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {displayNameOf(user)}
            </span>
            {handle ? (
              <span className="block text-[15px] text-zinc-500 dark:text-zinc-400 truncate">{handle}</span>
            ) : null}
          </span>
          <span className="text-[15px] font-medium text-violet-700 dark:text-violet-400 shrink-0">{t('settings:profile.edit')}</span>
          <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
