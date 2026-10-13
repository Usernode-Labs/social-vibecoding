'use strict';

// A row id from a request path, or null when it is not a canonical positive
// integer that fits a SERIAL column: no sign, no leading zero, no trailing
// text, at most int4. Anything else would reach Postgres as a bad cast (a
// 500) or, through parseInt, as a different id than the one routed.
//
// Its own module so the access guards can share it: tests replace
// app-access wholesale, and communities must not lose it with them.
function positiveId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) && Number(raw) <= 2147483647 ? Number(raw) : null;
}

module.exports = { positiveId };
