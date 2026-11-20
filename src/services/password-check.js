// Checking a typed password at sign-in (#6717).
//
// A phone keyboard often adds a space after the last word, and a pasted
// password can carry one at either end. Sign-in then answered "Invalid
// credentials" for a password typed correctly.
//
// The typed value is NOT trimmed outright: a password is stored exactly as
// it was set, so one that really starts or ends with white space must keep
// working. The rule is: try it as typed; only when that fails, and the typed
// value has white space at an end, try it once more without that white
// space. Nothing that matched before stops matching.
//
// Both tries happen inside one request, so the sign-in limiters
// (middleware/rate-limits.js) count them as one attempt, and a refused
// request costs at most one extra bcrypt compare per account tried.
// Setting or changing a password is not touched.

const bcrypt = require('bcrypt');

// The typed value without its leading and trailing white space, or null when
// there is nothing to try: it is not a string, it has none, or nothing is
// left once it is removed.
function withoutOuterSpace(typed) {
  if (typeof typed !== 'string') return null;
  const trimmed = typed.trim();
  return trimmed && trimmed !== typed ? trimmed : null;
}

// One stored hash: as typed first, then once without the outer white space.
async function matches(typed, hash) {
  if (await bcrypt.compare(typed, hash)) return true;
  const trimmed = withoutOuterSpace(typed);
  return trimmed ? bcrypt.compare(trimmed, hash) : false;
}

module.exports = { withoutOuterSpace, matches };
