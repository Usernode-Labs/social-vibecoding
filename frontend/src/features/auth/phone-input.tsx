/**
 * The phone number field every phone step shares (#4208): a country in
 * front of the number, so a person types their number the way they write it
 * at home, and the E.164 number the server takes is built here.
 *
 *   [🇬🇧 +44 ⌄] [07700 900123]   →   +447700900123
 *
 * The country is a native <select> laid over the flag and dial code, so a
 * phone opens its own picker. It starts at the last one chosen on this
 * device (localStorage), else the browser's region
 * (Intl.Locale(navigator.language).maximize().region), else the US. A
 * number that starts with "+" (pasted, or iOS autofill with
 * autocomplete="tel") is taken as it is and the country follows it.
 *
 * The server is unchanged (src/services/firebase-phone-auth.js
 * normalizePhone): it takes E.164 only and never guesses a country. This
 * side checks the number for its country before anything is sent and says
 * what is wrong in plain words; the rules are ./phone-numbers.ts, a lazy
 * chunk loaded when the field is drawn.
 *
 * Callers keep their own ref to the number's <input>, as before, and read
 * it with `readPhone`: the chosen country rides on the input as
 * `data-phone-country`, so a step's Return-walks and focus code are as they
 * were. The prerender ships the US with one <option>; the device's default
 * and the full list arrive in an effect, so hydration matches.
 */

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';

/**
 * A typed "+…" number as the server takes it (firebase-phone-auth.js
 * normalizePhone): `+`, the country code and the number, with spaces,
 * dashes, dots and brackets dropped. Null for anything else; no country
 * code is guessed, since a wrong guess would text somebody else.
 */
export function phoneE164(raw: string): string | null {
  const value = String(raw || '').replace(/[\s().‐-―-]/g, '');
  return /^\+[1-9][0-9]{1,14}$/.test(value) ? value : null;
}

/** The flag emoji: two regional-indicator letters. */
export function flag(country: string): string {
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export type PhoneRead = { ok: true; e164: string } | { ok: false; error: string };

type Numbers = typeof import('./phone-numbers');
let numbers: Promise<Numbers> | null = null;
const loadNumbers = (): Promise<Numbers> => (numbers ||= import('./phone-numbers'));

/** Read a PhoneInput's number through the caller's ref to its <input>. */
export async function readPhone(el: HTMLInputElement | null | undefined): Promise<PhoneRead> {
  let n: Numbers;
  try {
    n = await loadNumbers();
  } catch {
    // The chunk could not load: a "+…" number still goes as it is.
    numbers = null;
    const value = phoneE164(el?.value || '');
    return value ? { ok: true, e164: value } : { ok: false, error: translate('auth:phone.loadFailed') };
  }
  const country = el?.dataset.phoneCountry;
  return n.toE164(el?.value || '', n.isCountry(country) ? country : n.FALLBACK);
}

const PLACEHOLDER: Record<string, string> = { US: '415 555 0123', CA: '415 555 0123', GB: '07700 900123' };

const CHIP = 'relative mr-3 flex shrink-0 items-center gap-1 rounded-sm border-r border-[color:var(--app-sheet-line)] pr-3 text-[17px] text-zinc-900 dark:text-zinc-100 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-500';
const SELECT = 'absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0';
const INPUT = 'min-w-0 flex-1 border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';

export function PhoneInput({ id, inputRef, defaultValue = '', className = '', onKeyDown }: {
  /** The number's <input> id, which the step's <label> names. */
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The number sent last (E.164), when the step is come back to. */
  defaultValue?: string;
  /** The row's own padding, where the caller's field has none. */
  className?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  const t = useMessages('auth');
  const [country, setCountry] = useState('US');
  const [dial, setDial] = useState('1');
  const [options, setOptions] = useState<{ code: string; label: string }[]>([{ code: 'US', label: `${flag('US')} +1` }]);
  const [n, setN] = useState<Numbers | null>(null);

  useEffect(() => {
    let live = true;
    loadNumbers().then((mod) => {
      if (!live) return;
      const fallback = mod.defaultCountry();
      const start = mod.countryOfPlus(inputRef.current?.value || defaultValue, fallback) || fallback;
      setN(mod);
      setCountry(start);
      setDial(mod.dialCode(start));
      setOptions(mod.countryOptions());
    }).catch(() => { numbers = null; });
    return () => { live = false; };
    // Once, on mount: the device's default, or the number come back to.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (next: string) => {
    if (!n || !n.isCountry(next) || next === country) return;
    setCountry(next);
    setDial(n.dialCode(next));
    n.storeCountry(next);
  };

  return (
    <div className={`flex items-center ${className}`}>
      <div className={CHIP} data-phone-country-chip="">
        <span aria-hidden="true">{flag(country)}</span>
        <span>+{dial}</span>
        <ChevronDownIcon className="h-4 w-4 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <select aria-label={t('auth:phone.country')} value={country} onChange={(e) => choose(e.target.value)} className={SELECT}>
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      </div>
      <input
        ref={inputRef}
        id={id}
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        enterKeyHint="go"
        defaultValue={defaultValue}
        placeholder={PLACEHOLDER[country] || ''}
        data-phone-country={country}
        onChange={(e) => {
          const follows = n && n.isCountry(country) ? n.countryOfPlus(e.target.value, country) : null;
          if (follows) choose(follows);
        }}
        onKeyDown={onKeyDown}
        className={INPUT}
      />
    </div>
  );
}
