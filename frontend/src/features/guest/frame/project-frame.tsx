/**
 * A public community's page for a visitor, in the one frame, under any of
 * the five looks: version 2 of the screen tour's steps o20, o21, w12 and
 * w13 (docs/superpowers/plans/2026-11-11-looks-v2-todays-content.md). The
 * first tour's layout (the kit's head with one primary button, the places
 * as tabs, two columns) holding today's read-only page (../guest-project
 * .tsx), section for section:
 *
 *   the head      the icon, the name, "Public community", the sentence,
 *                 how many built it and used it lately (by the standard
 *                 band's own minimums), then Try it, Join, Pin and Share
 *   Hub           Up for a vote (each change a card: its before and after,
 *                 its name and sentence, the tally and Vote) and Recently
 *                 voted in; beside them the picture, What's happening,
 *                 People and From the chat. On a phone the picture and
 *                 What's happening lead and People and the chat come last,
 *                 as on the standard page.
 *   Workshop      every change up for a vote; Requests beside them
 *   Discussion    the chat is for members, and how to join
 *
 * Whatever needs membership says so in its own word (Vote, Join, Ask for
 * something) and opens the landing's sign-in sheet titled for it. An
 * account still in line (`signedIn`) reads the same page: Try it and Share
 * in its head, and "once you're in" where a visitor is offered a button.
 *
 * A VIEW ONLY. The product's page reads the overview (GET /api/public/apps/
 * :slug/overview), keeps the tab and the device's pin, and under a look
 * returns this in place of its own markup, with the same handlers; so
 * there is one read and one state whichever look draws.
 */
