'use strict';

// Country awareness for outbound SMS: which country an E.164 number belongs
// to, which countries need extra sender registration, and the marketing
// quiet hours this platform encodes.
//
// The calling-code table is longest-prefix first. +1 is special: it is one
// calling code shared by the US, Canada and a set of Caribbean and Pacific
// territories, told apart by their area code (the three digits after the 1).
// Anything else on +1 is the US.
//
// Nothing here talks to Brevo. Brevo cannot be asked which Sender IDs are
// registered, so `senders.js` keeps the operator's registry and this file
// only says what country a number is in.

// Longest-prefix match over this table. A few entries are shared or
// ambiguous in reality (NANP, +7 Russia/Kazakhstan); the map picks the
// country the platform cares about most and the registry is the final gate.
const CALLING_CODES = {
  7: 'RU',
  20: 'EG', 27: 'ZA', 30: 'GR', 31: 'NL', 32: 'BE', 33: 'FR', 34: 'ES',
  36: 'HU', 39: 'IT', 40: 'RO', 41: 'CH', 43: 'AT', 44: 'GB', 45: 'DK',
  46: 'SE', 47: 'NO', 48: 'PL', 49: 'DE',
  51: 'PE', 52: 'MX', 53: 'CU', 54: 'AR', 55: 'BR', 56: 'CL', 57: 'CO',
  58: 'VE',
  60: 'MY', 61: 'AU', 62: 'ID', 63: 'PH', 64: 'NZ', 65: 'SG', 66: 'TH',
  81: 'JP', 82: 'KR', 84: 'VN', 86: 'CN',
  90: 'TR', 91: 'IN', 92: 'PK', 93: 'AF', 94: 'LK', 95: 'MM', 98: 'IR',
  211: 'SS', 212: 'MA', 213: 'DZ', 216: 'TN', 218: 'LY', 220: 'GM',
  221: 'SN', 222: 'MR', 223: 'ML', 224: 'GN', 225: 'CI', 226: 'BF',
  227: 'NE', 228: 'TG', 229: 'BJ', 230: 'MU', 231: 'LR', 232: 'SL',
  233: 'GH', 234: 'NG', 235: 'TD', 236: 'CF', 237: 'CM', 238: 'CV',
  239: 'ST', 240: 'GQ', 241: 'GA', 242: 'CG', 243: 'CD', 244: 'AO',
  245: 'GW', 246: 'IO', 248: 'SC', 249: 'SD', 250: 'RW', 251: 'ET',
  252: 'SO', 253: 'DJ', 254: 'KE', 255: 'TZ', 256: 'UG', 257: 'BI',
  258: 'MZ', 260: 'ZM', 261: 'MG', 262: 'RE', 263: 'ZW', 264: 'NA',
  265: 'MW', 266: 'LS', 267: 'BW', 268: 'SZ', 269: 'KM',
  290: 'SH', 291: 'ER', 297: 'AW', 298: 'FO', 299: 'GL',
  350: 'GI', 351: 'PT', 352: 'LU', 353: 'IE', 354: 'IS', 355: 'AL',
  356: 'MT', 357: 'CY', 358: 'FI', 359: 'BG', 370: 'LT', 371: 'LV',
  372: 'EE', 373: 'MD', 374: 'AM', 375: 'BY', 376: 'AD', 377: 'MC',
  378: 'SM', 380: 'UA', 381: 'RS', 382: 'ME', 383: 'XK', 385: 'HR',
  386: 'SI', 387: 'BA', 389: 'MK',
  420: 'CZ', 421: 'SK', 423: 'LI',
  500: 'FK', 501: 'BZ', 502: 'GT', 503: 'SV', 504: 'HN', 505: 'NI',
  506: 'CR', 507: 'PA', 508: 'PM', 509: 'HT', 590: 'GP', 591: 'BO',
  592: 'GY', 593: 'EC', 594: 'GF', 595: 'PY', 596: 'MQ', 597: 'SR',
  598: 'UY', 599: 'CW',
  670: 'TL', 672: 'NF', 673: 'BN', 674: 'NR', 675: 'PG', 676: 'TO',
  677: 'SB', 678: 'VU', 679: 'FJ', 680: 'PW', 681: 'WF', 682: 'CK',
  683: 'NU', 685: 'WS', 686: 'KI', 687: 'NC', 688: 'TV', 689: 'PF',
  690: 'TK', 691: 'FM', 692: 'MH',
  850: 'KP', 852: 'HK', 853: 'MO', 855: 'KH', 856: 'LA',
  880: 'BD', 886: 'TW',
  960: 'MV', 961: 'LB', 962: 'JO', 963: 'SY', 964: 'IQ', 965: 'KW',
  966: 'SA', 967: 'YE', 968: 'OM', 970: 'PS', 971: 'AE', 972: 'IL',
  973: 'BH', 974: 'QA', 975: 'BT', 976: 'MN', 977: 'NP',
  992: 'TJ', 993: 'TM', 994: 'AZ', 995: 'GE', 996: 'KG', 998: 'UZ',
};

