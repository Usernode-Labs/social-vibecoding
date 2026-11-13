/**
 * The landing in the one frame, under any of the five looks: version 2 of
 * the screen tour's steps o01 to o03 and w03 (docs/superpowers/plans/
 * 2026-11-11-looks-v2-todays-content.md). The first tour's layout (the
 * kit's head with one primary button, its two columns, its tiles, cards
 * and rows) holding today's signed-out Home (../guest-discover.tsx under
 * the story's short version, ../../auth/story.tsx), section for section:
 *
 *   the head              "Welcome to Homeroom" over the headline and its
 *                         sentence, and the one button: Join the waitlist,
 *                         or Sign up where accounts open at once
 *   the three points      what an account adds, in the side column (first
 *                         on a phone)
 *   the search field      one search over the pins and the communities,
 *                         kept on the history entry as the standard page
 *                         keeps it
 *   Pinned apps           this device's (../device-pins.ts), once it has
 *                         pinned one; a tile opens the app, its corner
 *                         takes it off
 *   Pinned communities    this device's, a tile opens the community's page
 *   Communities           the public directory, the one drawing Home has
 *                         for it under a look (../../home/frame/to-join
 *                         .tsx): the kinds, Featured as cards, then the
 *                         rest as rows. A visitor's card has no button: it
 *                         is its picture, "New", how many people used it
 *                         lately, its name and its sentence, and the whole
 *                         card opens the community's page.
 *
 * AN ACCOUNT STILL IN LINE looks around on the same page (`waiting`, the
 * tour's w03): the title is Home's, and the side column says where the
 * account stands and leads back to the waiting room, in place of the
 * three points and the button (../waitlist-card.tsx is the standard's).
 *
 * The landing (../../auth/landing.tsx) mounts this ahead of its own guest
 * Discover when the device's look is one of the frame's; the standard page
 * stays mounted, put away by app.css. Nothing here fetches or words
 * anything of its own.
 */
import { useEffect, useMemo, useState } from 'react';

