/**
 * `#profile-app-slots-sheet` — the App allowance card, opened from Me's
 * "App slots" row when no slot is free (issue #6446).
 *
 * The row has always opened the make screen in place. With every slot used
 * (or the whole server full) that screen can only say so and pale its Make
 * it, so the row opens this card instead: the same AppAllowance box the make
 * screen shows, unchanged, with its Request more. The card has one job,
 * telling the viewer why they cannot make a project and letting them ask for
 * more slots; a free slot keeps today's behaviour, the make screen.
 *
 * The same presentation as ./friends-sheet.tsx, for the same reasons:
 * rendered inside #profile-root while `appSlotsOpen` is set, and handed to
 * the native kit's MODAL by lib/kit-surface.ts. With no kit the card simply
 * stays where React put it, at the top of the screen. The root and card class
 * strings are constants (the kit writes onto them), and the card is brought
 * home in the layout-effect cleanup, before React removes it.
 *
 * Its words are the allowance box's own (`dialogs:allowance.*`), already in
 * the catalogs: no new copy, and the same sentences the make screen says.
 */

import { useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { AppAllowance } from '../dialogs/app-allowance';
import { Profile } from './profile.js';

/** The no-kit card chrome, on the node the kit flags. Constant. */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/** The lifted card. Constant. */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

// × as a character: this is text, not HTML source.
const TIMES = '×';

export function AppSlotsSheet(): ReactNode {
  const t = useMessages('dialogs');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Hand the card to the native kit, exactly once, and put it back before
  // React ever tries to remove it. Same shape as ./friends-sheet.tsx.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        Profile._dismissAppSlots();
      },
    });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.release();
    };
  }, []);

  return (
    <div id="profile-app-slots-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-app-slots-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold">{t('dialogs:allowance.title')}</h2>
          <Button
            id="profile-app-slots-close"
            variant="neutral"
            size="sm"
            ink="neutral"
            aria-label={t('core:common.close')}
            onClick={() => Profile._dismissAppSlots()}
          >
            {TIMES}
          </Button>
        </div>
        <div className="mt-3">
          <AppAllowance id="profile-app-quota" surface="inset" />
        </div>
      </div>
    </div>
  );
}
