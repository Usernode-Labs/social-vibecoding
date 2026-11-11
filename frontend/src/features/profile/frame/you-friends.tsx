/**
 * Friends, as a tab of You under a look (the version 2 tour's s49). It is the
 * standard Friends card's content (../friends-section.tsx) in two columns:
 * the username search, then one group holding the people who asked (Decline,
 * Accept) and your friends, each a door to their page, with the line saying
 * only you see it; the requests you sent, each with Cancel, in the side
 * column. Private to you, and it counts nothing.
 *
 * The lists are the profile's own view (../profile-store.js friendsView) and
 * the answers go through ../profile.js, as the card's do. The search is the
 * product's own (../../friends/friend-search.tsx), wearing the look (app.css).
 */
import { Av, Btn, Card, Note, Row, Sec, SecNote } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { FriendSearch } from '../../friends/friend-search';
import type { FriendsSectionView } from '../friends-section';
import { Profile } from '../profile.js';
import { YouPage, type YouShell } from './you-frame';

export function YouFriends({ shell, view, pendingId, status }: {
  shell: YouShell;
  view: FriendsSectionView;
  /** The request being answered: its buttons are off meanwhile. */
  pendingId: number | null;
  /** Why the last answer failed, if it did. */
  status: string;
}) {
  const t = useMessages('profile');
  const outgoing = view.outgoing || [];
  return (
    <YouPage
      shell={shell}
      side={outgoing.length ? (
        <Sec label={t('profile:friends.sentHeading')} data-you-friends-sent="">
          <Card>
            {outgoing.map((row) => (
              <Row
                key={row.key}
                wrap
                lead={<Av size={40} name={row.username} src={row.avatarUrl} />}
                title={<a href={row.href}>{`@${row.username}`}</a>}
                line={row.meta}
                right={(
                  <Btn kind="quiet" small data-friend-sent-cancel={row.username} disabled={pendingId === row.id} onClick={() => { void Profile.cancelFriendRequest(row.id); }}>
                    {t('profile:friends.cancelRequest')}
                  </Btn>
                )}
              />
            ))}
          </Card>
        </Sec>
      ) : undefined}
    >
      <div data-you-friends-search=""><FriendSearch lists={view} /></div>
      <Sec label={t('profile:friends.title')} aria-label={t('profile:friends.label')} data-you-friends="">
        {view.incoming.length || view.friends.length ? (
          <Card>
            {view.incoming.map((row) => (
              <Row
                key={row.key}
                wrap
                lead={<Av size={40} name={row.username} src={row.avatarUrl} />}
                // The name is the way to their page; the row itself holds two buttons, and a link may not wrap them.
                title={<a href={row.href}>{`@${row.username}`}</a>}
                line={row.meta}
                right={(
                  <>
                    <Btn kind="quiet" small data-friend-request-decline={row.username} disabled={pendingId === row.id} onClick={() => { void Profile.answerFriendRequest(row.id, false); }}>
                      {t('profile:friends.decline')}
                    </Btn>
                    <Btn small data-friend-request-accept={row.username} disabled={pendingId === row.id} onClick={() => { void Profile.answerFriendRequest(row.id, true); }}>
                      {t('profile:friends.accept')}
                    </Btn>
                  </>
                )}
              />
            ))}
            {view.friends.map((row) => (
              <Row key={row.key} href={row.href} lead={<Av size={40} name={row.username} src={row.avatarUrl} />} title={`@${row.username}`} line={row.meta} />
            ))}
          </Card>
        ) : null}
        {view.friends.length ? null : <Card pad>{view.loaded ? t('profile:friends.empty') : t('profile:friends.loadFailed')}</Card>}
        {status ? <div role="alert"><Note tone="bad" icon="alert">{status}</Note></div> : null}
        <SecNote>{t('profile:friends.privacy')}</SecNote>
      </Sec>
    </YouPage>
  );
}
