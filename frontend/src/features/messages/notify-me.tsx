import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';

/*
 * "Notify me when it's ready", inside a first version's plan card once its
 * maker pressed Build it, while it is being built (./bot-plan.tsx
 * BotPlanCard, #4046). 5 October: the person who asked for a first version
 * had no way to say "tell me when it's done", nor to learn that Homeroom bot
 * would.
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
 * #4046: once tapped, the same button turns grey, with no new line. It says
 * "I'll notify you" with a check, in the bot's voice; when the app's
 * notifications are off it says so instead, with no check, and offers the
 * way to turn them on beside it.
 */

export type NotifyMeState = 'offer' | 'asking' | 'granted' | 'denied' | 'here';

/** What the button says before it is tapped, once it is, and when notifications are off. */
export const NOTIFY_ME_OFFER = 'Notify me when it’s ready';
export const NOTIFY_ME_DONE = 'I’ll notify you';
export const NOTIFY_ME_OFF = 'Notifications are off';

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

/** The button in each state: a pure render, so a test can draw every one. */
export function NotifyMeView({ state, settings = false, onTap, onSettings }: {
  state: NotifyMeState;
  /** Denied, and the app can open its notification settings. */
  settings?: boolean;
  onTap?: () => void;
  onSettings?: () => void;
}) {
  const done = state !== 'offer' && state !== 'asking';
  const off = state === 'denied';
  return (
    <div className="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite">
      <button
        type="button"
        className={done ? 'messages-bot-done' : 'messages-bot-tint'}
        data-bot-notify-me={done ? state : ''}
        disabled={state !== 'offer'}
        onClick={() => onTap?.()}
      >
        {done && !off ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        <span>{off ? NOTIFY_ME_OFF : done ? NOTIFY_ME_DONE : NOTIFY_ME_OFFER}</span>
      </button>
      {off && settings ? (
        <button type="button" className="messages-bot-secondary" onClick={() => onSettings?.()}>Turn on notifications</button>
      ) : null}
    </div>
  );
}

export function NotifyMe({ userId }: { userId: number | null | undefined }) {
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

  return (
    <NotifyMeView
      state={state}
      settings={settings}
      onTap={() => { void tap(); }}
      onSettings={() => {
        const host = window as unknown as NotifyMeHost;
        void host.usernode?.openNotificationSettings?.()?.catch?.(() => {});
      }}
    />
  );
}
