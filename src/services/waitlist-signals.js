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

const { WAITLIST_QUESTIONS } = require('./waitlist-questions');

// The survey sections, DERIVED from the one question catalogue in
// waitlist-questions.js rather than restated here. A section counts only
// when it holds real content: a partial save can leave an empty object
// behind, and an empty object is not a signal — the catalogue's
// `answered` predicates are where that judgement lives.
//
// This used to be its own list of seven `[name, predicate]` pairs, which
// meant the admin screen's "N of M answered" and anything else counting
// the same survey were two definitions that merely happened to agree. The
// CSV export needs the same count and the question wording alongside it,
// so the pairs moved to the catalogue and this reads them. The shape here
// is unchanged, and so is the restraint above: the catalogue carries no
// weights either.
//
// `where` still reads `a.city` even though the form stopped collecting it
// (see the note on that question in waitlist-questions.js), and `follow`
// is a SELF-REPORT kept out of `verified` on purpose — no network will
// confirm a follow for us, and a reader that conflates the two would
// claim we checked something we did not.
const SECTIONS = WAITLIST_QUESTIONS.map((q) => [q.key, q.answered]);

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
    // How many sections there ARE to answer, alongside how many were.
    // The admin screen used to hardcode the denominator and had drifted a
    // section behind this list, so it reported "6/6 answered" for a row
    // that had answered six of seven. The count travels with the facts now
    // rather than being restated by whoever renders them.
    //
    // Named `sections_total` and not `total` on purpose: `total` reads like
    // the tally this module refuses to compute.
    sections_total: SECTIONS.length,
    invited: Number.isFinite(invited) ? invited : 0,
  };
}

module.exports = { signalsFor, SECTIONS };
