/**
 * The landing in the one frame, as the 2026-11-06 screen tour draws it (its
 * steps o01 to o03, `landing()` in the tour's screens/out.mjs), under any of
 * the nine looks: the product's own frame for a visitor, so nothing on it
 * is a layout a member will not see again inside.
 *
 * Drawn with the kit (frontend/@/components/ui/kit.tsx): the title, one
 * sentence, one primary button (Join the waitlist, or Sign up where
 * accounts open at once); the kinds of community as the page's tabs; then,
 * in the 720px column, what an account adds, apps to try with no account,
 * and every public community as a row ending in Look; with what is here
 * today in the 320px column beside it.
 *
 * The landing (../../auth/landing.tsx) mounts this ahead of its own guest
 * Discover (../guest-discover.tsx) when the device's look is one of the
 * frame's; the standard page stays mounted, put away by app.css. Its data
 * is the same public directory the standard page reads (GET
 * /api/public/apps, through the landing), and every press does what the
 * standard page's does: the primary button opens the landing's own sheet,
 * a tile opens the app in the landing's viewer, a row opens the community's
 * public page.
 *
 * NOT DRAWN: the tour's "Happening now" (one real vote, open now). The
 * public directory says how many votes a community has open, not which, so
 * there is no vote to show without asking each community in turn.
 */
import { useEffect, useMemo, useState } from 'react';

