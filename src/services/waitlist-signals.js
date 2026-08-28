// The countable facts about a waitlist signup.
//
// This module reports what somebody DID — confirmed their address, verified
// a social account, filled in a section, brought people in — and
// deliberately stops there. It computes no score and applies no weights.
//
// That restraint is the point. What each signal is worth decides who gets
// in first, which is an unmade product decision; baking a number in here
// would quietly make it, in the file nobody would think to look in. The
// onboarding doc promises that answering more "increases your chances",
// and honouring that promise needs a deliberate weighting, not a default
// somebody guessed while wiring up an admin column.
//
// One source of truth, so the admin screen and whatever eventually ranks
// the queue cannot disagree about what "answered the group question" means.
'use strict';

// The survey sections, mapped to the answers keys that carry them. A
// section counts only when it holds real content: a partial save can leave
// an empty object behind, and an empty object is not a signal.
//
// `where` still reads `a.city` even though the form stopped collecting it:
// rows that answered it before 27 Aug 2026 kept the key, and dropping the
// read would retroactively un-answer a section somebody did fill in.
//
// `follow` is a SELF-REPORT and is kept out of `verified` on purpose — see
// the note on `followed_claim` in waitlist-questions.js for why no network
// will confirm a follow for us. A reader that conflates the two would
// claim we checked something we did not.
const SECTIONS = [
  ['made', (a) => !!a.made_url],
  ['where', (a) => !!(a.country || a.city)],
  ['found', (a) => !!(a.discovery && a.discovery.source)],
  ['group', (a) => !!(a.group && Object.keys(a.group).length)],
  ['loss', (a) => !!(a.loss && Object.keys(a.loss).length)],
  ['handles', (a) => !!(a.handles && Object.keys(a.handles).length)],
  ['follow', (a) => !!a.followed_claim],
];

// Arrays and strings both pass a bare `typeof x === 'object'` check (well,
// arrays do), and neither is an answers blob. These rows come from a public
// endpoint and predate several versions of this schema, so nothing here may
// throw on one.
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function signalsFor(row) {
  const r = asObject(row);
  const a = asObject(r.answers);
  const verifiedMap = asObject(a.verified);

  const verified = Object.keys(verifiedMap).filter((k) => verifiedMap[k]).sort();
  const sections = SECTIONS.filter(([, has]) => has(a)).map(([name]) => name).sort();

  // COUNT(*) comes back as a string through some drivers, and as null when
  // the subquery is absent from a caller's SELECT. Neither may become NaN
  // in a rendered column.
  const invited = Number(r.invited_count);

  return {
    confirmed: !!r.confirmed_at,
    verified,
    sections,
    invited: Number.isFinite(invited) ? invited : 0,
  };
}

module.exports = { signalsFor, SECTIONS };