import { Btn, Card, CardNote, Icon, Lead, Note, PageBody, Pill, Row, Search, Sec, Tile, TileItem, Tiles, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { noteSignUpFrom } from '../../auth/sign-up-from';
import { ToJoinView } from '../../home/frame/to-join';
import { matchesQuery } from '../../home/use-home-query';
import { devicePinsStore, loadDevicePins, toggleDevicePin } from '../device-pins';
import { type GuestApp, MIN_PEOPLE, isNew, projectHash, projectPath } from '../guest-data';
import { guestSearchFrom, withGuestSearch } from '../search-history';

const NONE: ReadonlySet<string> = new Set();

/** A plain click opens the community's page in place; a cmd-click or middle-click keeps the address. */
function openProject(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (location.pathname !== '/') return;
  event.preventDefault();
  location.hash = projectHash(slug);
}

/** `initial*` seed the state a render test cannot reach through a press. */
export function LandingFrame({ apps, failed, onRetry, waitlist, waiting = null, welcomeEmail = null, onStart, onOpenInside, initialKind = null, initialQuery = '' }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  failed: boolean;
  onRetry?: () => void;
  /** New accounts wait in line: the primary button says so. */
  waitlist: boolean;
  /** An account still in line, looking around (the tour's w03): signed in, not let in yet. */
  waiting?: { email: string | null } | null;
  /** The address a "You're in" mail's link names, greeted under the headline. */
  welcomeEmail?: string | null;
  /** The landing's own way in (its start sheet). */
  onStart: () => void;
  /** Open an app in the landing's viewer. */
  onOpenInside: (app: GuestApp) => void;
  initialKind?: string | null;
  initialQuery?: string;
}) {
  const t = useMessages('auth');
  const th = useMessages('home');
  const [query, setQuery] = useState(initialQuery);
  // The project page replaces this one: the query stays on Home's history
  // entry, so Back restores this visit (../guest-discover.tsx).
  useEffect(() => {
    const kept = guestSearchFrom(window.history.state);
    if (kept) setQuery(kept);
    const onPop = () => setQuery(guestSearchFrom(window.history.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const changeQuery = (value: string) => {
    setQuery(value);
    try { window.history.replaceState(withGuestSearch(window.history.state, value), ''); } catch { /* History unavailable: search still works. */ }
  };
  const device = useStoreState(devicePinsStore);
  useEffect(() => { loadDevicePins(); }, []);

  const all = apps || [];
  const bySlug = useMemo(() => new Map(all.map((a) => [a.slug, a])), [all]);
  const q = query.trim();
  const pinnedOf = (slugs: readonly string[]) => slugs.map((s) => bySlug.get(s)).filter((a): a is GuestApp => !!a && matchesQuery(q, a.name, a.slug, a.description));
  const pinnedApps = pinnedOf(device.apps);
  const pinnedCommunities = pinnedOf(device.communities);
  const face = (app: GuestApp) => <Tile size={52} name={app.name || app.slug} src={app.icon_url} emoji={app.icon_emoji} color={app.icon_color} />;

  // What a visitor's card says of a community: "New" for its first 30
  // days, and how many people used it lately once that is worth saying.
  // Unseen by a screen reader, which hears the number with the name.
  const people = (app: GuestApp) => app.active_users || 0;
  const says = (app: GuestApp) => {
    const fresh = isNew(app);
    const used = people(app) >= MIN_PEOPLE;
    if (!fresh && !used) return null;
    return (
      <span className={k('btnrow')} aria-hidden="true">
        {fresh ? <Pill>{t('auth:guest.card.new')}</Pill> : null}
        {used ? <Pill><Icon name="users" size={14} />{people(app).toLocaleString()}</Pill> : null}
      </span>
    );
  };
  // In the page's column the field is one of the stack's own items, whose gap
  // is the room under it: the field's own margin on top of that made the one
  // double gap of the page (flush). At the tabs' place (an account in line)
  // it keeps its margin.
  const search = <Search flush={!waiting} value={query} onChange={changeQuery} placeholder={th('home:search.placeholder')} label={th('home:search.label')} />;

  const side = waiting ? (
    <Sec label={t('auth:waiting.title')} data-guest-waitlist="">
      <Card>
        <CardNote>{waiting.email ? t('auth:guest.waitlist.leadEmail', { email: waiting.email }) : t('auth:guest.waitlist.lead')}</CardNote>
        <Row title={t('auth:landing.backToWaiting')} href="#waiting" go sm />
      </Card>
    </Sec>
  ) : (
    <Card>
      <Row lead={<Lead icon="vote" />} title={t('auth:guest.join.vote.title')} line={t('auth:guest.join.vote.body')} wrap />
      <Row lead={<Lead icon="spark" />} title={t('auth:guest.join.ask.title')} line={t('auth:guest.join.ask.body')} wrap />
      <Row lead={<Lead icon="plus" />} title={t('auth:guest.join.make.title')} line={t('auth:guest.join.make.body')} wrap />
    </Card>
  );

  return (
    <PageBody
      data-landing-frame={waiting ? 'waiting' : ''}
      over={waiting ? undefined : t('auth:story.welcome')}
      title={waiting ? th('home:frame.title') : t('auth:story.headline')}
      under={!waiting && welcomeEmail ? welcomeEmail : undefined}
      purpose={waiting ? th('home:frame.purpose') : t('auth:guest.hero.line')}
      acts={waiting ? undefined : (
        <Btn data-landing-frame-join="" onClick={() => { noteSignUpFrom('hero'); onStart(); }}>
          {waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.hero.signUp')}
        </Btn>
      )}
      tabs={waiting ? search : undefined}
      side={side}
      sideFirst
    >
      {waiting ? null : search}

      {pinnedApps.length ? (
        <Sec label={th('home:grid.heading')} data-guest-pinned-apps="">
          <Tiles>
            {pinnedApps.map((app) => (
              <TileItem
                key={app.slug}
                href={app.url}
                onClick={(event) => {
                  // An app that asks for no account opens here, in the landing's
                  // viewer, and every app does for an account in line; any
                  // other keeps its own address (../guest-discover.tsx TryLink).
                  if (!waiting && app.requires_login !== false) return;
                  event.preventDefault();
                  onOpenInside(app);
                }}
                tile={face(app)}
                name={app.name}
                corner={(
                  <button type="button" className={k('corner', 'un')} aria-label={th('home:guest.unpinApp', { app: app.name })} onClick={() => { toggleDevicePin('apps', app.slug); }}>
                    <span aria-hidden="true">&minus;</span>
                  </button>
                )}
              />
            ))}
          </Tiles>
        </Sec>
      ) : null}

      {pinnedCommunities.length ? (
        <Sec label={th('home:communities.heading')} data-guest-pinned-communities="">
          <Tiles>
            {pinnedCommunities.map((app) => (
              <TileItem key={app.slug} href={projectPath(app.slug)} onClick={(event) => openProject(event, app.slug)} tile={face(app)} name={app.name} />
            ))}
          </Tiles>
        </Sec>
      ) : null}

      {failed ? (
        <Note tone="bad" icon="alert">
          <span className={k('btnrow')}>
            <span>{t('auth:guest.loadFailed')}</span>
            {onRetry ? <Btn kind="quiet" small data-guest-retry="" onClick={onRetry}>{t('auth:guest.retry')}</Btn> : null}
          </span>
        </Note>
      ) : (
        <ToJoinView
          apps={apps}
          failed={false}
          exclude={NONE}
          query={q}
          heading={th('home:join.headingSignedOut')}
          title={(app) => app.name || app.slug}
          link={(app) => ({
            href: projectPath(app.slug),
            onClick: (event) => openProject(event, app.slug),
            label: people(app) >= MIN_PEOPLE ? t('auth:guest.card.peopleLabel', { name: app.name, count: people(app) }) : undefined,
          })}
          // A visitor's cards are pictures, as on the standard landing: "New"
          // and the people count sit on the cover.
          picture={(app) => ({
            flag: isNew(app) ? t('auth:guest.card.new') : undefined,
            badge: people(app) >= MIN_PEOPLE ? <><Icon name="users" size={14} />{people(app).toLocaleString()}</> : undefined,
          })}
          cardEnd={says}
          rowEnd={says}
          rowLine={(app) => app.description || undefined}
          initialKind={initialKind}
        />
      )}
    </PageBody>
  );
}
