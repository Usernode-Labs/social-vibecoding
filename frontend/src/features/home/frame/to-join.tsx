/**
 * Communities to join, drawn with the kit: the one drawing of the public
 * directory under a look, on Home signed in (./home-frame.tsx) and on the
 * same Home signed out or still in line (../../guest/frame/landing-frame.tsx).
 *
 * It is ../communities-to-join.tsx's own list: the kind filter, Featured
 * first as cards (left out while a search is typed), then the rest as rows
 * under "More communities" when a kind is chosen, a page at a time as the
 * reader reaches the end, with the standard section's loading, failed,
 * empty and end lines.
 *
 * What a card can do differs by who reads it, so the page says it: a
 * member's card ends in Join and says its votes or members; a visitor's
 * card is its picture, name and sentence, with how many people used it
 * lately (#6433: no button, the whole card opens the project's page).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Btn, Card, CapSub, HCard, Note, Row, Sec, SecNote, Tile, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { featuredApps, presentCategories, type GuestApp } from '../../guest/guest-data';
import { JOIN_PAGE, joinOrder, scrollParent } from '../communities-to-join';
import { matchesQuery } from '../use-home-query';

/** `initialKind` seeds the one state a render test cannot reach through a press. */
export function ToJoinView({ apps, failed, onRetry, exclude, query, heading, id, title, link, cardEnd, cardLine, rowEnd, rowLine, initialKind = null }: {
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
          <div className={k('grid', 'across')} data-home-join-featured="">
            {featured.map((app) => (
              <HCard key={app.slug} top={face(app, 44)} end={cardEnd(app)} title={title(app)} line={cardLine ? cardLine(app) : undefined} more={app.description || undefined} {...door(app)} />
            ))}
          </div>
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
          {kind && featured.length ? <CapSub>{t('home:join.more')}</CapSub> : null}
          <Card>
            {list.slice(0, shown).map((app) => (
              <Row key={app.slug} lead={face(app, 40)} title={title(app)} line={rowLine(app) || undefined} right={rowEnd(app)} {...door(app)} />
            ))}
          </Card>
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
        <SecNote>{kind ? t('home:join.endKind') : t('home:join.end')}</SecNote>
      ) : null}
    </Sec>
  );
}
