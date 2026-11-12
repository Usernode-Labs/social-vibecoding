/**
 * One list of communities as frame rows: the tile, the name and one line.
 * Under a frame look both pages draw their directory lists with it, signed
 * in or out (#6609): the landing's Featured and Communities, and Home's
 * Featured and To join, so the two cannot drift in their word, card or
 * line. A row is the door; what differs between the pages is a prop here
 * (its href, where a press lands, how many it shows, its action and its
 * empty line), never a branch inside.
 */
import * as React from 'react';

import { Card, Row, Sec, Tile } from '@/components/ui/kit';

import { useMessages } from '../../../lib/i18n/react';

/** The fields a row reads. Both frame pages' directory rows fit it. */
export type FrameCommunityApp = {
  slug: string;
  name?: string | null;
  description?: string | null;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  member_count?: number | null;
};

export function FrameCommunityList({ apps, label, id, href, onOpen, limit, action, empty }: {
  apps: readonly FrameCommunityApp[];
  label: React.ReactNode;
  id?: string;
  /** The row's address. */
  href: (slug: string) => string;
  /** A plain click opens it in the page; a cmd-click or middle-click keeps the address. */
  onOpen: (event: React.MouseEvent<HTMLElement>, slug: string) => void;
  /** How many rows to show; the rest stay behind the action. */
  limit?: number;
  /** The group's link, when there are more than it shows. */
  action?: React.ReactNode;
  /** Said when there is nothing to list, in place of an empty group. */
  empty?: React.ReactNode;
}) {
  const t = useMessages('home');
  const body = apps.length ? (
    <Card>
      {(limit == null ? apps : apps.slice(0, limit)).map((a) => (
        <Row
          key={a.slug}
          href={href(a.slug)}
          onClick={(event) => onOpen(event, a.slug)}
          lead={<Tile name={a.name || a.slug} src={a.icon_url} emoji={a.icon_emoji} color={a.icon_color} />}
          title={a.name || a.slug}
          line={a.member_count ? t('home:join.members', { count: a.member_count }) : (a.description || undefined)}
        />
      ))}
    </Card>
  ) : empty ? <Card pad>{empty}</Card> : null;
  if (!body) return null;
  return (
    <Sec label={label} id={id} action={action}>
      {body}
    </Sec>
  );
}
