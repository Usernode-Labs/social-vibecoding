/**
 * All apps, the page under Home the 2026-11-06 screen tour draws (its step
 * s03): the frame with tabs and a search, then groups of the same app tiles
 * Home uses. Pinned first, then everything else in order. Tiles appear only
 * for apps, the one thing you launch.
 *
 * Reached from Home's "All N" tile; the bar's back arrow returns there
 * (../../frame/frame-page-store.ts). The pinned apps are the launcher's own
 * (../grid-store); the rest is GET /api/apps, what the viewer may open.
 */
import { useEffect, useMemo, useState } from 'react';

import { Card, GroupLink, Lead, PageBody, Search, Sec, Tabs, Tile, TileItem, Tiles } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { useFramePage } from '../../frame/frame-page-store';
import { gridStore, type IconView } from '../grid-store';

/** How many of "everything else" show before the tile that opens the rest. */
const REST_SHOWN = 23;

export type ListedApp = { slug: string; name: string; icon_emoji?: string | null; icon_image_id?: string | null; icon_color?: string | null };

const iconProps = (icon: IconView) => (icon.kind === 'image' ? { src: icon.src } : icon.kind === 'emoji' ? { emoji: icon.emoji } : { emoji: icon.letter });

function openApp(event: React.MouseEvent<HTMLElement>, slug: string) {
  if ((window as any).NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  (window as any).App?.navigateToApp?.(slug);
}

export function HomeAllApps({ onBack, initialApps = null }: { onBack: () => void; initialApps?: ListedApp[] | null }) {
  const t = useMessages('home');
  const tc = useMessages('core');
  const grid = useStoreState(gridStore);
  const [apps, setApps] = useState<ListedApp[] | null>(initialApps);
  const [tab, setTab] = useState<'all' | 'pinned'>('all');
  const [query, setQuery] = useState('');
  const [whole, setWhole] = useState(false);
  useFramePage([tc('core:tabs.home'), t('home:frame.allApps.title')], onBack);

  useEffect(() => {
    let on = true;
    fetch('/api/apps', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (on) setApps(Array.isArray(body?.apps) ? body.apps : []); })
      .catch(() => { if (on) setApps([]); });
    return () => { on = false; };
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const pinned = (grid.ready ? grid.items.filter((i) => i.kind === 'card').map((i) => i.app) : []).filter((a) => matches(a.name));
  const pinnedSlugs = useMemo(() => new Set((grid.ready ? grid.items : []).filter((i) => i.kind === 'card').map((i) => i.app.slug)), [grid]);
  const rest = (apps || [])
    .filter((a) => a && a.slug && !pinnedSlugs.has(a.slug) && matches(a.name || a.slug))
    .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
  const total = pinnedSlugs.size + (apps || []).filter((a) => a && a.slug && !pinnedSlugs.has(a.slug)).length;
  const shownRest = whole || needle ? rest : rest.slice(0, REST_SHOWN);
  const nothing = pinned.length === 0 && (tab === 'pinned' || rest.length === 0) && !!needle;

  return (
    <PageBody
      data-home-frame="apps"
      title={t('home:frame.allApps.title')}
      purpose={t('home:frame.allApps.purpose', { count: total })}
      tabs={(
        <>
          <Tabs
            tabs={[{ key: 'all', label: t('home:frame.allApps.tabAll') }, { key: 'pinned', label: t('home:frame.allApps.tabPinned') }]}
            current={tab}
            onPick={(key) => setTab(key as 'all' | 'pinned')}
          />
          <Search value={query} onChange={setQuery} placeholder={t('home:frame.allApps.search')} />
        </>
      )}
    >
      {pinned.length > 0 ? (
        <Sec
          label={t('home:frame.allApps.pinned')}
          action={<GroupLink onClick={() => { onBack(); (window as any).Home?.setEditing?.(true); }}>{t('home:frame.allApps.editPins')}</GroupLink>}
        >
          <Tiles>
            {pinned.map((app) => (
              <TileItem
                key={app.slug}
                href={`/app/${encodeURIComponent(app.slug)}`}
                onClick={(event) => openApp(event, app.slug)}
                tile={<Tile size={52} name={app.name} {...iconProps(app.icon)} />}
                name={app.name}
              />
            ))}
          </Tiles>
        </Sec>
      ) : null}

      {tab === 'all' && shownRest.length > 0 ? (
        <Sec label={t('home:frame.allApps.rest')}>
          <Tiles>
            {shownRest.map((app) => (
              <TileItem
                key={app.slug}
                href={`/app/${encodeURIComponent(app.slug)}`}
                onClick={(event) => openApp(event, app.slug)}
                tile={<Tile size={52} name={app.name || app.slug} src={app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null} emoji={app.icon_emoji} color={app.icon_color} />}
                name={app.name || app.slug}
              />
            ))}
            {rest.length > shownRest.length ? (
              <TileItem
                onClick={() => setWhole(true)}
                tile={<Lead icon="grid" size={52} />}
                name={t('home:frame.allApps.more', { count: rest.length - shownRest.length })}
              />
            ) : null}
          </Tiles>
        </Sec>
      ) : null}

      {nothing ? <Card pad>{t('home:frame.allApps.none')}</Card> : null}
    </PageBody>
  );
}
