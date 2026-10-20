/**
 * "Two quick questions", the waiting room's optional card (#5261).
 *
 * The in-app join form (`#waitlist`) asked an email, a country and how you
 * found us, and wrote a waitlist row of its own beside the one Get started's
 * account gets (services/waitlist.js ensureAccountSignup): two ways in, two
 * records. That form is retired. Continue makes the account and puts it in
 * line, and the two questions it asked besides the address are asked here,
 * right after, in the room every account without access lands in. Both are
 * optional and the card can be skipped.
 *
 * The answers go to the account's own waitlist row through
 * POST /api/auth/waiting/about, validated by the same rules as the public
 * join (validateStage1), and stored in the same keys the form wrote
 * (`answers.country`, `answers.discovery.source`), so the admin Waitlist and
 * its export read them as before.
 *
 * An old `/#waitlist?ref=<code>` link opens Continue now; the shell keeps the
 * code (AuthScreens.keepWaitlistRef, sessionStorage) and this card sends it
 * on, as the join used to, whether or not the questions are answered.
 *
 * The card shows only when the row has neither answer and this browser has
 * not skipped it. A skip is a per-viewer convenience, so it lives in
 * localStorage, and a browser that refuses storage simply asks again next
 * time. In a shot (`?shot=waiting`) it shows with nothing asked of the server.
 */

import { useCallback, useEffect, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

import { useMessages } from '../../lib/i18n/react';
import { ChipRow, options as opts, SURVEY_SELECT, useWaitlistOptions } from './waitlist-shared';

/** Where the shell keeps an old link's referral code (public/js/auth-screens.js). */
export const WAITLIST_REF_KEY = 'usernode:waitlist-ref';
/** This browser skipped the card. */
export const ABOUT_SKIPPED_KEY = 'usernode:waiting-about-skipped';

/** The card's Save: the same pill as the invite box's Join. */
const SAVE = `${buttonVariants({
  layout: 'shrink',
  variant: 'pillAccent',
  size: 'pill',
  ink: 'solidLate',
})} disabled:opacity-60`;

/** `?shot=waiting` or `?shot=waiting-invite`: ./waiting.tsx waitingShot's rule. */
function inShot(): boolean {
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    return shot === 'waiting' || shot === 'waiting-invite';
  } catch {
    return false;
  }
}

function skipped(): boolean {
  try { return window.localStorage.getItem(ABOUT_SKIPPED_KEY) === '1'; } catch { return false; }
}

function rememberSkip(): void {
  try { window.localStorage.setItem(ABOUT_SKIPPED_KEY, '1'); } catch { /* asked again next time */ }
}

/** The kept referral code, once: read and forgotten. */
export function takeWaitlistRef(): string | null {
  try {
    const ref = window.sessionStorage.getItem(WAITLIST_REF_KEY);
    window.sessionStorage.removeItem(WAITLIST_REF_KEY);
    return ref && /^[a-z0-9]{10}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

async function postAbout(body: Record<string, string>): Promise<Response> {
  return fetch('/api/auth/waiting/about', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function WaitingAbout() {
  const t = useMessages('auth');
  const options = useWaitlistOptions();
  const [view, setView] = useState<'none' | 'ask' | 'saved'>('none');
  const [country, setCountry] = useState('');
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A shot of the room (`?shot=waiting`, inShot): read in
  // the effect, since the first render has no location to read.
  const [shot, setShot] = useState(false);

  useEffect(() => {
    if (inShot()) {
      setShot(true);
      setView('ask');
      return undefined;
    }
    let live = true;
    const ref = takeWaitlistRef();
    if (ref) void postAbout({ invite_code: ref }).catch(() => {});
    void (async () => {
      try {
        const res = await fetch('/api/auth/waiting/about', { credentials: 'same-origin' });
        if (!res.ok) return;
        const body = await res.json();
        if (live && body?.listed && !body.country && !body.discovery && !skipped()) setView('ask');
      } catch {
        /* the room reads as it did without the card */
      }
    })();
    return () => { live = false; };
  }, []);

  const onSave = useCallback(async () => {
    if (saving || (!country && !discovery)) return;
    if (shot) { setView('saved'); return; }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (country) body.country = country;
      if (discovery) body.discovery_source = discovery;
      const res = await postAbout(body);
      if (res.ok) setView('saved');
      else setError(t('auth:waiting.about.failed'));
    } catch {
      setError(t('auth:waiting.about.failed'));
    } finally {
      setSaving(false);
    }
  }, [saving, country, discovery, shot, t]);

  const onSkip = useCallback(() => {
    if (!shot) rememberSkip();
    setView('none');
  }, [shot]);

  if (view === 'none') return null;
  if (view === 'saved') {
    return (
      <p data-waiting-about="saved" role="status" className="mt-7 text-[15px] text-zinc-500 dark:text-zinc-400">
        {t('auth:waiting.about.saved')}
      </p>
    );
  }
  return (
    <form
      data-waiting-about="ask"
      className="mt-7 rounded-[20px] bg-white p-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
      onSubmit={(e) => { e.preventDefault(); void onSave(); }}
    >
      <h2 className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{t('auth:waiting.about.title')}</h2>
      <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:waiting.about.lead')}</p>
      <label htmlFor="waiting-about-country" className="mt-4 block text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
        {t('auth:waiting.about.country')}
      </label>
      <Select
        id="waiting-about-country"
        value={country}
        onChange={(e) => { setCountry(e.target.value); setError(null); }}
        className="mt-1.5"
        {...SURVEY_SELECT}
      >
        <option value="">{t('auth:waiting.about.countryPlaceholder')}</option>
        {opts(options?.countries)}
      </Select>
      <p className="mt-4 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">{t('auth:waiting.about.discovery')}</p>
      <ChipRow
        id="waiting-about-discovery"
        className="mt-1.5 flex flex-wrap gap-1.5"
        options={options?.discovery_sources || {}}
        value={discovery}
        onChange={(next) => { setDiscovery(next); setError(null); }}
      />
      {error ? <p role="alert" className="mt-2 text-[13px] text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="mt-4 flex items-center gap-4">
        <button id="waiting-about-save" type="submit" disabled={saving || (!country && !discovery)} className={SAVE}>
          {saving ? t('auth:waiting.about.saving') : t('auth:waiting.about.save')}
        </button>
        <button
          id="waiting-about-skip"
          type="button"
          onClick={onSkip}
          className="px-1 py-2 text-[15px] font-medium text-violet-700 hover:underline dark:text-violet-400"
        >
          {t('auth:waiting.about.skip')}
        </button>
      </div>
    </form>
  );
}
