// Waitlist survey question options — ported from the original topochain
// waitlist (packages/api Season1Controller + config/countries.php) so the
// SV platform waitlist mirrors its structure and questions.
//
// Keys are what gets STORED in waitlist_signups.answers; labels are
// display-only, so wording can change without rewriting stored answers.
// One module is the source of truth for both rendering (served to the
// SPA via GET /api/public/waitlist/options) and server-side validation
// (validateStage1 / validateStage2 below), so the two can never drift.
'use strict';

const ANSWERS_VERSION = 2;

// ── Stage 1: "how did you find us?" ─────────────────────────────────────
const DISCOVERY_SOURCES = {
  x: 'On X',
  farcaster: 'On Farcaster',
  friend: "A friend or someone in a group I'm in",
  chat: 'A Discord or Telegram server',
  video: 'A podcast or video',
  reading: 'A newsletter, blog, or article',
  reddit: 'Reddit or a forum',
  search: 'Search',
  event: 'An event or meetup',
  other: 'Somewhere else',
};

// Source-specific follow-up labels for the optional detail field.
const DISCOVERY_DETAIL_LABELS = {
  x: 'Which account?',
  farcaster: 'Which cast or channel?',
  friend: "Who? We'll thank them",
  chat: 'Which server?',
  video: 'Which show or channel?',
  reading: 'Which one?',
  reddit: 'Which subreddit or forum?',
  search: 'What were you searching for?',
  event: 'Which event?',
  other: 'Where?',
};

// ── Stage 2: the group ──────────────────────────────────────────────────
const GROUP_SIZES = {
  lt10: 'Under 10',
  '10-50': '10 – 50',
  '50-250': '50 – 250',
  '250-1000': '250 – 1,000',
  gt1000: 'Over 1,000',
};

const GROUP_ROLES = {
  founder: 'I started it',
  organizer: 'I run or moderate it',
  active: "I'm one of the active people",
  member: "I'm a member",
};

const GROUP_TOOLS = {
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  groupchat: 'A group chat',
  slack: 'Slack',
  facebook: 'A Facebook group',
  spreadsheet: 'A spreadsheet somebody maintains',
  docs: 'Notion or Google Docs',
  forum: 'A forum',
  nothing: "Nothing — it's word of mouth",
};

// ── Stage 2: the loss ───────────────────────────────────────────────────
const LOSS_ANSWERS = {
  yes: 'Yes, and it still annoys me',
  mild: 'Something like that',
  no: 'Not really',
};

const LOSS_KINDS = {
  shutdown: 'Shut down for good',
  paywall: 'Put behind a paywall',
  acquired: 'Bought, then changed',
  ads: 'Filled with ads',
  rules: 'Rules changed under us',
  banned: 'I was banned or locked out',
  api: 'API closed to third parties',
  neglect: 'Left to rot',
};

// ── Stage 1: "where are you?" ───────────────────────────────────────────
// ISO-3166 alpha-2 codes grouped by the region buckets used for cohort
// geo balancing. The "*-OTHER"-style pseudo-codes (EU, LA, AF, ME, AP)
// let someone place themselves in a region without us maintaining all
// 249 codes.
const COUNTRIES = {
  'North America': {
    US: 'United States',
    CA: 'Canada',
    MX: 'Mexico',
  },
  Europe: {
    GB: 'United Kingdom',
    IE: 'Ireland',
    FR: 'France',
    DE: 'Germany',
    NL: 'Netherlands',
    BE: 'Belgium',
    ES: 'Spain',
    PT: 'Portugal',
    IT: 'Italy',
    CH: 'Switzerland',
    AT: 'Austria',
    SE: 'Sweden',
    NO: 'Norway',
    DK: 'Denmark',
    FI: 'Finland',
    PL: 'Poland',
    CZ: 'Czechia',
    RO: 'Romania',
    UA: 'Ukraine',
    GR: 'Greece',
    TR: 'Türkiye',
    EU: 'Elsewhere in Europe',
  },
  'Latin America': {
    BR: 'Brazil',
    AR: 'Argentina',
    CO: 'Colombia',
    CL: 'Chile',
    PE: 'Peru',
    VE: 'Venezuela',
    LA: 'Elsewhere in Latin America',
  },
  Africa: {
    NG: 'Nigeria',
    GH: 'Ghana',
    KE: 'Kenya',
    ZA: 'South Africa',
    EG: 'Egypt',
    MA: 'Morocco',
    DZ: 'Algeria',
    TN: 'Tunisia',
    AF: 'Elsewhere in Africa',
  },
  'Middle East': {
    AE: 'United Arab Emirates',
    SA: 'Saudi Arabia',
    IL: 'Israel',
    PK: 'Pakistan',
    ME: 'Elsewhere in the Middle East',
  },
  'Asia Pacific': {
    IN: 'India',
    ID: 'Indonesia',
    PH: 'Philippines',
    VN: 'Vietnam',
    TH: 'Thailand',
    MY: 'Malaysia',
    SG: 'Singapore',
    JP: 'Japan',
    KR: 'South Korea',
    TW: 'Taiwan',
    HK: 'Hong Kong',
    CN: 'China',
    AU: 'Australia',
    NZ: 'New Zealand',
    AP: 'Elsewhere in Asia-Pacific',
  },
};

const MAX_INVITES = 5;

// Every country code offered by the form, flattened out of the regions.
function countryCodes() {
  return Object.values(COUNTRIES).flatMap((region) => Object.keys(region));
}

// ── Validation ──────────────────────────────────────────────────────────
// Both validators return { ok: true, value } (a cleaned payload with only
// known keys) or { ok: false, error } (a user-facing message).

function str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? null : s;
}

