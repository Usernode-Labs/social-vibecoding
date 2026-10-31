/**
 * #6071 follow-up: pick the screen to design. "Design a screen" in a new
 * thread with Homeroom bot (../messages/new-thread.tsx), or the bot's own
 * "Pick the screen" button, takes the person to the project (its app on its
 * App tab, or Homeroom's Home for Homeroom itself or any project) with a
 * small bar floating over the page: they go to the exact screen they want,
 * tap Use this screen, and it is copied into a design thread (./start.ts),
 * as the menu's Design this screen did before it left the menu.
 *
 * The bar is its own host on <body> (#design-pick-host), outside every
 * screen, and the capture leaves it out (./capture.ts), so it is never part
 * of the design. Cancel takes it away; nothing is saved until Use this
 * screen.
 */

import { createElement, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { useMessages } from '../../lib/i18n/react';
import { platformSlug } from '../messages/channel-hub';
import { designThisScreen } from './start';

export const PICK_HOST_ID = 'design-pick-host';

let host: HTMLElement | null = null;

/** Take the bar away. */
export function endScreenPick(): void {
  if (!host) return;
  unmountLegacyPortal(host);
  host.remove();
  host = null;
}

/** Pure: where picking a screen of `appSlug` starts (null: any project). */
export function pickStart(appSlug: string | null, platform: string | null): string {
  return appSlug && appSlug !== platform ? `#app/${encodeURIComponent(appSlug)}/app` : '#home';
}

/**
 * Start picking a screen of `appSlug` (null: whichever screen they go to):
 * go there, and float the bar until they use a screen or cancel.
 */
export function startScreenPick({ appSlug = null, appName = null }: { appSlug?: string | null; appName?: string | null } = {}): void {
  if (typeof document === 'undefined') return;
  endScreenPick();
  window.location.hash = pickStart(appSlug, platformSlug());
  host = document.createElement('div');
  host.id = PICK_HOST_ID;
  document.body.appendChild(host);
  mountLegacyPortal(host, createElement(PickBar, { appName }));
}

function PickBar({ appName }: { appName: string | null }): ReactNode {
  const t = useMessages('messages');
  const [busy, setBusy] = useState(false);
  const use = async () => {
    if (busy) return;
    setBusy(true);
    // The bar goes first, so it is not in the picture either.
    endScreenPick();
    await designThisScreen();
  };
  return (
    <div
      role="dialog"
      aria-label={t('messages:design.pick.label')}
      data-design-pick=""
      className="fixed inset-x-0 bottom-0 z-[2147483000] flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pointer-events-none"
    >
      <div className="pointer-events-auto flex max-w-[34rem] flex-wrap items-center gap-2 rounded-[20px] bg-white p-3 shadow-[0_6px_24px_rgba(0,0,0,0.18),inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <p className="min-w-[12rem] flex-1 text-[13px] text-zinc-600 dark:text-zinc-300">
          {appName ? t('messages:design.pick.hintProject', { project: appName }) : t('messages:design.pick.hint')}
        </p>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={() => endScreenPick()}>
          {t('messages:design.pick.cancel')}
        </Button>
        <Button
          type="button"
          variant="pillAccent"
          size="sm"
          ink="solid"
          disabledStyle="dim"
          disabled={busy}
          onClick={() => { void use(); }}
          data-design-pick-use=""
        >
          {t('messages:design.pick.use')}
        </Button>
      </div>
    </div>
  );
}
