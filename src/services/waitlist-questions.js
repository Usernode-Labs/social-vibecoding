// Waitlist survey question options — ported from the original topochain
// waitlist (packages/api Season1Controller + config/countries.php) so the
// SV platform waitlist mirrors its structure and questions.
//
// Keys are what gets STORED in waitlist_signups.answers; labels are
// display-only, so wording can change without rewriting stored answers.
// One module is the source of truth for both rendering (served to the
// SPA via GET /api/public/waitlist/options) and server-side validation
// (validateStage1 / validateStage2 below), so the two can never drift.
//
// The country list is the one option set that does NOT live here: it is the
// complete ISO 3166-1 table in src/services/countries.js, flat and sorted by
// English name. It used to be ~50 codes nested under six region headings
// with an "Elsewhere in <region>" pseudo-code closing five of them; see that
// module's header for why the buckets and the pseudo-codes went.
'use strict';

const { ISO_COUNTRIES, countryLabel } = require('./countries');

const ANSWERS_VERSION = 3;

// ── Stage 1: "how did you find us?" ─────────────────────────────────────
// The eight options Andrea settled on (doc comment, 27 Aug 2026). The list
// used to run to ten and carry a free-text follow-up ("Which account?",
// "Which subreddit?"); both are gone. The follow-up asked people to type a
// second answer to a question they had already answered with a tap, and
// nothing read it back.
//
// Five keys survive the change unaltered (`x`, `friend`, `reddit`, `event`,
// `other`) and five are retired (`farcaster`, `chat`, `video`, `reading`,
// `search`). Retired keys are NOT remapped: rows that stored one keep it,
// the admin screen renders the stored key directly, and inventing a
// migration would rewrite what somebody actually answered.
const DISCOVERY_SOURCES = {
  x: 'X',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  reddit: 'Reddit or a forum',
  friend: 'Friend or colleague',
  podcast: 'Podcast',
  event: 'Event',
  other: 'Other',
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
  nothing: "Nothing, it's word of mouth",
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
// The complete ISO 3166-1 list, flat and sorted by English name, from
// src/services/countries.js. It used to be ~50 codes in six region buckets
// with an "Elsewhere in <region>" pseudo-code closing five of them, which
// two reports faulted for the same shape (GitHub issue #1527 and feedback
// triage item #18): the buckets left ~200 countries unselectable, Uruguay
// among them, and put the ones that were there where an alphabetical scan
// does not look.
//
// The five pseudo-codes (EU, LA, AF, ME, AP) are RETIRED, not remapped, in
// the same spirit as the retired discovery sources above: rows that stored
// one keep it, migrated to a namespaced `X-*` form so it can never be read
// as the real ISO code that shares those letters (LA is Laos, AF is
// Afghanistan, ME is Montenegro). They are display-only from here on:
// countries.js labels them for the admin screen, this module never offers
// or accepts them, and the 2-character cap in validateStage1 makes the
// namespaced values structurally unsubmittable.
//
// Nothing computed a region from a country: countryCodes() was the only
// consumer of the nesting, and the geo balancing the form's help text
// mentions is people reading the admin screen. So dropping the grouping
// loses no behaviour.
const COUNTRIES = ISO_COUNTRIES;

// Every country code offered by the form.
function countryCodes() {
  return Object.keys(ISO_COUNTRIES);
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

// Match any explicit URI scheme, not just HTTP. An unsupported scheme should
// keep flowing to the validator below and be rejected; only a genuinely bare
// domain gets the helpful HTTPS default.
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function normalizeMadeUrl(value) {
  const madeUrl = str(value, 2000);
  if (!madeUrl || URI_SCHEME.test(madeUrl)) return madeUrl;
  return `https://${madeUrl}`;
}

// Stage 1: email plus a couple of optional context questions. NOTHING
// here is required — the doc's "Simpler waitlist flow proposal" settled
// on an email-only join, and Andrea and Evan agreed it in its comments
// ("Just an email!"), so a bare POST carrying only an address is a valid
// signup and yields an empty answers object.
//
// "Link something you've made" used to be required here. It moved to
// stage 2, where it is one of the things that helps you move up rather
// than a gate on joining at all.
//
// Two questions were dropped outright (doc comment, 27 Aug 2026): the
// free-text city beside the country select, and "did someone refer
// you?". Country stays because cohorts are balanced across regions;
// city was never read by anything.
//
// Unknown enum values are still rejected rather than stored: optional
// means "may be absent", never "may be anything".
function validateStage1(body) {
  const country = str(body?.country, 2);
  if (country && !countryCodes().includes(country.toUpperCase())) {
    return { ok: false, error: 'Unknown country.' };
  }

  const source = str(body?.discovery_source, 32);
  if (source && !Object.prototype.hasOwnProperty.call(DISCOVERY_SOURCES, source)) {
    return { ok: false, error: 'Unknown discovery source.' };
  }

  // `discovery_detail`, `city` and `referrer_handle` are deliberately NOT
  // read any more. A stale client still sending one gets a normal signup
  // with the key dropped, which is the same contract the retired stage-2
  // `invites` array got.
  //
  // The referral question went for a reason rather than for brevity: a
  // typed handle is a claim nobody can resolve, and the invite link on the
  // stage-2 form already attributes the same relationship through
  // `invite_code` / `invited_by`, where it is a row reference instead of a
  // string.
  const value = {};
  if (source) value.discovery = { source };
  if (country) value.country = country.toUpperCase();
  return { ok: true, value };
}

// Stage 2: everything optional; unknown enum keys are rejected rather
// than silently stored. Produces the section shape stored in
// answers.made_url / answers.group / answers.loss / answers.handles.
// Who invited whom is NOT in here — it lives in the invite_code /
// invited_by columns, because it is a relationship between rows rather
// than an answer somebody typed.
function validateStage2(body) {
  const value = {};

  // Moved here from stage 1: "link something you've made" is one of the
  // things that helps you move up, not a gate on joining.
  const madeUrl = normalizeMadeUrl(body?.made_url);
  if (madeUrl) {
    if (!/^https?:\/\/\S+\.\S+/i.test(madeUrl)) {
      return { ok: false, error: 'That does not look like a link. It should start with https://' };
    }
    value.made_url = madeUrl;
    const madeNote = str(body?.made_note, 140);
    if (madeNote) value.made_note = madeNote;
  }

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

  // `invites` (five typed addresses) was retired for the share link:
  // it sent nothing, attributed nothing and was never read back, so the
  // key is deliberately dropped rather than validated. A stale client
  // still sending it gets a normal save with the key ignored.
  //
  // `admit_together` ("only let me in when at least one person from my
  // link gets in too") is retired the same way: no admission path ever
  // read it, so the promise it made was never kept. Same contract as
  // `invites` -- dropped on input, never rejected, and rows that already
  // carry it keep it.

  // "Follow along" (doc comment, 27 Aug 2026). This is a CLAIM, not a
  // verification, and the name says so wherever it is read.
  //
  // None of the three networks will confirm a follow for us. LinkedIn's
  // Follower Statistics returns aggregate counts and never an identity;
  // Instagram's Graph API exposes `followers_count` and no relationship
  // lookup at any tier; X retired the v1.1 `friendships/show` boolean and
  // its v2 replacement means paginating a member's entire following list
  // under metered per-resource pricing. So the honest thing to store is
  // that somebody said they did it, kept separate from `answers.verified`,
  // which OAuth actually proves.
  if (body?.followed_claim != null) value.followed_claim = !!body.followed_claim;

  return { ok: true, value };
}

// ── The question catalogue ──────────────────────────────────────────────
// The seven survey questions as a reader encounters them: the wording the
// form asked, whether a given answers blob answered it, and that answer
// rendered as one line of prose.
//
// TWO consumers, ONE list, which is the whole point of it living here.
// waitlist-signals.js derives its `SECTIONS` from `key` + `answered`, so
// the admin screen's "N of M answered" counts exactly the questions the
// CSV export writes `questions_answered` from. That denominator has
// drifted once already (see the `sections_total` note in that module);
// two lists that must agree is the shape that let it.
//
// Deliberately NOT here: any weight, score or ordering by worth. This is
// a catalogue of what was asked and what came back — see
// waitlist-signals.js's header for why ranking the queue is an unmade
// product decision rather than a default somebody guessed.
//
// `question` is the form's own copy, verbatim (tests/waitlist-questions.test.js
// pins each string against the JSX that renders it, so a reworded form
// cannot leave a stale question in an export). Sub-question labels are
// SHORT FORMS of the form's placeholders rather than verbatim: several run
// to a sentence and a list of examples, which is fine under an input and
// wrong inside a spreadsheet cell.

// Sub-answers within one answer, and picks within one multi-select. Both
// are chosen to survive a CSV round-trip without needing a quote: neither
// is a comma, a quote or a newline, so `csvField` leaves a composed cell
// alone unless the person's own free text needs the quoting.
const ANSWER_SEPARATOR = ' · ';
const MULTI_SEPARATOR = ' / ';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// A stored CODE as the sentence it stands for, falling back to the code
// itself. The fallback is deliberate and matches the admin screen's:
// retired option keys are never remapped, so a row holding `farcaster`
// or `search` from an older survey must still say something.
function labelFor(map, code) {
  if (!code) return '';
  const key = String(code);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key;
}

function labelList(map, codes) {
  if (!Array.isArray(codes)) return '';
  return codes.map((c) => labelFor(map, c)).filter(Boolean).join(MULTI_SEPARATOR);
}

// A labelled follow-up, or nothing at all when it was not answered. An
// empty follow-up must not leave a dangling "Label:" in the cell.
function sub(label, value) {
  const text = value == null ? '' : String(value).trim();
  return text ? `${label}: ${text}` : '';
}

// The parts of one answer as a single line. The part that answers the
// top-level question is passed unlabelled and leads; follow-ups carry
// their own label.
function joinParts(parts) {
  return parts.filter(Boolean).join(ANSWER_SEPARATOR);
}

const WAITLIST_QUESTIONS = [
  {
    key: 'made',
    question: "Link something you've made",
    answered: (a) => !!a.made_url,
    answer: (a) => joinParts([a.made_url, sub('What is it, in one line?', a.made_note)]),
  },
  {
    // `city` is still read even though the form stopped collecting it:
    // rows that answered before 27 Aug 2026 kept the key, and dropping
    // the read would retroactively un-answer a section somebody filled in.
    key: 'where',
    question: 'Country',
    answered: (a) => !!(a.country || a.city),
    answer: (a) => joinParts([countryLabel(a.country), sub('City', a.city)]),
  },
  {
    key: 'found',
    question: 'How did you find us?',
    answered: (a) => !!asObject(a.discovery).source,
    answer: (a) => {
      const d = asObject(a.discovery);
      return joinParts([
        labelFor(DISCOVERY_SOURCES, d.source),
        // The free-text follow-up is retired, but rows that answered it
        // keep it. Its label was per-source ("Which account?", "Which
        // subreddit?"), so the export uses a neutral one.
        sub('More detail', d.detail),
      ]);
    },
  },
  {
    key: 'group',
    question: "Tell us about a group you're part of that could use its own app.",
    answered: (a) => !!Object.keys(asObject(a.group)).length,
    answer: (a) => {
      const g = asObject(a.group);
      return joinParts([
        g.name,
        sub('Roughly how many people?', labelFor(GROUP_SIZES, g.size)),
        sub('Your role in it', labelFor(GROUP_ROLES, g.role)),
        sub('What does it run on today?', labelList(GROUP_TOOLS, g.tools)),
        sub("What would its own app do that those tools can't?", g.need),
      ]);
    },
  },
  {
    key: 'loss',
    question: 'Ever had a tool you relied on get killed, paywalled, or ruined?',
    answered: (a) => !!Object.keys(asObject(a.loss)).length,
    answer: (a) => {
      const l = asObject(a.loss);
      return joinParts([
        labelFor(LOSS_ANSWERS, l.had),
        sub('Which one?', l.product),
        sub('What happened?', labelList(LOSS_KINDS, l.kind)),
        sub('Then what?', l.story),
      ]);
    },
  },
  {
    // No single part answers this one, so every network is labelled.
    key: 'handles',
    question: 'Where else are you?',
    answered: (a) => !!Object.keys(asObject(a.handles)).length,
    answer: (a) => {
      const h = asObject(a.handles);
      return joinParts([
        sub('Farcaster', h.farcaster),
        sub('Discord', h.discord),
        sub('Telegram', h.telegram),
        sub('Anywhere else', h.other),
      ]);
    },
  },
  {
    // A CLAIM, not a verification — the name says so everywhere it is
    // read, and the question text carries the caveat into the export so a
    // column of "Yes" cannot be mistaken for something we checked. See
    // the `followed_claim` note in validateStage2 for why no network will
    // confirm a follow for us.
    key: 'follow',
    question: 'I followed along (self-reported, not verified)',
    answered: (a) => !!a.followed_claim,
    answer: (a) => (a.followed_claim ? 'Yes' : ''),
  },
];

// Keys the catalogue above accounts for. Anything else in an answers blob
// is shown verbatim rather than dropped: the blob spans several schema
// versions, and a reader is entitled to see what is actually stored.
// `_version` is bookkeeping; `verified` is OAuth proof, which the export
// carries in its own handle columns. Mirrors KNOWN_ANSWER_KEYS on the
// admin screen, which does the same thing for the same reason.
const CATALOGUED_ANSWER_KEYS = new Set([
  '_version', 'made_url', 'made_note', 'country', 'city', 'discovery',
  'referrer_handle', 'group', 'loss', 'verified', 'handles', 'followed_claim',
  'invites',
]);

// How many of the seven a blob answered. Identical by construction to
// `signalsFor(row).sections.length`, which reads the same predicates.
function answeredCount(answers) {
  const a = asObject(answers);
  return WAITLIST_QUESTIONS.filter((q) => q.answered(a)).length;
}

// Every catalogued question against one blob: `{ key, question, answer }`,
// in file order, with an empty `answer` where the question went
// unanswered. A caller gets all seven for every row so a column means the
// same thing down the whole file.
function answerLines(answers) {
  const a = asObject(answers);
  return WAITLIST_QUESTIONS.map((q) => ({
    key: q.key,
    question: q.question,
    answer: q.answered(a) ? q.answer(a) : '',
  }));
}

// Whatever the catalogue does not cover, as one line. Objects are
// JSON-stringified so a nested blob from a retired schema version is at
// least readable.
function otherAnswers(answers) {
  const a = asObject(answers);
  return Object.keys(a)
    .filter((k) => !CATALOGUED_ANSWER_KEYS.has(k))
    .sort()
    .map((k) => {
      const v = a[k];
      let text;
      if (v == null) text = '';
      else if (typeof v === 'object') {
        try { text = JSON.stringify(v); } catch { text = String(v); }
      } else text = String(v);
      return `${k}: ${text}`;
    })
    .join(ANSWER_SEPARATOR);
}

// The public shape served to the SPA so the form renders from the same
// definitions the server validates against.
function publicOptions() {
  return {
    discovery_sources: DISCOVERY_SOURCES,
    group_sizes: GROUP_SIZES,
    group_roles: GROUP_ROLES,
    group_tools: GROUP_TOOLS,
    loss_answers: LOSS_ANSWERS,
    loss_kinds: LOSS_KINDS,
    countries: COUNTRIES,
  };
}

module.exports = {
  ANSWERS_VERSION,
  DISCOVERY_SOURCES,
  GROUP_SIZES,
  GROUP_ROLES,
  GROUP_TOOLS,
  LOSS_ANSWERS,
  LOSS_KINDS,
  COUNTRIES,
  countryCodes,
  WAITLIST_QUESTIONS,
  CATALOGUED_ANSWER_KEYS,
  ANSWER_SEPARATOR,
  MULTI_SEPARATOR,
  answeredCount,
  answerLines,
  otherAnswers,
  normalizeMadeUrl,
  validateStage1,
  validateStage2,
  publicOptions,
};