// Stage 1: the four public-form questions (minus email, which the join
// route validates separately). Mirrors topochain: made_url and
// discovery_source required, everything else optional.
function validateStage1(body) {
  const madeUrl = str(body?.made_url, 2000);
  if (!madeUrl) return { ok: false, error: 'Please link something you have made.' };
  if (!/^https?:\/\/\S+\.\S+/i.test(madeUrl)) {
    return { ok: false, error: 'That does not look like a link — it should start with https://' };
  }

  const source = str(body?.discovery_source, 32);
  if (!source || !Object.prototype.hasOwnProperty.call(DISCOVERY_SOURCES, source)) {
    return { ok: false, error: 'Please tell us how you found us.' };
  }

  const country = str(body?.country, 2);
  if (country && !countryCodes().includes(country.toUpperCase())) {
    return { ok: false, error: 'Unknown country.' };
  }

  const madeNote = str(body?.made_note, 140);
  const detail = str(body?.discovery_detail, 255);
  const referrer = str(body?.referrer_handle, 255);
  const city = str(body?.city, 120);

  const discovery = { source };
  if (detail) discovery.detail = detail;

  const value = { made_url: madeUrl, discovery };
  if (madeNote) value.made_note = madeNote;
  if (country) value.country = country.toUpperCase();
  if (city) value.city = city;
  if (referrer) value.referrer_handle = referrer;
  return { ok: true, value };
}

// Stage 2: everything optional; unknown enum keys are rejected rather
// than silently stored. Produces the section shape stored in
// answers.group / answers.loss / answers.handles / answers.invites.
function validateStage2(body) {
  const value = {};

  const group = {};
  const groupName = str(body?.group_name, 255);
  if (groupName) group.name = groupName;
  const groupSize = str(body?.group_size, 32);
  if (groupSize) {
    if (!Object.prototype.hasOwnProperty.call(GROUP_SIZES, groupSize)) {
      return { ok: false, error: 'Unknown group size.' };
    }
    group.size = groupSize;
  }
  const groupRole = str(body?.group_role, 32);
  if (groupRole) {
    if (!Object.prototype.hasOwnProperty.call(GROUP_ROLES, groupRole)) {
      return { ok: false, error: 'Unknown group role.' };
    }
    group.role = groupRole;
  }
  if (body?.group_tools != null) {
    if (!Array.isArray(body.group_tools)) return { ok: false, error: 'group_tools must be a list.' };
    const tools = body.group_tools.map((t) => String(t));
    for (const t of tools) {
      if (!Object.prototype.hasOwnProperty.call(GROUP_TOOLS, t)) {
        return { ok: false, error: 'Unknown group tool.' };
      }
    }
    if (tools.length) group.tools = tools;
  }
  const groupNeed = str(body?.group_need, 800);
  if (groupNeed) group.need = groupNeed;
  if (Object.keys(group).length) value.group = group;

  const loss = {};
  const hadLoss = str(body?.had_loss, 16);
  if (hadLoss) {
    if (!Object.prototype.hasOwnProperty.call(LOSS_ANSWERS, hadLoss)) {
      return { ok: false, error: 'Unknown loss answer.' };
    }
    loss.had = hadLoss;
  }
  const lossProduct = str(body?.loss_product, 255);
  if (lossProduct) loss.product = lossProduct;
  if (body?.loss_kind != null) {
    if (!Array.isArray(body.loss_kind)) return { ok: false, error: 'loss_kind must be a list.' };
    const kinds = body.loss_kind.map((k) => String(k));
    for (const k of kinds) {
      if (!Object.prototype.hasOwnProperty.call(LOSS_KINDS, k)) {
        return { ok: false, error: 'Unknown loss kind.' };
      }
    }
    if (kinds.length) loss.kind = kinds;
  }
  const lossStory = str(body?.loss_story, 800);
  if (lossStory) loss.story = lossStory;
  if (Object.keys(loss).length) value.loss = loss;

  const handles = {};
  for (const key of ['farcaster', 'discord', 'telegram', 'other_handle']) {
    const v = str(body?.[key], 255);
    if (v) handles[key === 'other_handle' ? 'other' : key] = v;
  }
  if (Object.keys(handles).length) value.handles = handles;

  if (body?.invites != null) {
    if (!Array.isArray(body.invites)) return { ok: false, error: 'invites must be a list.' };
    const invites = body.invites
      .map((v) => str(v, 255))
      .filter(Boolean)
      .slice(0, MAX_INVITES);
    if (invites.length) value.invites = invites;
  }

  if (body?.admit_together != null) value.admit_together = !!body.admit_together;

  const referrer = str(body?.referrer_handle, 255);
  if (referrer) value.referrer_handle = referrer;

  return { ok: true, value };
}

// The public shape served to the SPA so the form renders from the same
// definitions the server validates against.
function publicOptions() {
  return {
    discovery_sources: DISCOVERY_SOURCES,
    discovery_detail_labels: DISCOVERY_DETAIL_LABELS,
    group_sizes: GROUP_SIZES,
    group_roles: GROUP_ROLES,
    group_tools: GROUP_TOOLS,
    loss_answers: LOSS_ANSWERS,
    loss_kinds: LOSS_KINDS,
    countries: COUNTRIES,
    max_invites: MAX_INVITES,
  };
}

module.exports = {
  ANSWERS_VERSION,
  DISCOVERY_SOURCES,
  DISCOVERY_DETAIL_LABELS,
  GROUP_SIZES,
  GROUP_ROLES,
  GROUP_TOOLS,
  LOSS_ANSWERS,
  LOSS_KINDS,
  COUNTRIES,
  MAX_INVITES,
  countryCodes,
  validateStage1,
  validateStage2,
  publicOptions,
};