import { Btn, Card, GroupLink, Icon, Lead, Meta, PageBody, Prog, Row, Sec, Shot, Shots, Tabs, Tile, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';
import { type GuestApp, type GuestOverview, type GuestVote, MIN_ACTIVE, MIN_BUILDERS, buildersOf } from '../guest-data';
import type { GuestIntent } from '../guest-project';

export type GuestProjectTab = 'hub' | 'workshop' | 'discussion';

export function GuestProjectFrame({ app, overview, loaded, tab, onTab, signedIn, pinned, onPin, canTry, color, onIntent, onOpenInside, onShare, now }: {
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
  /** The community's colour (lib/community-color.ts), under its icon where it has no picture. */
  color?: string | null;
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
  // The standard band's own rule: counts only from the cards' minimums, and
  // under them what changed this week, when anything did.
  const active = (app.active_users || 0) >= MIN_ACTIVE ? app.active_users || 0 : 0;
  const bandBuilders = builders >= MIN_BUILDERS ? builders : 0;
  const week = app.merged_week || 0;
  const facts = bandBuilders || active
    ? [bandBuilders ? t('auth:guest.project.builders', { count: bandBuilders }) : '', active ? t('auth:guest.project.active', { count: active }) : ''].filter(Boolean).join(' · ')
    : week ? t('auth:guest.card.week', { count: week }) : '';
  const votes = overview?.votes || [];
  const voteCount = Math.max(overview?.app.open_votes ?? app.open_votes ?? 0, votes.length);
  const requests = overview?.requests || null;
  const updated = ago(app.last_merged_at || app.last_deploy_at || null);
  const untitled = t('auth:guest.project.untitledChange');
  const face = (size: number) => <Tile size={size} name={app.name || app.slug} src={app.icon_url} emoji={app.icon_emoji} color={app.icon_color} />;

  /** One change up for a vote, as the standard page's card says it. */
  const voteCard = (v: GuestVote) => {
    const title = v.title || untitled;
    const cast = v.yes + v.no;
    return (
      <Card key={v.id}>
        {v.pictures ? (
          <Shots>
            {v.pictures.before ? <Shot src={v.pictures.before} label={t('auth:guest.project.before')} /> : null}
            <Shot src={v.pictures.after} label={t('auth:guest.project.after')} />
          </Shots>
        ) : null}
        <div className={k('ballot', 'visit')} data-guest-vote={v.id}>
          <div>
            <h3 className={k('sub17')}>{title}</h3>
            {v.summary ? <p className={k('sum')}>{v.summary}</p> : null}
          </div>
          <Prog value={cast ? v.yes / cast : 0} />
          <div className={k('line1')}>
            <span>{t('auth:guest.project.tally', { yes: v.yes, no: v.no })}</span>
            {signedIn
              ? <span className={k('later')} data-guest-vote-later="">{t('auth:guest.project.voteLater')}</span>
              : <Btn small kind="quiet" data-guest-vote-btn="" onClick={() => onIntent({ kind: 'vote', app, change: title })}>{t('auth:guest.project.vote')}</Btn>}
          </div>
        </div>
      </Card>
    );
  };

  const acts = (
    <>
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
      {signedIn ? null : <Btn kind="line" data-guest-join-project="" onClick={() => onIntent({ kind: 'join', app })}>{t('auth:guest.project.join')}</Btn>}
      {signedIn ? null : (
        <Btn kind="line" data-guest-pin-project="" aria-pressed={pinned} onClick={onPin}>{pinned ? th('home:guest.pinnedCommunity') : th('home:guest.pinCommunity')}</Btn>
      )}
      <Btn kind="line" icon="share" onClick={() => onShare(app)}>{t('auth:guest.project.share')}</Btn>
    </>
  );

  /** Who made it and who uses it, then the chat's door: the Hub's last two groups. */
  const people = (
    <>
      <Sec label={t('auth:guest.project.peopleLabel')}>
        <Card>
          <Row lead={<Lead icon="users" />} title={t('auth:guest.project.builders', { count: builders })} line={active > 0 ? t('auth:guest.project.active', { count: active }) : undefined} />
        </Card>
      </Sec>
      <Sec label={t('auth:guest.project.fromChat')}>
        <Card>
          {/* The row is the door; its word is Join, not a button inside a button. */}
          <Row
            lead={<Lead icon="chat" />}
            title={t('auth:guest.project.chatMembers')}
            line={signedIn ? t('auth:guest.project.joinLater') : t('auth:guest.project.chatJoin', { project: app.name })}
            right={signedIn ? null : <span className="fr-btn fr-quiet fr-sm">{t('auth:guest.project.join')}</span>}
            onClick={signedIn ? undefined : () => onIntent({ kind: 'chat', app })}
            wrap="all"
          />
        </Card>
      </Sec>
    </>
  );

  const hubSide = (
    <>
      <div className={k('cover')} style={color && !app.illustration_url ? ({ '--fr-tc': color } as React.CSSProperties) : undefined} aria-hidden="true" data-guest-hero="">
        {app.illustration_url ? <img src={app.illustration_url} alt="" className={k('sun')} /> : face(72)}
        {app.illustration_url && app.illustration_dark_url ? <img src={app.illustration_dark_url} alt="" className={k('moon')} /> : null}
      </div>
      {voteCount > 0 || (requests && requests.total > 0) || updated ? (
        <Sec label={t('auth:guest.project.happening')}>
          <Card>
            {voteCount > 0 ? <Row title={t('auth:guest.project.votesOpen', { count: voteCount })} onClick={() => onTab('workshop')} go sm /> : null}
            {requests && requests.total > 0 ? (
              <Row
                title={requests.more ? t('auth:guest.project.requestsOpenMore', { total: requests.total }) : t('auth:guest.project.requestsOpen', { count: requests.total })}
                onClick={() => onTab('workshop')}
                go
                sm
              />
            ) : null}
            {updated ? <Row title={t('auth:guest.project.updated', { when: updated })} sm /> : null}
          </Card>
        </Sec>
      ) : null}
      <div className={k('d', 'stack')}>{people}</div>
    </>
  );

  const workshopSide = (
    <Sec
      label={t('auth:guest.project.requests')}
      action={signedIn ? null : <GroupLink onClick={() => onIntent({ kind: 'ask', app })}>{t('auth:guest.project.ask')}</GroupLink>}
    >
      {requests && requests.items.length ? (
        <Card>
          {requests.items.map((r) => <Row key={r.number} title={r.title} wrap sm />)}
          {requests.total > requests.items.length ? (
            <p className={k('cardnote', 'last')}>{t('auth:guest.project.moreRequests', { count: requests.total - requests.items.length })}</p>
          ) : null}
        </Card>
      ) : (
        <Card pad>{!loaded ? t('auth:guest.project.loading') : requests ? t('auth:guest.project.noRequests') : t('auth:guest.project.requestsUnavailable')}</Card>
      )}
    </Sec>
  );

  return (
    <PageBody
      data-guest-project-frame={app.slug}
      data-guest-project-tab={tab}
      lead={face(56)}
      title={app.name}
      under={t('auth:guest.project.audience')}
      purpose={app.description || facts ? (
        <>
          {app.description}
          {facts ? <span className={k('sub13')} data-guest-project-facts="">{facts}</span> : null}
        </>
      ) : undefined}
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
      side={tab === 'hub' ? hubSide : tab === 'workshop' ? workshopSide : undefined}
      sideFirst={tab === 'hub'}
    >
      {tab === 'hub' ? (
        <>
          {votes.length ? (
            <Sec label={t('auth:guest.project.upForVote')}>
              {votes.slice(0, 3).map(voteCard)}
            </Sec>
          ) : null}
          {overview?.merged.length ? (
            <Sec label={t('auth:guest.project.votedIn')}>
              <Card>
                {overview.merged.slice(0, 3).map((m) => (
                  <Row key={m.id} title={m.title || untitled} line={m.summary || undefined} right={m.merged_at ? <Meta>{ago(m.merged_at)}</Meta> : null} wrap="all" />
                ))}
              </Card>
            </Sec>
          ) : null}
          <div className={k('p', 'stack')}>{people}</div>
        </>
      ) : null}

      {tab === 'workshop' ? (
        <Sec label={t('auth:guest.project.upForVote')}>
          {votes.length ? votes.map(voteCard) : <Card pad>{loaded ? t('auth:guest.project.noVotes') : t('auth:guest.project.loading')}</Card>}
        </Sec>
      ) : null}

      {tab === 'discussion' ? (
        <Card pad>
          <div className={k('sub17')}>{t('auth:guest.project.chatMembers')}</div>
          <p className={k('purpose')}>{signedIn ? t('auth:guest.project.joinLater') : t('auth:guest.project.chatJoin', { project: app.name })}</p>
          {signedIn ? null : (
            <div className={k('btnrow')}>
              <Btn data-guest-chat-join="" onClick={() => onIntent({ kind: 'chat', app })}>{t('auth:guest.project.join')}</Btn>
            </div>
          )}
        </Card>
      ) : null}
    </PageBody>
  );
}
