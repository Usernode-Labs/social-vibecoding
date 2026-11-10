/**
 * All communities, the page under Home the 2026-11-06 screen tour draws
 * (its step s04): the frame with tabs by audience and a search, then the
 * communities as rows grouped by what they need, each ending in the blue
 * pill only when it waits for you. The votes owed and where pins live sit
 * in the side column.
 *
 * Reached from Home's "All N" link and from "All communities" in the
 * frame's sidebar (the shell's own Home.showCommunities, whose event
 * ./home-frame.tsx listens for). The communities are the viewer's own, as
 * Home lists them (../home-pins-store); their audience, members and votes
 * owed come from the store the shell's sidebar reads
 * (../../workshop/community-scope).
 */
import { useState } from 'react';

import { Btn, Card, GroupLink, Note, PageBody, Pill, Row, Search, Sec, Tabs, Tile } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { useFramePage } from '../../frame/frame-page-store';
import { communityScopeStore } from '../../workshop/community-scope';
import { homePinsStore, type HomePin } from '../home-pins-store';

type Filter = 'all' | 'open' | 'invited' | 'solo' | 'notPinned';
export type OwedVote = { key: string; title: string; community: string; slug: string; iconUrl?: string | null; iconEmoji?: string | null };

const hubHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=status`;

function openHub(event: React.MouseEvent<HTMLElement>, slug: string) {
  const win = window as any;
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { win.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

export function HomeAllCommunities({ onBack, mine, votes }: { onBack: () => void; mine: HomePin[]; votes: OwedVote[] }) {
  const t = useMessages('home');
  const tc = useMessages('core');
  const tm = useMessages('communities');
  const pins = useStoreState(homePinsStore);
  const scope = useStoreState(communityScopeStore);
  const [tab, setTab] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  useFramePage([tc('core:tabs.home'), t('home:frame.allCommunities.title')], onBack);

  const pinned = new Set(pins.pins.map((p) => p.slug));
  const noun = (audience?: string) => (audience === 'open' ? tm('communities:sections.open.noun')
    : audience === 'invited' ? tm('communities:sections.invited.noun')
      : audience === 'solo' ? tm('communities:sections.solo.noun') : '');
  const needle = query.trim().toLowerCase();
  const shown = mine.filter((c) => {
    const info = scope.info[c.slug];
    if (needle && !c.name.toLowerCase().includes(needle)) return false;
    if (tab === 'notPinned') return !pinned.has(c.slug);
    if (tab === 'all') return true;
    return info?.audience === tab;
  });
  const owed = (slug: string) => pins.owed[slug] || 0;
  const asking = shown.filter((c) => owed(c.slug) > 0);
  const rest = shown.filter((c) => owed(c.slug) === 0);

  const row = (c: HomePin) => {
    const info = scope.info[c.slug];
    const line = [noun(info?.audience), info?.memberCount ? t('home:join.members', { count: info.memberCount }) : ''].filter(Boolean).join(' · ');
    return (
      <Row
        key={c.slug}
        href={hubHref(c.slug)}
        onClick={(event) => openHub(event, c.slug)}
        lead={<Tile name={c.name} src={c.iconUrl} emoji={c.iconEmoji} color={c.iconColor} />}
        title={c.name}
        line={line || undefined}
        right={owed(c.slug) > 0 ? <Pill kind="act">{t('home:frame.toVote', { count: owed(c.slug) })}</Pill> : null}
        go
      />
    );
  };

  const side = (
    <>
      {votes.length > 0 ? (
        <Sec label={t('home:frame.allCommunities.votesWaiting')} action={<GroupLink href="#needs">{t('home:frame.allCommunities.reviewAll')}</GroupLink>}>
          <Card>
            {votes.slice(0, 2).map((v) => (
              <Row
                key={v.key}
                href={`/app/${encodeURIComponent(v.slug)}/workshop?ws=needs`}
                lead={<Tile name={v.community} src={v.iconUrl} emoji={v.iconEmoji} />}
                title={v.title}
                line={v.community}
                right={<Pill kind="act">{t('home:frame.vote')}</Pill>}
              />
            ))}
          </Card>
        </Sec>
      ) : null}
      <Sec><Note icon="pin">{t('home:frame.allCommunities.pinsNote')}</Note></Sec>
    </>
  );

  return (
    <PageBody
      data-home-frame="communities"
      title={t('home:frame.allCommunities.title')}
      purpose={t('home:frame.allCommunities.purpose', { count: mine.length, pinned: pinned.size })}
      acts={<Btn icon="plus" onClick={() => { (window as any).App?.showCreateModal?.(); }}>{t('home:frame.allCommunities.new')}</Btn>}
      tabs={(
        <>
          <Tabs
            tabs={[
              { key: 'all', label: t('home:frame.allCommunities.tabAll') },
              { key: 'open', label: t('home:frame.allCommunities.tabPublic') },
              { key: 'invited', label: t('home:frame.allCommunities.tabPrivate') },
              { key: 'solo', label: t('home:frame.allCommunities.tabSolo') },
              { key: 'notPinned', label: t('home:frame.allCommunities.tabNotPinned') },
            ]}
            current={tab}
            onPick={(key) => setTab(key as Filter)}
          />
          <Search value={query} onChange={setQuery} placeholder={t('home:frame.allCommunities.search')} />
        </>
      )}
      side={side}
    >
      {asking.length > 0 ? <Sec label={t('home:frame.allCommunities.needsYou')}><Card>{asking.map(row)}</Card></Sec> : null}
      {rest.length > 0 ? <Sec label={t('home:frame.allCommunities.rest')}><Card>{rest.map(row)}</Card></Sec> : null}
      {shown.length === 0 ? <Card pad>{t('home:frame.allCommunities.none')}</Card> : null}
    </PageBody>
  );
}
