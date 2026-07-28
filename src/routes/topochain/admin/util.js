// Topochain v4 admin API — small shared parsing helpers used across the
// admin/season-events.js, admin/users.js and admin/user-activities.js
// submodules (Task 11). Kept local to this admin/ folder rather than
// folded into ../helpers.js (the cross-group §4.8 contract helpers):
// `toIntId` in particular is already duplicated verbatim in public.js and
// partner.js (each group keeps its own copy per this repo's established
// pattern), so a third copy shared only within the three files this task
// adds is the smallest deviation from that precedent.
'use strict';

// Path/query/body param -> positive integer id, or null (malformed/absent).
// Same strict round-trip-through-String() contract as public.js/partner.js.
function toIntId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

// Laravel-style `boolean` rule (accepts true, false, 1, 0, '1', '0');
// anything else -> undefined so the caller can 422 on genuinely bad input.
function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

// body value -> a valid JS Date, or undefined when absent/blank, or null
// when present but unparsable (three-way so callers can tell "field not
// sent" from "field sent but garbage").
function toDate(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Strict numeric coercion (Task 12 code-review finding): plain `Number(v)`
// silently coerces non-numeric JSON values into a "valid" number —
// `Number(true) === 1`, `Number([]) === 0`, `Number(null) === 0`,
// `Number('') === 0` — so a boolean/array/null/blank-string request field
// would pass a bare `Number.isInteger(Number(v))`/`!Number.isNaN(Number(v))`
// check and get silently written as 0 or 1 instead of 422ing. This only
// accepts an actual `number` or a non-blank `string`, and returns
// `undefined` (never `NaN`, so callers can use `=== undefined` rather than
// `Number.isNaN(...)`, which itself is `false` for `undefined`) for
// anything else or anything that doesn't parse to a finite number.
function toNumber(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = {
  toIntId, toBool, toDate, toNumber,
};
