/**
 * Who is in a community, as a row of faces (#4041). On the screen after
 * Make it (./made.tsx) it is your face in the middle with waiting seats on
 * both sides: the community comes first, and the open seats ask to be
 * filled. As people join, their faces take the seats, and that is how the
 * screen says who joined.
 *
 * The canvas board People.dc.html (set "you-open") is the exact design: five
 * round places that overlap a little, your face in the middle (36px), the
 * seats fading out toward the edges by lightening their colours, never by
 * opacity, so the overlap stays clean. A seat is not interactive and shows a
 * soft person silhouette. A face is the hub's (dev-board/workshop/
 * community-card.tsx HeroPeople): the person's initial on their swatch
 * (lib/community-color.ts swatchFor). Both are ringed in the screen's ground
 * colour so overlapping places stay apart. The row is one image to a screen
 * reader, named in words ("You and 2 others").
 */

import { PersonSilhouetteIcon } from '@/components/ui/icons';

import { swatchFor } from '../../lib/community-color';

export type Person = { username?: string | null; display_name?: string | null };

/** Places in the row: your face in the middle, two on each side. */
export const PLACES = 5;
/** The most faces drawn (the row's places). */
export const MAX_FACES = PLACES;
const YOU = 2;
/** Where the second person, the third and so on sit: right of you, left, then outward. */
const JOIN_ORDER = [3, 1, 4, 0] as const;

/** The seats' colours (People.dc.html), lightest at the edges. Keyed by place. */
const SEAT: Record<number, { bg: string; ink: string }> = {
  0: { bg: '#ebefed', ink: '#cedae0' },
  1: { bg: '#ede5f2', ink: '#c2b1d8' },
  3: { bg: '#fae5dc', ink: '#ebb199' },
  4: { bg: '#f5e9e5', ink: '#e8cacc' },
};

const GROUND = 'var(--home-ground, #f4f2e4)';

function nameOf(person: Person): string {
  return String(person.username || person.display_name || '').trim();
}

/** The row in words, for a screen reader. The first person is you. */
export function peopleLabel(people: readonly Person[]): string {
  const others = Math.max(0, people.length - 1);
  if (!others) return 'You';
  if (others === 1) return nameOf(people[1]) ? `You and ${nameOf(people[1])}` : 'You and 1 other';
  return `You and ${others} others`;
}

/** The five places: you in the middle, the others in the order they joined, the rest open. */
export function placesOf(people: readonly Person[]): (Person | null)[] {
  const places: (Person | null)[] = Array.from({ length: PLACES }, () => null);
  places[YOU] = people[0] || {};
  people.slice(1, MAX_FACES).forEach((person, i) => { places[JOIN_ORDER[i]] = person; });
  return places;
}

export function PeopleRow({ people }: { people: readonly Person[] }) {
  const places = placesOf(people);
  const faces = places.filter(Boolean).length;
  return (
    <div role="img" aria-label={peopleLabel(people)} data-first-session-people={faces} className="flex items-start justify-center">
      {places.map((person, i) => {
        const overlap = i ? '-ml-2.5' : '';
        const z = { position: 'relative', zIndex: 10 - Math.abs(i - YOU) } as const;
        if (!person) {
          const seat = SEAT[i];
          return (
            <span
              key={`seat-${i}`}
              aria-hidden="true"
              data-first-session-seat=""
              className={`pointer-events-none relative inline-flex h-9 w-9 shrink-0 items-end justify-center rounded-full ${overlap}`}
              style={{ ...z, background: seat.bg, boxShadow: `0 0 0 2.5px ${GROUND}` }}
            >
              <span className="absolute inset-0 flex items-end justify-center overflow-hidden rounded-full">
                <PersonSilhouetteIcon aria-hidden="true" className="-mb-1 block h-8 w-8" style={{ color: seat.ink }} />
              </span>
            </span>
          );
        }
        const name = nameOf(person) || '?';
        return (
          <span
            key={`${name}-${i}`}
            aria-hidden="true"
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white ${overlap}`}
            style={{ ...z, background: swatchFor(name), boxShadow: `0 0 0 2px ${GROUND}` }}
          >
            {name.charAt(0).toUpperCase()}
          </span>
        );
      })}
    </div>
  );
}
