/**
 * #6071: design this screen. Since the follow-up it is reached from Homeroom
 * bot's new thread (Design a screen) or the bot's own Pick the screen, both
 * through the floating Use this screen bar (./pick.tsx), no longer from the
 * Homeroom mark's menu. It captures what the person is looking at (an
 * app on its App tab, through its bridge, or else Homeroom's own page,
 * ./capture.ts), opens it as a design thread in their chat with Homeroom
 * bot, and takes them there, where the bot edits it with them.
 */

import { t } from '../../lib/i18n/runtime';
import { startDesign } from '../messages/api';
import { captureAppPage, capturePlatformPage } from './capture';
import type { DesignCapture } from '../messages/api';

interface ShellWindow {
  App?: { currentApp?: string | null };
  AppView?: { appData?: { name?: string; slug?: string } | null };
  PlatformUI?: { toast?: (text: string) => void };
}

/** The app running in view on its App tab, with its frame, or null. */
function appInView(): { frame: HTMLIFrameElement; slug: string; name: string } | null {
  const frame = document.getElementById('app-iframe') as HTMLIFrameElement | null;
  if (!frame || !frame.src) return null;
  const r = frame.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility()) return null;
  const w = window as unknown as ShellWindow;
  const slug = w.App?.currentApp || w.AppView?.appData?.slug || '';
  if (!slug) return null;
  return { frame, slug, name: w.AppView?.appData?.name || slug };
}

function say(text: string): void {
  const ui = (window as unknown as ShellWindow).PlatformUI;
  if (typeof ui?.toast === 'function') ui.toast(text);
}

// Two frames: the menu that started it has closed before the page is copied.
const settled = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
});

let running = false;

/** Capture the screen in view into a new design thread and open it. Resolves whether it opened. */
export async function designThisScreen(): Promise<boolean> {
  if (running || typeof document === 'undefined') return false;
  running = true;
  try {
    await settled();
    const app = appInView();
    const capture: DesignCapture | null = app ? await captureAppPage(app.frame, app) : capturePlatformPage();
    if (!capture) {
      say(app ? t('messages:design.start.appUnanswered') : t('messages:design.start.tooBig'));
      return false;
    }
    say(t('messages:design.start.opening'));
    const opened = await startDesign(capture);
    if (opened.href) window.location.hash = opened.href;
    return !!opened.href;
  } catch (err) {
    say(err instanceof Error && err.message ? err.message : t('messages:design.start.failed'));
    return false;
  } finally {
    running = false;
  }
}
