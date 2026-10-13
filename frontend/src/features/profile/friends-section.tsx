/**
 * "Friends" on your OWN profile (#2386) — private to you, and it says so.
 *
 * Requests waiting on you lead, each with Accept and Decline right on the
 * row; your friends follow, each a link to their page (where Unfriend lives,
 * behind "Friends ✓"); the requests you sent close the section, each with
 * Cancel, because the pending cap sends you here to withdraw one. Nothing
 * here is ever drawn on someone else's page, and nothing counts anything: no
 * "12 friends" line, here or anywhere.
 *
 * Shaped by ./profile-store.js `friendsView`; the answers go through
 * `Profile.answerFriendRequest`, which moves the row at once and then re-reads
 * the lists. The rows reuse the grouped list the rest of Me is drawn with.
 *
 * A username search leads the section (../friends/friend-search.tsx, #3048),
 * so a friend can be added without opening their page first.
 */

import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, PLANE_FILL, SectionHeader } from '@/components/ui/grouped-list';
import { useMessages } from '../../lib/i18n/react';
import { FriendSearch } from '../friends/friend-search';
import { Profile } from './profile.js';

type FriendRowView = {
  key: string;
  id: number;
  username: string;
  href: string;
  avatarUrl: string | null;
  initial: string;
  meta: string | null;
};

export type FriendsSectionView = {
  loaded: boolean;
  incoming: FriendRowView[];
  friends: FriendRowView[];
  outgoing?: FriendRowView[];
};

/** The person's round picture, or their initial — the Me card's idiom, a size down. */
function FriendAvatar({ row }: { row: FriendRowView }): ReactNode {
  if (row.avatarUrl) {
    return (
      <img
        className="w-10 h-10 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={row.avatarUrl}
        alt=""
        loading="lazy"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={
        'w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold '
        + 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }
    >
      {row.initial}
    </span>
  );
}

export function FriendsSection({
  view,
  pendingId,
  status,
  heading = true,
}: {
  view: FriendsSectionView;
  pendingId: number | null;
  status: string;
  /** Off in the Friends card (./friends-sheet.tsx), whose own title says it. */
  heading?: boolean;
}): ReactNode {
  const t = useMessages('profile');
  return (
    <section id="profile-friends" className="mt-2" aria-label={t('profile:friends.label')}>
      {heading ? <SectionHeader>{t('profile:friends.title')}</SectionHeader> : null}
      {/* #3048: find people by username and add them right here. */}
      <FriendSearch lists={view} />
      {view.incoming.length ? (
        <GroupedList id="profile-friend-requests" className="mx-0 mb-3" tone="plane">
          {view.incoming.map((row) => (
            <ListRow
              key={row.key}
              data-friend-request={row.username}
              leading={<FriendAvatar row={row} />}
              // The name is the way to their page; the row itself holds two
              // buttons, and an anchor may not wrap them.
              title={<a href={row.href} className="hover:underline">{`@${row.username}`}</a>}
              titleClassName="text-base font-semibold"
              subtitle={row.meta}
              subtitleClassName="text-[0.8125rem] whitespace-normal line-clamp-2"
              chevron={false}
              trailing={(
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    data-friend-request-accept={row.username}
                    disabled={pendingId === row.id}
                    className="disabled:opacity-60"
                    onClick={() => { void Profile.answerFriendRequest(row.id, true); }}
                  >
                    {t('profile:friends.accept')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="neutral"
                    ink="neutral"
                    data-friend-request-decline={row.username}
                    disabled={pendingId === row.id}
                    className="disabled:opacity-60"
                    onClick={() => { void Profile.answerFriendRequest(row.id, false); }}
                  >
                    {t('profile:friends.decline')}
                  </Button>
                </div>
              )}
            />
          ))}
        </GroupedList>
      ) : null}
      {view.friends.length ? (
        <GroupedList id="profile-friends-list" className="mx-0" tone="plane">
          {view.friends.map((row) => (
            <ListRow
              key={row.key}
              as="a"
              href={row.href}
              data-friend={row.username}
              leading={<FriendAvatar row={row} />}
              title={`@${row.username}`}
              titleClassName="text-base font-semibold"
              subtitle={row.meta}
              subtitleClassName="text-[0.8125rem]"
            />
          ))}
        </GroupedList>
      ) : (
        <div
          id="profile-friends-empty"
          className={`rounded-2xl ${PLANE_FILL} p-4 text-center text-sm text-zinc-500 dark:text-zinc-400`}
        >
          {view.loaded
            ? t('profile:friends.empty')
            : t('profile:friends.loadFailed')}
        </div>
      )}
      {view.outgoing?.length ? (
        <>
          <p className="px-4 pt-4 pb-2 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{t('profile:friends.sentHeading')}</p>
          <GroupedList id="profile-friend-sent" className="mx-0" tone="plane">
            {view.outgoing.map((row) => (
              <ListRow
                key={row.key}
                data-friend-sent={row.username}
                leading={<FriendAvatar row={row} />}
                title={<a href={row.href} className="hover:underline">{`@${row.username}`}</a>}
                titleClassName="text-base font-semibold"
                subtitle={row.meta}
                subtitleClassName="text-[0.8125rem] whitespace-normal line-clamp-2"
                chevron={false}
                trailing={(
                  <Button
                    type="button"
                    size="sm"
                    variant="neutral"
                    ink="neutral"
                    data-friend-sent-cancel={row.username}
                    disabled={pendingId === row.id}
                    className="shrink-0 disabled:opacity-60"
                    onClick={() => { void Profile.cancelFriendRequest(row.id); }}
                  >
                    {t('profile:friends.cancelRequest')}
                  </Button>
                )}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
      {status ? (
        <p role="alert" className="px-4 pt-2 text-sm text-red-700 dark:text-red-400">{status}</p>
      ) : null}
      <p className="px-4 pt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {t('profile:friends.privacy')}
      </p>
    </section>
  );
}