// Sorted longest first so +358 never loses to +35 (which is not a code) and
// +1 876 never loses to +1 8.
const CODE_ENTRIES = Object.keys(CALLING_CODES)
  .map(Number)
  .sort((a, b) => String(b).length - String(a).length);

// NANP area codes assigned to Canada (CRTC Canadian Numbering Administrator).
const CANADIAN_AREA_CODES = new Set([
  204, 226, 236, 249, 250, 263, 289, 306, 343, 354, 365, 367, 368, 382,
  387, 403, 416, 418, 428, 431, 437, 438, 450, 468, 474, 506, 514, 519,
  548, 557, 579, 581, 584, 587, 604, 613, 639, 647, 672, 683, 705, 709,
  742, 753, 778, 780, 782, 807, 819, 825, 867, 873, 879, 902, 905,
]);

// NANP area codes that are a Caribbean or Pacific territory rather than the
// US mainland. Anything else on +1 is the US.
const NANP_TERRITORIES = new Map([
  [268, 'AG'], [264, 'AI'], [684, 'AS'], [246, 'BB'], [441, 'BM'],
  [242, 'BS'], [767, 'DM'], [809, 'DO'], [829, 'DO'], [849, 'DO'],
  [473, 'GD'], [671, 'GU'], [876, 'JM'], [658, 'JM'], [869, 'KN'],
  [345, 'KY'], [758, 'LC'], [670, 'MP'], [664, 'MS'], [787, 'PR'],
  [939, 'PR'], [721, 'SX'], [649, 'TC'], [868, 'TT'], [784, 'VC'],
  [284, 'VG'], [340, 'VI'],
]);

/**
 * The ISO 3166 alpha-2 country an E.164 number belongs to, or null when the
 * calling code is not in the table (an unknown prefix is refused rather than
 * guessed at).
 */
function countryOf(e164) {
  if (typeof e164 !== 'string') return null;
  const digits = e164.replace(/^\+/, '');
  if (!/^[1-9][0-9]{1,14}$/.test(digits)) return null;

  if (digits.startsWith('1') && digits.length === 11) {
    const area = Number(digits.slice(1, 4));
    if (CANADIAN_AREA_CODES.has(area)) return 'CA';
    return NANP_TERRITORIES.get(area) || 'US';
  }
  // A +1 number that is not 11 digits cannot be attributed to an area code.
  if (digits.startsWith('1')) return null;

  for (const code of CODE_ENTRIES) {
    if (digits.startsWith(String(code))) return CALLING_CODES[code];
  }
  return null;
}

/** The English name an admin table shows. Falls back to the ISO code. */
function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return code || '';
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const name = names.of(code);
    return name && name !== 'Unknown Region' ? name : code;
  } catch {
    return code;
  }
}

// Countries where a numeric sender registered for the campaign is required
// before any text may go out.
const NEEDS_REGISTRATION = Object.freeze(['US', 'CA']);

// Marketing quiet hours. Times are local to the time zone named, and a send
// outside the window is refused, not queued. Public holidays are not tracked.
const QUIET_HOURS = Object.freeze({
  FR: { timeZone: 'Europe/Paris', startHour: 8, endHour: 20, noSundays: true },
  US: { timeZone: 'America/New_York', startHour: 11, endHour: 20 },
  CA: { timeZone: 'America/New_York', startHour: 11, endHour: 20 },
});

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  return {
    weekday: parts.weekday,
    // Intl renders midnight as "24" in some ICU versions with hour12:false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/**
 * Whether a marketing text may go out to this country at `now`. Countries
 * with no encoded window are allowed: their own rules are the operator's
 * responsibility, which docs/sms-brevo.md says plainly.
 */
function quietHoursAllow(country, now = new Date()) {
  const rule = QUIET_HOURS[country];
  if (!rule) return true;
  const local = zonedParts(now, rule.timeZone);
  if (rule.noSundays && local.weekday === 'Sun') return false;
  return local.hour >= rule.startHour && local.hour < rule.endHour;
}

function inQuietHours(country, now = new Date()) {
  return !quietHoursAllow(country, now);
}

module.exports = {
  countryOf,
  countryName,
  CANADIAN_AREA_CODES,
  NANP_TERRITORIES,
  NEEDS_REGISTRATION,
  QUIET_HOURS,
  quietHoursAllow,
  inQuietHours,
};
