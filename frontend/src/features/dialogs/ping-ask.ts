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
 * The ask itself, and every rule about when it may appear, is
 * `NativeChrome.askForPing` in public/js/native-chrome.js: it shows nothing
 * outside the iOS app, nothing once the permission is decided either way,
 * and calls the OS prompt only after "Notify me". This module is only the
 * create dialog's door to it, so the dialog stays one call away from the
 * legacy global and never awaits it.
 */

/** The `_PING_ASK_COPY` key in public/js/native-chrome.js. */
export const PING_ASK_REASON = 'app-building';

interface PingAskHost {
  NativeChrome?: {
    askForPing?(options: { reason: string }): Promise<unknown>;
  };
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
    void Promise.resolve(chrome.askForPing({ reason: PING_ASK_REASON })).catch((err: unknown) => {
      console.warn('[create-app] notification ask failed:', err);
    });
  } catch (err) {
    console.warn('[create-app] notification ask failed:', err);
  }
}
