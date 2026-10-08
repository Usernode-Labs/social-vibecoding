/**
 * The phone field's numbering rules (#4208), from libphonenumber-js with its
 * min metadata, bundled through frontend/. A chunk of its own
 * (assets/shell-phone-numbers.js, about 32KB gzipped): ./phone-input.tsx
 * imports it when a phone field is drawn, so a visitor who never sees one
 * never downloads it.
 *
 * Validation is by length for the country, not "valid": the min metadata
 * cannot tell a mobile from a landline, and the reserved fictional ranges
 * (+1 … 555 0100-0199, the UK's 07700 900xxx) are possible but not "valid",
 * and must still work.
 */

import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/core';
import metadata from 'libphonenumber-js/min/metadata';

import { flag, phoneE164, type PhoneRead } from './phone-input';

export type { CountryCode };

export const PHONE_COUNTRY_KEY = 'usernode:phone-country';
export const FALLBACK: CountryCode = 'US';

const COUNTRIES = new Set<string>(getCountries(metadata));

export function isCountry(code: unknown): code is CountryCode {
  return typeof code === 'string' && COUNTRIES.has(code);
}

export function dialCode(country: CountryCode): string {
  return getCountryCallingCode(country, metadata);
}

function regionName(country: string): string {
  try {
    const lang = typeof navigator !== 'undefined' && navigator.language ? [navigator.language, 'en'] : ['en'];
    return new Intl.DisplayNames(lang, { type: 'region' }).of(country) || country;
  } catch {
    return country;
  }
}

/** Every country, by name in the browser's language: "🇬🇧 United Kingdom +44". */
export function countryOptions(): { code: CountryCode; label: string }[] {
  return [...COUNTRIES]
    .map((code) => ({ code: code as CountryCode, name: regionName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ code, name }) => ({ code, label: `${flag(code)} ${name} +${dialCode(code)}` }));
}

/** "a UK mobile number", "a mobile number in France". */
function aNumberIn(country: string): string {
  if (country === 'US') return 'a US mobile number';
  if (country === 'GB') return 'a UK mobile number';
  return `a mobile number in ${regionName(country)}`;
}

/** The browser's region, if it is one with a dial code. */
export function localeCountry(language?: string): CountryCode | null {
  try {
    const lang = language ?? (typeof navigator !== 'undefined' ? navigator.language : '');
    if (!lang) return null;
    const region = new Intl.Locale(lang).maximize().region;
    return isCountry(region) ? region : null;
  } catch {
    return null;
  }
}

function storedCountry(): CountryCode | null {
  try {
    const value = localStorage.getItem(PHONE_COUNTRY_KEY);
    return isCountry(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeCountry(country: CountryCode) {
  try { localStorage.setItem(PHONE_COUNTRY_KEY, country); } catch { /* remembered for this page only */ }
}

/** The device's default: the last choice here, else the browser's region, else the US. */
export function defaultCountry(): CountryCode {
  return storedCountry() || localeCountry() || FALLBACK;
}

/**
 * The country a "+…" number belongs to, for the selector to follow: the
 * current one when it shares the dial code (+1 keeps Canada), else the one
 * the whole number names, else the dial code's main country. Null when no
 * dial code is complete yet.
 */
export function countryOfPlus(raw: string, current: CountryCode): CountryCode | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!String(raw || '').trim().startsWith('+') || !digits) return null;
  const codes = (metadata as { country_calling_codes: Record<string, string[]> }).country_calling_codes;
  for (let len = 1; len <= 3 && len <= digits.length; len += 1) {
    const list = codes[digits.slice(0, len)];
    if (!list) continue;
    if (list.includes(current)) return current;
    const named = parsePhoneNumberFromString(`+${digits}`, metadata)?.country;
    if (named && list.includes(named)) return named;
    return isCountry(list[0]) ? list[0] : null;
  }
  return null;
}

/**
 * The number to send, from the country and what was typed. A "+…" number is
 * used as it is; anything else is read as a number in `country`, its trunk
 * 0 dropped (UK "07700 900123" is +447700900123).
 */
export function toE164(raw: string, country: CountryCode): PhoneRead {
  const typed = String(raw || '').trim();
  if (!typed.replace(/\D/g, '')) return { ok: false, error: 'Enter your phone number.' };
  if (typed.startsWith('+')) {
    const value = phoneE164(typed);
    const parsed = value ? parsePhoneNumberFromString(value, metadata) : undefined;
    if (!value || !parsed) return { ok: false, error: 'That doesn\'t look like a phone number. Check the digits after the +.' };
    if (!parsed.isPossible()) {
      return { ok: false, error: `That doesn't look like ${aNumberIn(countryOfPlus(value, country) || country)}.` };
    }
    return { ok: true, e164: value };
  }
  const wrong: PhoneRead = { ok: false, error: `That doesn't look like ${aNumberIn(country)}.` };
  if (/[a-z]/i.test(typed)) return wrong;
  const parsed = parsePhoneNumberFromString(typed, country, metadata);
  const value = parsed ? phoneE164(parsed.number) : null;
  if (!parsed || !value || !parsed.isPossible()) return wrong;
  // A trunk 0 that stayed on: UK "07700 9001" is too short to drop it and
  // would go as +44077009001. Italy keeps its 0 on purpose, so a kept 0 is
  // refused only when the number is not a real one either.
  if (parsed.nationalNumber.startsWith('0') && !parsed.isValid()) return wrong;
  return { ok: true, e164: value };
}