import { Btn, Card, Facts, Note, PageBody, Row, Search, Sec, Tabs, Tile, TileItem, Tiles, Lead, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { noteSignUpFrom } from '../../auth/sign-up-from';
import { devicePinsStore, loadDevicePins } from '../device-pins';
import { joinOrder } from '../../home/communities-to-join';
import { type GuestApp, canTryHere, featuredApps, filterApps, inHomeroomApp, presentCategories, projectHash, projectPath } from '../guest-data';

/** How many apps the "Try an app now" group offers. */
const TRY_SHOWN = 11;

/** A plain click opens the community's page in place; a cmd-click or middle-click keeps the address. */
function openProject(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (location.pathname !== '/') return;
  event.preventDefault();
  location.hash = projectHash(slug);
}

/** `initial*` seed the state a render test cannot reach through a press. */
export function LandingFrame({ apps, failed, onRetry, waitlist, onStart, onOpenInside, initialKind = null, initialQuery = '' }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  failed: boolean;
  onRetry?: () => void;
  /** New accounts wait in line: the primary button says so. */
  waitlist: boolean;
  /** The landing's own way in (its start sheet). */
  onStart: () => void;
  /** Open an app in the landing's viewer. */
  onOpenInside: (app: GuestApp) => void;
  initialKind?: string | null;
  initialQuery?: string;
}) {
  const t = useMessages('auth');
  const th = useMessages('home');
  const [kind, setKind] = useState<string | null>(initialKind);
  const [query, setQuery] = useState(initialQuery);
  const device = useStoreState(devicePinsStore);
  useEffect(() => { loadDevicePins(); }, []);

  const all = apps || [];
  const kinds = useMemo(() => presentCategories(all), [all]);
  const inApp = inHomeroomApp();
  const tryable = (app: GuestApp) => canTryHere(app, inApp);
  const q = query.trim();
  const rows = useMemo(() => filterApps(joinOrder(all), q, kind), [all, q, kind]);
  const toTry = rows.filter(tryable);
  const bySlug = useMemo(() => new Map(all.map((a) => [a.slug, a])), [all]);
  const pinned = !kind && !q ? device.apps.map((s) => bySlug.get(s)).filter((a): a is GuestApp => !!a) : [];
  const front = !kind && !q;

  const tryApp = (event: React.MouseEvent<HTMLElement>, app: GuestApp) => {
    // An app that asks for no account opens here, in the landing's viewer;
    // any other keeps its own address (../guest-discover.tsx TryLink).
    if (app.requires_login !== false) return;
    event.preventDefault();
    onOpenInside(app);
  };
  const tile = (app: GuestApp) => (
    <TileItem
      key={app.slug}
      href={app.url}
      onClick={(event) => tryApp(event, app)}
      tile={<Tile size={52} name={app.name} src={app.icon_url} emoji={app.icon_emoji} color={app.icon_color} />}
      name={app.name}
    />
  );

  const side = (
    <Sec label={t('auth:frame.landing.today')}>
      <Facts
        items={[
          { value: all.length, label: t('auth:frame.landing.factCommunities', { count: all.length }) },
          { value: all.filter(tryable).length, label: t('auth:frame.landing.factApps', { count: all.filter(tryable).length }) },
        ]}
      />
    </Sec>
  );

  return (
    <PageBody
      data-landing-frame=""
      title={t('auth:story.headline')}
      purpose={t('auth:guest.hero.line')}
      acts={(
        <>
          <Btn kind="line" icon="play" onClick={() => { document.getElementById('landing-frame-try')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
            {t('auth:frame.landing.tryFirst')}
          </Btn>
          <Btn data-landing-frame-join="" onClick={() => { noteSignUpFrom('hero'); onStart(); }}>
            {waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.hero.signUp')}
          </Btn>
        </>
      )}
      tabs={kinds.length ? (
        <Tabs
          tabs={[{ key: '', label: t('auth:guest.category.all') }, ...kinds.map((c) => ({ key: c, label: t(`auth:guest.category.${c}` as 'auth:guest.category.other') }))]}
          current={kind || ''}
          onPick={(key) => setKind(key || null)}
        />
      ) : null}
      side={apps ? side : null}
    >
      <Search value={query} onChange={setQuery} placeholder={th('home:search.placeholder')} label={th('home:search.label')} />

      {front ? (
        <Sec label={t('auth:frame.landing.account')}>
          <Card>
            <Row lead={<Lead icon="vote" />} title={t('auth:guest.join.vote.title')} line={t('auth:guest.join.vote.body')} />
            <Row lead={<Lead icon="spark" />} title={t('auth:guest.join.ask.title')} line={t('auth:guest.join.ask.body')} />
            <Row lead={<Lead icon="plus" />} title={t('auth:guest.join.make.title')} line={t('auth:guest.join.make.body')} />
          </Card>
        </Sec>
      ) : null}

      {pinned.length ? (
        <Sec label={th('home:grid.heading')}>
          <Tiles>{pinned.map(tile)}</Tiles>
        </Sec>
      ) : null}

      {!apps ? (
        failed ? (
          <Note tone="bad" icon="alert">
            {t('auth:guest.loadFailed')}{' '}
            {onRetry ? <Btn kind="quiet" small onClick={onRetry}>{t('auth:guest.retry')}</Btn> : null}
          </Note>
        ) : <Card pad>{t('auth:frame.landing.loading')}</Card>
      ) : null}

      {toTry.length ? (
        <Sec label={t('auth:frame.landing.try')} id="landing-frame-try" action={<span className={k('link')}>{t('auth:frame.landing.noAccount')}</span>}>
          <Tiles>
            {toTry.slice(0, TRY_SHOWN).map(tile)}
          </Tiles>
        </Sec>
      ) : null}

      {apps ? (
        <Sec label={t('auth:frame.landing.communities')}>
          {rows.length ? (
            <Card>
              {/* The row is the door to the community's public page; its word
                  is Look, the guest's version of Join, not a button inside
                  the link. */}
              {rows.map((a) => (
                <Row
                  key={a.slug}
                  href={projectPath(a.slug)}
                  onClick={(event) => openProject(event, a.slug)}
                  lead={<Tile name={a.name || a.slug} src={a.icon_url} emoji={a.icon_emoji} color={a.icon_color} />}
                  title={a.name || a.slug}
                  line={a.member_count ? th('home:join.members', { count: a.member_count }) : (a.description || undefined)}
                  right={<span className="fr-btn fr-quiet fr-sm">{t('auth:frame.landing.look')}</span>}
                />
              ))}
            </Card>
          ) : <Card pad>{t('auth:frame.landing.none')}</Card>}
        </Sec>
      ) : null}
    </PageBody>
  );
}
