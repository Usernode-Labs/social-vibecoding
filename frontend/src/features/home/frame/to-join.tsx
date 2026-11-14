/**
 * Communities to join, drawn with the kit: the one drawing of the public
 * directory under a look, on Home signed in (./home-frame.tsx) and on the
 * same Home signed out or still in line (../../guest/frame/landing-frame.tsx).
 *
 * It is ../communities-to-join.tsx's own list: the kind filter, Featured
 * first as cards (left out while a search is typed), then the rest under
 * "More communities" whenever Featured is shown (#6584, #6597), a page at a time as the
 * reader reaches the end, with the standard section's loading, failed,
 * empty and end lines.
 *
 * A card is the same signed in or out (#6609): its picture, name and
 * sentence, with how many people used it lately (#6433: no button, the
 * whole card opens the project's page, where Join sits).
 *
 * A visitor's directory (`picture`) is picture cards from first to last, as
 * the standard landing's is: the community's illustration (its dark twin
 * in a dark theme), else its icon on its own colour, with "New" and the
 * people count on the cover. Featured is as many across as leaves no card
 * alone on its last row (`across`), where the count allows it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Btn, Card, CapSub, HCard, Note, PicCard, Row, Sec, SecNote, Tile, k } from '@/components/ui/kit';
import { useCommunityColor } from '../../../lib/community-color';
import { useMessages } from '../../../lib/i18n/react';
import { featuredApps, presentCategories, type GuestApp } from '../../guest/guest-data';
import { JOIN_PAGE, joinOrder, scrollParent } from '../communities-to-join';
import { matchesQuery } from '../use-home-query';

/**
 * How many cards across a grid of `count`, on a desktop: three, unless that
 * leaves one card alone on the last row (four, seven, ten featured) or a
 * hole beside two; then four or two, whichever closes the row.
 */
export function across(count: number): 2 | 3 | 4 {
  if (count === 2) return 2;
  if (count < 4 || count % 3 !== 1) return 3;
  if (count % 4 !== 1) return 4;
  return count % 2 === 0 ? 2 : 3;
}

/** A community as a visitor's picture card. A component, for the colour it reads off the icon. */
function PictureCard({ app, to, flag, badge, meta, end }: {
  app: GuestApp;
  to: { href: string; onClick: (event: React.MouseEvent<HTMLElement>) => void; label?: string };
  flag?: React.ReactNode;
  badge?: React.ReactNode;
  /** A member's card ends in a foot: how many are there or what is up for a vote, and Join. */
  meta?: React.ReactNode;
  end?: React.ReactNode;
}) {
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  return (
    <PicCard
      href={to.href}
      onClick={to.onClick}
      label={to.label}
      data-home-join-card={app.slug}
      cover={app.illustration_url || null}
      darkCover={app.illustration_dark_url || null}
      color={color}
      tile={<Tile size={64} name={app.name || app.slug} src={app.icon_url} emoji={app.icon_emoji} color={app.icon_color} />}
      flag={flag}
      badge={badge}
      title={app.name || app.slug}
      line={app.description || undefined}
      meta={meta}
      end={end}
    />
  );
}

