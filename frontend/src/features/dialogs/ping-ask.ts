/**
 * The create dialog's notification ask (#12, decision D10).
 *
 * When the Homeroom bot is building a new project, it messages its creator
 * once the first version is ready to try, and a push notification is how
 * that message reaches a phone in a pocket. So that is when the Homeroom app
 * asks "Get a ping when your app is ready?", rather than on the first screen
 * of a fresh install, which is where the ask used to come from and where it
 * was answered "no" before anyone knew what it was for.
 *
 * The ask itself, and every rule about the phone, is `NativeChrome.askForPing`
 * in public/js/native-chrome.js: it shows nothing outside the Homeroom app (iOS
 * and, since 21 Oct 2026, Android), nothing once the permission is decided
 * either way, and calls the OS prompt only after "Notify me". Whether this
 * account was asked at this moment before, on any device, and its two-Not-nows
 * limit, are the notification ask's (../notify-ask/decide.ts): read first, and
 * the answer recorded after. In a browser the made screen draws the ask's card
 * instead (../notify-ask/notify-ask.tsx, "Get the app to hear when it's
 * ready"). This module is only the made screen's door to the native ask, so
 * the screen stays one call away from the legacy global and never awaits it.
 */

import { planAsk, recordAsk } from '../notify-ask/ask-state';

/** The `_PING_ASK_COPY` key in public/js/native-chrome.js. */
export const PING_ASK_REASON = 'app-building';

interface PingAnswer { shown?: boolean; outcome?: string }

interface PingAskHost {
  NativeChrome?: {
    askForPing?(options: { reason: string }): Promise<PingAnswer | unknown>;
  };
}

/** What askForPing's answer records: yes, Not now, or nothing (it was not shown). */
export function pingAnswer(result: unknown): 'yes' | 'not_now' | null {
  const r = result as PingAnswer | null;
  if (!r || r.shown !== true) return null;
  if (r.outcome === 'notify') return 'yes';
  if (r.outcome === 'not-now') return 'not_now';
  return null;
}

async function ask(chrome: NonNullable<PingAskHost['NativeChrome']>): Promise<void> {
  const { plan } = await planAsk('app_building');
  if (plan.show !== 'app') return;
  const result = await chrome.askForPing!({ reason: PING_ASK_REASON });
  const answer = pingAnswer(result);
  if (answer) await recordAsk('app', 'app_building', answer);
}

/**
 * Offer the ask for a project the Homeroom bot is now building. Called once,
 * right after `POST /api/apps` answers with the bot's chat. Fire and forget:
 * it never throws and nothing waits for it.
 */
export function askForPingWhileBotBuilds(): void {
  if (typeof window === 'undefined') return;
  const chrome = (window as unknown as PingAskHost).NativeChrome;
  if (!chrome || typeof chrome.askForPing !== 'function') return;
  try {
    void ask(chrome).catch((err: unknown) => {
      console.warn('[create-app] notification ask failed:', err);
    });
  } catch (err) {
    console.warn('[create-app] notification ask failed:', err);
  }
}
