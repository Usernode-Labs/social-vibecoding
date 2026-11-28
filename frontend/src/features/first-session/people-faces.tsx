/**
 * A community's people as a row of faces (#4049, #4052): each person's
 * initial on their colour, overlapping, ringed in the ground they sit on.
 * The invite page draws the one who sent the link beside their note, small.
 * ("You're in" lists everyone by name instead: ./index.tsx MemberRow.)
 *
 * At most PEOPLE_FACES faces. When `count` says there are more, one more
 * circle the same size says how many ("+3"), and the row's accessible name
 * is the count in words. No names: the faces are company, not a roster.
 *
 * Each face is the one round picture every surface draws for that name
 * (@/components/ui/feed.tsx PersonAvatar), so a person is the same colour on
 * the hub, in Messages and here.
 */

import { PersonAvatar } from '@/components/ui/feed';

import { useMessages } from '../../lib/i18n/react';

/** How many faces the row shows before "+N" says the rest. */
export const PEOPLE_FACES = 5;

export type Person = { username: string };

/** The people a welcome or a preview carries, cleaned: names only, at most what the row shows. */
export function peopleOf(value: unknown): Person[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((p) => (p && typeof p === 'object' ? String((p as { username?: unknown }).username || '').trim() : ''))
    .filter(Boolean)
    .slice(0, PEOPLE_FACES)
    .map((username) => ({ username }));
}

/** How many more there are than the faces shown: the "+N", or 0. */
export function moreThan(shown: number, count: number | null | undefined): number {
  const n = Number(count);
  return Number.isFinite(n) && n > shown ? Math.floor(n - shown) : 0;
}

/** The faces' set sizes (@/components/ui/feed.tsx PersonAvatar). */
const FACE = { sm: 28, lg: 44 } as const;
// The "+N" circle, the faces' size. Whole literals, for Tailwind's extractor.
const MORE = {
  sm: 'h-7 w-7 text-[12px]',
  lg: 'h-11 w-11 text-[16px]',
} as const;
const OVERLAP = { sm: '-ms-2', lg: '-ms-2.5' } as const;

export function PeopleRow({ people, count = null, size = 'lg', className = '' }: {
  people: Person[];
  /** Everyone in it, when the row should say how many more there are. */
  count?: number | null;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const t = useMessages('onboarding');
  const faces = people.slice(0, PEOPLE_FACES);
  if (!faces.length) return null;
  const more = moreThan(faces.length, count);
  const total = faces.length + more;
  const label = count != null ? t('onboarding:firstSession.people.count', { count: total }) : null;
  return (
    <span data-people-row={size} className={className ? `inline-flex items-center ${className}` : 'inline-flex items-center'}>
      {faces.map((p, i) => (
        <PersonAvatar
          key={p.username}
          name={p.username}
          size={FACE[size]}
          aria-hidden="true"
          className={`${i ? `${OVERLAP[size]} ` : ''}shadow-[0_0_0_2px_var(--home-ground)]`}
        />
      ))}
      {more ? (
        <span
          aria-hidden="true"
          data-people-more=""
          className={`${MORE[size]} ${OVERLAP[size]} inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-200 font-bold text-zinc-700 shadow-[0_0_0_2px_var(--home-ground)] dark:bg-zinc-700 dark:text-zinc-200`}
        >
          {`+${more}`}
        </span>
      ) : null}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
