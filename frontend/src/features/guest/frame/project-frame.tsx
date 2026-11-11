/**
 * A public community's page for a visitor, in the one frame, as the
 * 2026-11-06 screen tour draws it (its steps o22 to o25: the member's Hub
 * and Workshop in guest mode), under any of the nine looks. It is the
 * member's page, readable: the same head, the places as tabs, groups of
 * rows in the 720px column and who is here in the 320px one. Whatever needs
 * membership says so in its own word (Vote, Join, Ask for something) and
 * opens the landing's sign-in sheet titled for it.
 *
 * A VIEW ONLY. The product's page (../guest-project.tsx) reads the overview
 * (GET /api/public/apps/:slug/overview), keeps the tab and the device's
 * pin, and under a look returns this in place of its own markup, with the
 * same handlers; so there is one read and one state whichever look draws.
 *
 * A vote is a row here, not the kit's ballot: the public overview gives the
 * yeses and the noes, not how many may vote or how many it takes, and a bar
 * with no line to reach would say less than the words do. Its before and
 * after are shown in the Workshop, where the votes are the page.
 */
import { Btn, Card, GroupLink, Icon, Lead, Meta, Note, PageBody, Row, Sec, Shot, Shots, Tabs, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';
import { type GuestApp, type GuestOverview, type GuestVote, MIN_ACTIVE, buildersOf } from '../guest-data';
import type { GuestIntent } from '../guest-project';

export type GuestProjectTab = 'hub' | 'workshop' | 'discussion';

export function GuestProjectFrame({ app, overview, loaded, tab, onTab, signedIn, pinned, onPin, canTry, onIntent, onOpenInside, onShare, now }: {
  app: GuestApp;
  overview: GuestOverview | null;
  loaded: boolean;
  tab: GuestProjectTab;
  onTab: (tab: GuestProjectTab) => void;
  /** An account still in line: it reads as a visitor does, and is not offered what cannot work yet. */
  signedIn: boolean;
  pinned: boolean;
  onPin: () => void;
  /** The app opens without an account, here. */
  canTry: boolean;
  onIntent: (intent: GuestIntent) => void;
  onOpenInside: (app: GuestApp) => void;
  onShare: (app: GuestApp) => void;
  /** The moment "ago" is counted from; a render test pins it. */
  now?: number;
}) {
  const t = useMessages('auth');
  const th = useMessages('home');
  const ago = (at: string | null | undefined) => (at ? agoStamp(at, now ? { now: new Date(now) } : {}).text : '');

  const builders = overview?.app.builders ?? buildersOf(app);
  const active = (app.active_users || 0) >= MIN_ACTIVE ? app.active_users || 0 : 0;
  const votes = overview?.votes || [];
  const voteCount = Math.max(overview?.app.open_votes ?? app.open_votes ?? 0, votes.length);
  const requests = overview?.requests || null;
  const updated = ago(app.last_merged_at || app.last_deploy_at || null);
  const untitled = t('auth:guest.project.untitledChange');

  const voteRow = (v: GuestVote) => {
    const title = v.title || untitled;
    return (
      <Row
        key={v.id}
        title={title}
        line={t('auth:guest.project.tally', { yes: v.yes, no: v.no })}
        right={signedIn ? <Meta>{t('auth:guest.project.voteLater')}</Meta> : <span className="fr-btn fr-quiet fr-sm">{t('auth:guest.project.vote')}</span>}
        onClick={signedIn ? undefined : () => onIntent({ kind: 'vote', app, change: title })}
        label={signedIn ? undefined : `${t('auth:guest.project.vote')}: ${title}`}
      />
    );
  };

  const acts = (
    <>
      <Btn kind="line" icon="share" aria-label={t('auth:guest.project.share')} onClick={() => onShare(app)} />
      {signedIn ? null : (
        <Btn kind="line" aria-pressed={pinned} onClick={onPin}>{pinned ? th('home:guest.pinnedCommunity') : th('home:guest.pinCommunity')}</Btn>
      )}
      {signedIn ? null : <Btn kind="line" onClick={() => onIntent({ kind: 'join', app })}>{t('auth:guest.project.join')}</Btn>}
      {signedIn || canTry ? (
        <a
          className={k('btn')}
          href={app.url}
          data-guest-try={app.slug}
          onClick={(event) => {
            // As the standard page's Try it (../guest-discover.tsx TryLink).
            if (signedIn || app.requires_login === false) { event.preventDefault(); onOpenInside(app); }
          }}
        >
          <Icon name="play" size={17} />
          {t('auth:guest.card.tryIt')}
        </a>
      ) : (
        <Btn data-guest-use="" onClick={() => onIntent({ kind: 'use', app })}>{t('auth:guest.project.signInToUse')}</Btn>
      )}
    </>
  );

  const membersOnly = (
    <Card pad>
      <div className={k('sub17')}>{t('auth:guest.project.chatMembers')}</div>
      <p className={k('purpose')}>{signedIn ? t('auth:guest.project.joinLater') : t('auth:guest.project.chatJoin', { project: app.name })}</p>
      {signedIn ? null : (
        <div className={k('btnrow')}>
          <Btn data-guest-chat-join="" onClick={() => onIntent({ kind: 'chat', app })}>{t('auth:guest.project.join')}</Btn>
        </div>
      )}
    </Card>
  );

  // Who made it and who uses it stand beside every tab, as the standard
  // page's band says them over all three; the chat's door is the Hub's.
  const side = (
    <>
      <Sec label={t('auth:guest.project.peopleLabel')}>
        <Card>
          <Row lead={<Lead icon="users" />} title={t('auth:guest.project.builders', { count: builders })} line={active > 0 ? t('auth:guest.project.active', { count: active }) : undefined} />
          <Row lead={<Lead icon="globe" />} title={t('auth:guest.project.audience')} sm />
        </Card>
      </Sec>
      {tab !== 'hub' ? null : <Sec label={t('auth:guest.project.fromChat')}>
        <Card>
          <Row
            lead={<Lead icon="chat" />}
            title={t('auth:guest.project.chatMembers')}
            line={signedIn ? t('auth:guest.project.joinLater') : undefined}
            right={signedIn ? null : <span className="fr-btn fr-quiet fr-sm">{t('auth:guest.project.join')}</span>}
            onClick={signedIn ? undefined : () => onIntent({ kind: 'chat', app })}
            wrap
          />
        </Card>
      </Sec>}
    </>
  );

  return (
    <PageBody
      data-guest-project-frame={app.slug}
      title={app.name}
      purpose={app.description || t('auth:guest.project.audience')}
      acts={acts}
      tabs={(
        <Tabs
          tabs={[
            { key: 'hub', label: t('auth:guest.project.tab.hub') },
            { key: 'workshop', label: t('auth:guest.project.tab.workshop') },
            { key: 'discussion', label: t('auth:guest.project.tab.discussion') },
          ]}
          current={tab}
          onPick={(key) => onTab(key as GuestProjectTab)}
        />
      )}
      side={side}
    >
      {signedIn ? null : <Note icon="eye">{t('auth:frame.project.guest')}</Note>}

      {tab === 'hub' ? (
        <>
          {voteCount > 0 || (requests && requests.total > 0) || updated ? (
            <Sec label={t('auth:guest.project.happening')}>
              <Card>
                {voteCount > 0 ? <Row lead={<Lead icon="vote" tone="acc" />} title={t('auth:guest.project.votesOpen', { count: voteCount })} onClick={() => onTab('workshop')} go sm /> : null}
                {requests && requests.total > 0 ? (
                  <Row
                    lead={<Lead icon="chat" />}
                    title={requests.more ? t('auth:guest.project.requestsOpenMore', { total: requests.total }) : t('auth:guest.project.requestsOpen', { count: requests.total })}
                    onClick={() => onTab('workshop')}
                    go
                    sm
                  />
                ) : null}
                {updated ? <Row lead={<Lead icon="clock" />} title={t('auth:guest.project.updated', { when: updated })} sm /> : null}
              </Card>
            </Sec>
          ) : null}
          {votes.length ? (
            <Sec label={t('auth:guest.project.upForVote')}>
              <Card>{votes.slice(0, 3).map(voteRow)}</Card>
            </Sec>
          ) : null}
          {overview?.merged.length ? (
            <Sec label={t('auth:guest.project.votedIn')}>
              <Card>
                {overview.merged.slice(0, 3).map((m) => (
                  <Row key={m.id} lead={<Lead icon="check" tone="ok" />} title={m.title || untitled} line={m.summary || undefined} right={<Meta>{ago(m.merged_at)}</Meta>} />
                ))}
              </Card>
            </Sec>
          ) : null}
        </>
      ) : null}

      {tab === 'workshop' ? (
        <>
          <Sec label={t('auth:guest.project.upForVote')}>
            {votes.length ? votes.map((v) => (
              <Card key={v.id}>
                {v.pictures ? (
                  <Shots>
                    {v.pictures.before ? <Shot src={v.pictures.before} label={t('auth:guest.project.before')} /> : null}
                    <Shot src={v.pictures.after} label={t('auth:guest.project.after')} />
                  </Shots>
                ) : null}
                {voteRow(v)}
              </Card>
            )) : <Card pad>{loaded ? t('auth:guest.project.noVotes') : t('auth:guest.project.loading')}</Card>}
          </Sec>
          <Sec
            label={t('auth:guest.project.requests')}
            action={signedIn ? null : <GroupLink onClick={() => onIntent({ kind: 'ask', app })}>{t('auth:guest.project.ask')}</GroupLink>}
          >
            {requests && requests.items.length ? (
              <Card>
                {requests.items.map((r) => <Row key={r.number} lead={<Lead icon="chat" />} title={r.title} sm />)}
                {requests.total > requests.items.length ? (
                  <Row title={t('auth:guest.project.moreRequests', { count: requests.total - requests.items.length })} sm />
                ) : null}
              </Card>
            ) : (
              <Card pad>{!loaded ? t('auth:guest.project.loading') : requests ? t('auth:guest.project.noRequests') : t('auth:guest.project.requestsUnavailable')}</Card>
            )}
          </Sec>
        </>
      ) : null}

      {tab === 'discussion' ? membersOnly : null}
    </PageBody>
  );
}
