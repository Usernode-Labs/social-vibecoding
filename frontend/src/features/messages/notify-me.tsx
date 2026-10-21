import { useEffect, useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import * as api from './api';

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
 *
 * A PROJECT'S FIRST VERSION (run six, 14 Oct 2026) gets a switch instead,
 * and it starts ON (NotifyLive below): its build takes about 23 minutes,
 * people leave, and the tour's last step had promised "we'll message you
 * when it's live" while a light "Notify me when it's ready" sat untapped.
 * The server holds it (services/homeroom-bot-dm.js firstVersionNotify, on
 * from Make it): on, the first version's ready and live ring the bell and
 * the phone, and its live is emailed when no phone can take the push; off,
 * they are said in the chat and ring nothing. On reads "✓ We'll tell you
 * when it's live", grey with a check as a settled state is; a tap turns it
 * off ("Notify me when it's live", the accent's tint again) and back on.
 * Turning it back on is a tap, so it asks what the offer asks.
 */

export type NotifyMeState = 'offer' | 'asking' | 'granted' | 'denied' | 'here';

/** What the button says before it is tapped, once it is, and when notifications are off. */
export const NOTIFY_ME_OFFER = 'messages:bot.notify.offer';
export const NOTIFY_ME_DONE = 'messages:bot.notify.done';
export const NOTIFY_ME_OFF = 'messages:bot.notify.off';

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
  const t = useMessages('messages');
  const done = state !== 'offer' && state !== 'asking';
  const off = state === 'denied';
  return (
    <div className="messages-bot-answers" role="group" aria-label={t('messages:bot.notify.groupName')} aria-live="polite">
      <button
        type="button"
        className={done ? 'messages-bot-done' : 'messages-bot-tint'}
        data-bot-notify-me={done ? state : ''}
        disabled={state !== 'offer'}
        onClick={() => onTap?.()}
      >
        {done && !off ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        <span>{off ? t(NOTIFY_ME_OFF) : done ? t(NOTIFY_ME_DONE) : t(NOTIFY_ME_OFFER)}</span>
      </button>
      {off && settings ? (
        <button type="button" className="messages-bot-secondary" onClick={() => onSettings?.()}>{t('messages:bot.notify.turnOn')}</button>
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

/** The first version's switch, on and off (run six). */
export const NOTIFY_LIVE_ON = 'messages:bot.notify.liveOn';
export const NOTIFY_LIVE_OFF = 'messages:bot.notify.liveOff';

/**
 * The first version's switch in either state: a pure render, so a test can
 * draw both. A switch, so its state is read out as on or off; never
 * `aria-pressed`, whose accent fill (app.css) is for a choice still to send.
 */
export function NotifyLiveView({ on, busy = false, settings = false, onToggle, onSettings }: {
  on: boolean;
  /** Saving the last tap: the switch waits for it. */
  busy?: boolean;
  /** On, but the app's notifications are off and the app can open its settings. */
  settings?: boolean;
  onToggle?: () => void;
  onSettings?: () => void;
}) {
  const t = useMessages('messages');
  return (
    <div className="messages-bot-answers" role="group" aria-label={t('messages:bot.notify.groupName')} aria-live="polite">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={on ? 'messages-bot-on' : 'messages-bot-tint'}
        data-bot-notify-live={on ? 'on' : 'off'}
        disabled={busy}
        onClick={() => onToggle?.()}
      >
        {on ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        <span>{on ? t(NOTIFY_LIVE_ON) : t(NOTIFY_LIVE_OFF)}</span>
      </button>
      {on && settings ? (
        <button type="button" className="messages-bot-secondary" onClick={() => onSettings?.()}>{t('messages:bot.notify.turnOn')}</button>
      ) : null}
    </div>
  );
}

/**
 * The switch for the signed-in person's first version of `appSlug`. Drawn
 * on, as the server starts it, and read from the server once drawn (another
 * device may have turned it off); not drawn at all when it is not theirs.
 * A tap saves at once and goes back if the save fails.
 */
export function NotifyLive({ appSlug }: { appSlug: string }) {
  const [on, setOn] = useState(true);
  const [mine, setMine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    let current = true;
    api.getFirstVersionNotify(appSlug).then((value) => {
      if (!current) return;
      if (value === null) setMine(false);
      else setOn(value);
    }).catch(() => { /* unread: it shows what the server starts it as */ });
    return () => { current = false; };
  }, [appSlug]);

  async function toggle() {
    if (busy) return;
    const next = !on;
    setBusy(true);
    setOn(next);
    // Back on is asked in the tap itself, as Notify me asks: the app's
    // permission prompt (when undecided) and "Your builds" pushes.
    const asking = next ? askToNotify() : null;
    try {
      const saved = await api.setFirstVersionNotify(appSlug, next);
      setOn(saved);
      setSettings(saved && asking ? (await asking).settings : false);
    } catch (err) {
      console.warn('[notify-me] First version notifications not saved:', err);
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  if (!mine) return null;
  return (
    <NotifyLiveView
      on={on}
      busy={busy}
      settings={settings}
      onToggle={() => { void toggle(); }}
      onSettings={() => {
        const host = window as unknown as NotifyMeHost;
        void host.usernode?.openNotificationSettings?.()?.catch?.(() => {});
      }}
    />
  );
}
