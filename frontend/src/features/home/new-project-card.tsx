/**
 * "Have an idea?": Home's New project card.
 *
 * The first card of Home's side column (`#home-aside`, ./index.tsx), beside
 * the pinned lists from 1280px. Narrower than that Home is one column and the
 * card is not drawn: Pinned apps' own New project control is the way there.
 * The card says what
 * making a project is in one sentence, carries the one New project button, and
 * says how many project slots are left, with the way to ask for more once none
 * is.
 *
 * It is drawn in the plain card every other card on Home uses: no soft light
 * and no filled accent pill (#6757). Its ✕ closes it for this browser, the way
 * the verify card's "Not now" does (./new-project-dismiss.ts); with the column
 * gone Home is one wide column again and Pinned apps ends with its own New
 * project tile.
 *
 * It is drawn for the viewer `Home.render()` gives a create view
 * (`gridStore.create`): a member who may make projects. A private member,
 * whose Home has the waitlist card instead, gets none. Nothing in the
 * prerender: the grid store starts not ready.
 *
 * The button opens the same make screen as the grid's trailing tile
 * (./create-tile.tsx), in both states, for the reason given there: at the
 * limit that screen is where the numbers are printed.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { PlusWideIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { appAllowanceStore } from '../dialogs/app-allowance-store.js';
import { gridStore, type IconView } from './grid-store';
import { hideNewProjectCard, NEW_PROJECT_HIDDEN_EVENT, newProjectCardHidden } from './new-project-dismiss';

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : {};
}

// The fan of app icons over the heading: the viewer's own pinned apps, the
// middle one largest. Complete class literals (Tailwind reads source text).
const FAN_5 = [
  'h-6 w-6 rounded-md -rotate-12',
  'h-7 w-7 rounded-md -rotate-6',
  'h-8 w-8 rounded-lg',
  'h-7 w-7 rounded-md rotate-6',
  'h-6 w-6 rounded-md rotate-12',
];
// Fewer than five icons take the middle seats, so the fan stays centred on
// its largest tile.
const FAN_SEATS: Record<number, number[]> = {
  1: [2],
  2: [2, 3],
  3: [1, 2, 3],
  4: [1, 2, 3, 4],
  5: [0, 1, 2, 3, 4],
};

// The card is the plane colour every other card on the shell is drawn in,
// under the one hairline: a tinted card with a black button read as the
// loudest thing on Home. Its New project button is the same hairline and ink
// as the card, so the card asks without shouting (#6757).
const CARD = 'home-new-project relative hidden overflow-hidden flex-col gap-3 rounded-[20px] bg-[color:var(--dc-sheet-solid)] p-4 '
  + '[box-shadow:0_0_0_1px_var(--app-sheet-line)_inset] xl:flex';
const BUTTON = 'home-new-project-btn inline-flex h-10 w-full items-center justify-center gap-2 rounded-full '
  + 'bg-transparent text-[14px] font-semibold text-zinc-900 dark:text-zinc-50 '
  + '[box-shadow:0_0_0_1px_var(--app-sheet-line)_inset] transition '
  + 'hover:bg-zinc-100 dark:hover:bg-zinc-800 active:scale-[0.98]';
const DASHED = 'flex shrink-0 items-center justify-center rounded-md border-2 border-dashed '
  + 'border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400';

function FanIcon({ icon, className }: { icon: IconView; className: string }) {
  if (icon.kind !== 'image') return null;
  return <img src={icon.src} alt="" draggable={false} className={`${className} shrink-0 object-cover shadow-sm`} />;
}

/** The pinned apps' pictures the fan draws: at most five, images only. */
export function fanIcons(items: { app: { icon: IconView; demo: boolean } }[]): IconView[] {
  return items
    .filter((item) => !item.app.demo && item.app.icon.kind === 'image')
    .slice(0, 5)
    .map((item) => item.app.icon);
}

/**
 * The line under the button. Null while the allowance is unknown and for an
 * allowance with no limit, where a count would say nothing.
 */
export function slotsState(quota: { limit: number | null; remaining: number | null } | null): 'none' | 'free' | null {
  if (!quota || quota.limit === null || quota.remaining === null) return null;
  return quota.remaining > 0 ? 'free' : 'none';
}

export function NewProjectCard(): ReactNode {
  const t = useMessages('home');
  const grid = useStoreState(gridStore);
  const { quota } = useStoreState(appAllowanceStore) as { quota: { limit: number | null; remaining: number | null } | null };
  const [hidden, setHidden] = useState(false);

  // Read after mount only, so the prerender is unchanged, and follow the
  // close button in the page's own listener: either one hides the card.
  useEffect(() => {
    setHidden(newProjectCardHidden());
    const onHidden = () => setHidden(true);
    window.addEventListener(NEW_PROJECT_HIDDEN_EVENT, onHidden);
    return () => window.removeEventListener(NEW_PROJECT_HIDDEN_EVENT, onHidden);
  }, []);

  if (!grid.ready || !grid.create) return null;
  if (hidden) return null;

  const icons = fanIcons(grid.items);
  const seats = FAN_SEATS[icons.length] || [];
  const slots = slotsState(quota);

  const open = () => { win().App?.showCreateModal?.(); };

  return (
    <section id="home-new-project" className={CARD} aria-labelledby="home-new-project-title">
      <button
        type="button"
        id="home-new-project-close"
        className="absolute end-2.5 top-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
        aria-label={t('home:newProject.close')}
        title={t('home:newProject.close')}
        onClick={hideNewProjectCard}
      >
        <XIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {/* `pe-8` keeps five icons clear of the ✕ in the opposite corner. */}
      <div className="relative flex items-end gap-1.5 pe-8" aria-hidden="true">
        {icons.map((icon, i) => <FanIcon key={i} icon={icon} className={FAN_5[seats[i]]} />)}
        <span className={`${DASHED} h-7 w-7`}>
          <PlusWideIcon className="h-3.5 w-3.5" strokeWidth="2.4" />
        </span>
      </div>
      <div className="relative flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="home-new-project-title" className="text-[15px] font-[650] leading-tight text-zinc-900 dark:text-zinc-50">
            {t('home:newProject.title')}
          </h2>
          <p className="mt-1 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
            {t('home:newProject.body')}
          </p>
        </div>
      </div>
      <button
        type="button"
        id="home-new-project-btn"
        className={BUTTON}
        onClick={open}
      >
        <PlusWideIcon className="h-4 w-4" strokeWidth="2.6" aria-hidden="true" />
        {t('home:create.label')}
      </button>
      {slots === 'free' ? (
        <p id="home-new-project-slots" data-slots="free" className="relative -mt-0.5 flex items-center justify-center gap-2 text-[13px] text-zinc-600 dark:text-zinc-300">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--state-ok)]" aria-hidden="true" />
          <span>
            <RichMessage
              id="home:newProject.slotsFree"
              values={{ count: quota!.remaining }}
              components={[<b className="font-bold text-zinc-900 dark:text-zinc-50" />]}
            />
          </span>
        </p>
      ) : slots === 'none' ? (
        <p id="home-new-project-slots" data-slots="none" className="relative -mt-0.5 text-center text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
          <RichMessage
            id="home:newProject.slotsNone"
            components={[<a href="#profile?slots" className="font-semibold text-[color:var(--accent)] hover:underline" />]}
          />
        </p>
      ) : null}
    </section>
  );
}