/** `initialKind` seeds the one state a render test cannot reach through a press. */
export function ToJoinView({ apps, failed, onRetry, exclude, query, heading, id, title, link, picture, cardEnd, cardLine, rowEnd, rowLine, initialKind = null }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read: say so, with a way to try again. */
  failed: boolean;
  onRetry?: () => void;
  /** Communities already on this Home (joined or pinned), left out of the list. */
  exclude: ReadonlySet<string>;
  query: string;
  heading: string;
  id?: string;
  /** The community's name: its door when the card holds a button of its own (a member's Join). */
  title: (app: GuestApp) => React.ReactNode;
  /** The whole card or row is the door (a visitor's, which holds no button). `label` is what a screen reader hears for it. */
  link?: (app: GuestApp) => { href: string; onClick: (event: React.MouseEvent<HTMLElement>) => void; label?: string };
  /** A visitor's directory: every community a picture card, with these on its cover ("New", the people count). Needs `link`. */
  picture?: (app: GuestApp) => { flag?: React.ReactNode; badge?: React.ReactNode; meta?: React.ReactNode; end?: React.ReactNode };
  /** At the end of a card's first line, and of a row: Join, or how many people. */
  cardEnd: (app: GuestApp) => React.ReactNode;
  rowEnd: (app: GuestApp) => React.ReactNode;
  /** The grey line under the name. A card also clamps the community's sentence under it. */
  cardLine?: (app: GuestApp) => React.ReactNode;
  rowLine: (app: GuestApp) => React.ReactNode;
  initialKind?: string | null;
}) {
  const t = useMessages('home');
  const ta = useMessages('auth');
  const [kind, setKind] = useState<string | null>(initialKind);
  const [shown, setShown] = useState(JOIN_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // What follows is ../communities-to-join.tsx's own list: Featured first
  // (left out while a search is typed), then the rest, a page at a time.
  const pool = useMemo(() => (apps || []).filter((a) => !exclude.has(a.slug)), [apps, exclude]);
  const kinds = useMemo(() => presentCategories(pool), [pool]);
  const featured = useMemo(() => (query ? [] : featuredApps(pool).filter((a) => !kind || a.category === kind)), [pool, kind, query]);
  const list = useMemo(() => {
    const lead = new Set(featured.map((a) => a.slug));
    return joinOrder(pool)
      .filter((a) => !lead.has(a.slug))
      .filter((a) => !kind || a.category === kind)
      .filter((a) => matchesQuery(query, a.name, a.slug, a.description));
  }, [pool, featured, kind, query]);
  useEffect(() => { setShown(JOIN_PAGE); }, [kind, query]);
  const more = list.length > shown;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || typeof IntersectionObserver === 'undefined') return undefined;
    const root = scrollParent(el);
    let timer = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || timer) return;
      setLoadingMore(true);
      timer = window.setTimeout(() => { timer = 0; setShown((n) => n + JOIN_PAGE); setLoadingMore(false); }, 250);
    }, { root, rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (timer) window.clearTimeout(timer); };
  }, [more, shown]);

  if (query && !list.length) return null;

  const door = (app: GuestApp) => { const to = link?.(app); return to ? { href: to.href, onClick: to.onClick, label: to.label } : {}; };
  const pictures = !!picture && !!link;
  const wide = (count: number) => { const n = across(count); return n === 3 ? '' : `c${n}`; };
  const face = (app: GuestApp, size: number) => <Tile size={size} name={app.name || app.slug} src={app.icon_url} emoji={app.icon_emoji} color={app.icon_color} />;

  return (
    <Sec label={heading} id={id} aria-busy={apps ? undefined : true}>
      {!query && kinds.length ? (
        <div className={k('btnrow', 'chips')} role="group" aria-label={ta('auth:guest.categories.label')}>
          <Btn small kind={kind ? 'quiet' : ''} aria-pressed={!kind} data-home-join-kind="all" onClick={() => setKind(null)}>
            {ta('auth:guest.category.all')}
          </Btn>
          {kinds.map((name) => (
            <Btn key={name} small kind={kind === name ? '' : 'quiet'} aria-pressed={kind === name} data-home-join-kind={name} onClick={() => setKind(kind === name ? null : name)}>
              {ta(`auth:guest.category.${name}`)}
            </Btn>
          ))}
        </div>
      ) : null}
      {featured.length ? (
        <>
          <CapSub>{t('home:join.featured')}</CapSub>
          {pictures ? (
            <div className={k('grid', wide(featured.length))} data-home-join-featured="">
              {featured.map((app) => <PictureCard key={app.slug} app={app} to={link!(app)} {...picture!(app)} />)}
            </div>
          ) : (
            <div className={k('grid', 'across', wide(featured.length))} data-home-join-featured="">
              {featured.map((app) => (
                <HCard key={app.slug} top={face(app, 44)} end={cardEnd(app)} title={title(app)} line={cardLine ? cardLine(app) : undefined} more={app.description || undefined} {...door(app)} />
              ))}
            </div>
          )}
        </>
      ) : null}
      {failed ? (
        <Card pad>
          <Note tone="bad" icon="alert">{t('home:join.failed')}</Note>
          {onRetry ? (
            <div className={k('btnrow')}>
              <Btn small kind="quiet" data-home-join-retry="" onClick={onRetry}>{t('home:join.retry')}</Btn>
            </div>
          ) : null}
        </Card>
      ) : !apps ? (
        <SecNote>{ta('auth:guest.loading')}</SecNote>
      ) : list.length ? (
        <>
          {featured.length ? <CapSub>{t('home:join.more')}</CapSub> : null}
          {pictures ? (
            <div className={k('grid')} data-home-join-rest="">
              {list.slice(0, shown).map((app) => <PictureCard key={app.slug} app={app} to={link!(app)} {...picture!(app)} />)}
            </div>
          ) : (
            <Card>
              {/* One size of row down the list, with or without a line under the name. */}
              {list.slice(0, shown).map((app) => (
                <Row key={app.slug} sm={false} lead={face(app, 40)} title={title(app)} line={rowLine(app) || undefined} right={rowEnd(app)} {...door(app)} />
              ))}
            </Card>
          )}
        </>
      ) : featured.length ? null : (
        <SecNote>{!pool.length && !kind && !query ? t('home:join.empty') : t('home:join.allJoined')}</SecNote>
      )}
      {more ? (
        <>
          {loadingMore ? <SecNote>{t('home:join.loadingMore')}</SecNote> : null}
          <div ref={sentinel} data-home-join-more="" style={{ height: 1 }} />
        </>
      ) : list.length > JOIN_PAGE ? (
        // Centred under the list, where the standard section says it.
        <SecNote end data-home-join-end="">{kind ? t('home:join.endKind') : t('home:join.end')}</SecNote>
      ) : null}
    </Sec>
  );
}
