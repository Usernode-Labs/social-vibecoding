import { useState } from 'react';

/*
 * "Notify me when it's ready", under the line Homeroom bot says once its
 * maker pressed Build it on a plan, "I'll message you here when it's ready to
 * try." (./bot-plan.tsx BotPlanFollowUp, #4046). 5 October: the person who
 * asked for a first version had no way to say "tell me when it's done", nor
 * to learn that Homeroom bot would.
 *
 * The tap is the only thing that asks for anything, and it asks once:
 *   - in the Homeroom app, NativeChrome.notifyWhenReady (public/js/
 *     native-chrome.js) asks the OS for the notification permission when it
 *     has not been decided, and when it has been allowed already only
 *     confirms. The bot's "ready to try" message then rings the phone.
 *   - in a browser there is no web push, so it confirms what does happen:
 *     the bot messages them here (and Homeroom emails "ready to try" when no
 *     phone can take the push, services/activity-mail.js).
 * Either way the account's "Your builds" pushes are switched back on if they
 * had been switched off, since that is what the tap asks for.
 *
 * Offered while the first version is being built, and never again once
 * chosen here (CHOSEN_KEY, per account): an old plan in the chat does not
 * keep asking. It is the accent's tint: an action, quieter than Build it.
 */

export type NotifyMeState = 'offer' | 'asking' | 'granted' | 'denied' | 'here';

/** What the card says once the tap is answered. */
export const NOTIFY_ME_LINES: Record<Exclude<NotifyMeState, 'offer' | 'asking'>, string> = {
  granted: 'I’ll send you a notification when it’s ready.',
  denied: 'Notifications are off for Homeroom, so I’ll message you here when it’s ready.',
  here: 'I’ll message you here when it’s ready.',
};

const CHOSEN_KEY = 'usernode:notify-me-chosen';

function chosenKey(userId: number | null | undefined): string {
  return `${CHOSEN_KEY}:${Number(userId) || 0}`;
}

/** Whether this account already chose on this device. */
export function notifyMeChosen(userId: number | null | undefined): boolean {
  try { return localStorage.getItem(chosenKey(userId)) === '1'; } catch { return false; }
}

function markNotifyMeChosen(userId: number | null | undefined): void {
  try { localStorage.setItem(chosenKey(userId), '1'); } catch { /* storage unavailable: offered again next time */ }
}

interface ReadyPingAnswer { outcome?: string; settings?: boolean }

interface NotifyMeHost {
  NativeChrome?: { notifyWhenReady?(): Promise<ReadyPingAnswer> };
  usernode?: { openNotificationSettings?(): Promise<unknown> };
}

/** Pure: what the card says, from NativeChrome.notifyWhenReady's answer (null: no app). */
export function notifyMeOutcome(answer: ReadyPingAnswer | null): Exclude<NotifyMeState, 'offer' | 'asking'> {
  if (answer && answer.outcome === 'granted') return 'granted';
  if (answer && answer.outcome === 'denied') return 'denied';
  return 'here';
}

/** "Your builds" pushes back on for the account, when they were switched off. Best effort. */
async function buildsPushOn(): Promise<void> {
  try {
    const res = await fetch('/api/me/mobile-push-preferences', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    const builds = Array.isArray(body?.preferences)
      ? body.preferences.find((p: { key?: string }) => p && p.key === 'builds') : null;
    if (!builds || builds.enabled !== false) return;
    await fetch('/api/me/mobile-push-preferences', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { builds: true } }),
    });
  } catch (err) {
    console.warn('[notify-me] Your builds not switched on:', err);
  }
}

/** The tap: ask (in the app) or confirm (anywhere). Never throws. */
export async function askToNotify(host: NotifyMeHost = window as unknown as NotifyMeHost): Promise<{ state: Exclude<NotifyMeState, 'offer' | 'asking'>; settings: boolean }> {
  const chrome = host.NativeChrome;
  let answer: ReadyPingAnswer | null = null;
  if (chrome && typeof chrome.notifyWhenReady === 'function') {
    try { answer = await chrome.notifyWhenReady(); } catch { answer = { outcome: 'unknown' }; }
  }
  void buildsPushOn();
  const state = notifyMeOutcome(answer);
  return { state, settings: state === 'denied' && answer?.settings === true };
}

export function NotifyMe({ userId, quietHere = false }: {
  userId: number | null | undefined;
  /** The line above already says "I'll message you here": a browser's answer adds nothing to it. */
  quietHere?: boolean;
}) {
  const [state, setState] = useState<NotifyMeState>('offer');
  const [settings, setSettings] = useState(false);

  async function tap() {
    if (state !== 'offer') return;
    setState('asking');
    markNotifyMeChosen(userId);
    const answered = await askToNotify();
    setSettings(answered.settings);
    setState(answered.state);
  }

  if (state === 'offer' || state === 'asking') {
    return (
      <div className="messages-bot-answers" role="group" aria-label="Notifications">
        <button
          type="button"
          className="messages-bot-tint"
          data-bot-notify-me=""
          disabled={state === 'asking'}
          onClick={() => { void tap(); }}
        >
          <span>Notify me when it’s ready</span>
        </button>
      </div>
    );
  }
  if (state === 'here' && quietHere) return null;
  const host = window as unknown as NotifyMeHost;
  return (
    <div data-bot-notify-me={state}>
      <p className="messages-bot-answered" role="status">{NOTIFY_ME_LINES[state]}</p>
      {settings ? (
        <div className="mt-2 messages-bot-answers">
          <button
            type="button"
            className="messages-bot-secondary"
            onClick={() => { void host.usernode?.openNotificationSettings?.()?.catch?.(() => {}); }}
          >
            Turn on notifications
          </button>
        </div>
      ) : null}
    </div>
  );
}
