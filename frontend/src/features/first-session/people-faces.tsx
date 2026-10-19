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
 * The colour is the one every other face in the shell wears for that name
 * (../messages/format.tsx swatchFor), so a person is the same colour on the
 * hub, in Messages and here.
 */

import { useMessages } from '../../lib/i18n/react';
import { swatchFor } from '../messages/format';

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

// Whole literals, for Tailwind's extractor.
const FACE = {
  sm: 'h-7 w-7 text-[12px]',
  lg: 'h-10 w-10 text-[16px]',
} as const;
const OVERLAP = { sm: '-ml-2', lg: '-ml-2.5' } as const;

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
        <span
          key={p.username}
          aria-hidden="true"
          className={`${FACE[size]}${i ? ` ${OVERLAP[size]}` : ''} inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white shadow-[0_0_0_2px_var(--home-ground)]`}
          style={{ background: swatchFor(p.username) }}
        >
          {p.username.charAt(0).toUpperCase()}
        </span>
      ))}
      {more ? (
        <span
          aria-hidden="true"
          data-people-more=""
          className={`${FACE[size]} ${OVERLAP[size]} inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-200 font-bold text-zinc-700 shadow-[0_0_0_2px_var(--home-ground)] dark:bg-zinc-700 dark:text-zinc-200`}
        >
          {`+${more}`}
        </span>
      ) : null}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
