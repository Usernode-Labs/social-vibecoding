/**
 * One phone field for every place Homeroom asks for a number: a country
 * selector (flag and dial code, "🇺🇸 +1 ▾") in front of the number, so a
 * person types it the way they would write it at home — "07700 900123" in
 * the UK — and the E.164 the server takes is built here, on the client.
 * The server is not changed: its normalizePhone (firebase-phone-auth.js)
 * still refuses anything that is not a full "+" number and never guesses a
 * country, since a wrong guess would text somebody else.
 *
 * The selector is a native <select>, transparent, laid over the flag and
 * dial code: no new picker style, and a phone answers with its own wheel
 * (the reason @/components/ui/select.tsx gives for the same choice).
 *
 * Lengths, the trunk prefix and the formatting as you type come from
 * libphonenumber-js with its "min" data set, bundled from frontend/ —
 * nothing is loaded from another site.
 */

import * as React from 'react';

import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import examples from 'libphonenumber-js/examples.mobile.json';

/**
 * A typed phone number as the server takes it (firebase-phone-auth.js
 * normalizePhone): `+`, the country code and the number, with spaces,
 * dashes, dots and brackets dropped. Null for anything else; no country
 * code is guessed, since a wrong guess would text somebody else.
 */
export function phoneE164(raw: string): string | null {
  const value = String(raw || '').replace(/[\s().‐-―-]/g, '');
  return /^\+[1-9][0-9]{1,14}$/.test(value) ? value : null;
}

// The server's fictional test range (src/services/firebase-phone-auth.js
// TEST_NUMBER_RE, copied here): +1 with any area code, 555 0100 to 0199.
const TEST_NUMBER_RE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;

/**
 * Whether a parsed number may go to the server. libphonenumber marks the
 * reserved example ranges invalid (the UK's 07700 900xxx among them), and a
 * real number its data does not list should still be sent: the server takes
 * any E.164 and the text either arrives or fails there. So the bar is the
 * country's lengths (isPossible) and its pattern (isValid), plus the test
 * range; what cannot pass is a number that is too short or too long for the
 * country it claims.
 */
function usable(parsed: { number: string; isValid(): boolean; isPossible(): boolean }): boolean {
  return TEST_NUMBER_RE.test(parsed.number) || parsed.isValid() || parsed.isPossible();
}

/** What readPhone made of what is in the field. */
export type PhoneRead =
  | { ok: true; e164: string; country: CountryCode | undefined }
  | { ok: false; error: string };

/** The country's name as a sentence would say it: "the UK", "the US", otherwise its usual name. */
export function countryPhrase(cc: string): string {
  if (cc === 'GB') return 'the UK';
  if (cc === 'US') return 'the US';
  return displayName(cc) || cc;
}

/** The country's name in the person's language, when the platform can say one. */
function displayName(cc: string): string | undefined {
  try {
    const locales = typeof navigator !== 'undefined' && navigator.language ? [navigator.language, 'en'] : ['en'];
    return new Intl.DisplayNames(locales, { type: 'region' }).of(cc);
  } catch {
    return undefined;
  }
}

/** The country's flag: its two-letter code as a pair of regional-indicator characters. */
export function countryFlag(cc: string): string {
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

const STORAGE_KEY = 'usernode:phone-country';
const SUPPORTED = new Set<string>(getCountries());

/**
 * The country this device starts on: the one last chosen here, else the one
 * the browser says the person is in, else the United States. Every read is
 * its own try, for a private window and for a platform without one of these.
 */
export function defaultCountry(): CountryCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.has(saved)) return saved as CountryCode;
  } catch { /* no localStorage: the detected one, then */ }
  try {
    const locale = new Intl.Locale(navigator.language);
    const region = typeof locale.maximize === 'function' ? locale.maximize().region : locale.region;
    if (region && SUPPORTED.has(region)) return region as CountryCode;
  } catch { /* no locale to read: the United States */ }
  return 'US';
}

type CountryOption = { cc: CountryCode; label: string };
let optionsCache: CountryOption[] | null = null;

/** Every country libphonenumber knows, by its usual name, for the selector. */
function countryOptions(): CountryOption[] {
  if (!optionsCache) {
    optionsCache = getCountries()
      .map((cc) => ({ cc, name: displayName(cc) || cc }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ cc, name }) => ({ cc, label: `${countryFlag(cc)} ${name} +${getCountryCallingCode(cc)}` }));
  }
  return optionsCache;
}

function notLocalMessage(country: CountryCode): string {
  return `That doesn't look like a mobile number in ${countryPhrase(country)}.`;
}

/**
 * What is in the field, as the server would take it. `country` is the
 * selector's choice and answers the local way of writing a number; a value
 * that already carries its own "+" stands as it is and reports the country
 * libphonenumber read off it, when it can read one.
 */
export function readPhone(country: CountryCode, raw: string): PhoneRead {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Enter your phone number.' };
  if (text.startsWith('+')) {
    const e164 = phoneE164(text);
    if (!e164) return { ok: false, error: "That doesn't look like a full phone number." };
    const parsed = parsePhoneNumberFromString(e164);
    if (parsed && usable(parsed)) return { ok: true, e164: parsed.number, country: parsed.country };
    return {
      ok: false,
      error: parsed?.country ? notLocalMessage(parsed.country) : "That doesn't look like a full phone number.",
    };
  }
  // The local way. parsePhoneNumberFromString drops the trunk 0 where the
  // country uses one (UK 07700 900123 becomes +447700900123) and keeps the
  // leading 0 where it is part of the number, as in Italy.
  const parsed = parsePhoneNumberFromString(text, country);
  if (parsed && usable(parsed)) return { ok: true, e164: parsed.number, country: parsed.country ?? country };
  return { ok: false, error: notLocalMessage(country) };
}

/** What a parent holds the field by: what to send, and where the typing goes. */
export type PhoneFieldHandle = {
  /** The number as it stands in the field. */
  readonly value: string;
  /** The E.164 to send, or the words to show for why not. */
  read(): PhoneRead;
  focus(options?: FocusOptions): void;
};

export type PhoneFieldProps = {
  id: string;
  labelClassName?: string;
  inputClassName?: string;
  enterKeyHint?: 'go' | 'next' | 'done' | 'send';
  /** An E.164 number to start from ("Use another number"): its country, in its national format. */
  defaultValue?: string;
};

export const PhoneField = React.forwardRef<PhoneFieldHandle, PhoneFieldProps>(function PhoneField(
  { id, labelClassName, inputClassName, enterKeyHint, defaultValue = '' },
  ref,
) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  // The United States until the effect below has read the device: nothing
  // here may differ between a first render and the next (no navigator, no
  // localStorage during render, so no hydration mismatch).
  const [country, setCountry] = React.useState<CountryCode>('US');
  const [value, setValue] = React.useState('');
  const countryRef = React.useRef(country);
  countryRef.current = country;

  React.useImperativeHandle(ref, () => ({
    get value() { return inputRef.current?.value ?? ''; },
    read: () => readPhone(countryRef.current, inputRef.current?.value ?? ''),
    focus: (options?: FocusOptions) => inputRef.current?.focus(options),
  }), []);

  // The device's own country; a "+" default keeps the country and the
  // national format of the number it names.
  React.useEffect(() => {
    const start = defaultCountry();
    const text = defaultValue.trim();
    if (text.startsWith('+')) {
      const parsed = parsePhoneNumberFromString(text);
      const cc = parsed?.country;
      setCountry(cc && SUPPORTED.has(cc) ? cc : start);
      setValue(parsed ? parsed.formatNational() : text);
      return;
    }
    setCountry(start);
    // The device is read once, when the field arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (next.trim().startsWith('+')) {
      // Pasted, or the phone's autofill: as typed, and the selector follows
      // the number's country when libphonenumber can read one off it (not
      // saved: the device's own choice stands for the next visit).
      setValue(next);
      const parsed = parsePhoneNumberFromString(next);
      if (parsed?.country && SUPPORTED.has(parsed.country)) setCountry(parsed.country);
      return;
    }
    // Spaced out as the person types, and only where they are typing: a
    // reformat under a caret set in the middle would move it.
    const el = e.target;
    const atEnd = el.selectionStart === next.length && el.selectionEnd === next.length;
    setValue(atEnd ? new AsYouType(countryRef.current).input(next) : next);
  }

  function handleCountryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const cc = e.target.value as CountryCode;
    if (!SUPPORTED.has(cc)) return;
    const previous = countryRef.current;
    setCountry(cc);
    try {
      localStorage.setItem(STORAGE_KEY, cc);
    } catch { /* no localStorage: this visit only */ }
    // What is typed so far, written the new country's way.
    setValue((prev) => {
      if (!prev.trim()) return prev;
      const parsed = parsePhoneNumberFromString(prev, previous);
      return parsed ? parsed.formatNational() : prev;
    });
  }

  // An example number in the chosen country's own shape, national, so it
  // never starts with "+". The data set carries one example per country;
  // the literal is only for the day it does not.
  const placeholder = getExampleNumber(country, examples)?.formatNational() || '415 555 0123';

  return (
    <>
      <label htmlFor={id} className={labelClassName}>Phone number</label>
      <div className="flex items-center">
        <span className="group relative shrink-0">
          <select
            aria-label="Country"
            value={country}
            onChange={handleCountryChange}
            className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          >
            {countryOptions().map(({ cc, label }) => (
              <option key={cc} value={cc}>{label}</option>
            ))}
          </select>
          <span aria-hidden="true" className="whitespace-nowrap text-[17px] text-zinc-900 group-focus-within:underline dark:text-zinc-100">
            {countryFlag(country)} +{getCountryCallingCode(country)}{' '}
            <span className="text-zinc-500 dark:text-zinc-400">▾</span>
          </span>
        </span>
        <span aria-hidden="true" className="mx-3 h-[22px] w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />
        <input
          ref={inputRef}
          id={id}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          enterKeyHint={enterKeyHint}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          className={inputClassName}
        />
      </div>
    </>
  );
});
