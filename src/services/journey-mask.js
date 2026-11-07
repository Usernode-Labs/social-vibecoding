'use strict';

// Leave me out (Settings › Privacy, services/usage-analytics.js) on Admin ›
// Journey and the connector's Journey reads: a person who chose it still
// counts in every total, but no per-person view names them.
//
// The readings are built first, with everyone, so their counts stay whole;
// this then walks what goes out. In a list, an entry that is a left-out
// person (an object whose `userId` is theirs) is dropped: a list of people
// shows only the people who may be named. A pair stays a pair, its left-out
// half a blank. Anywhere else such an object becomes a blank too
// (`{ userId: null, name: null, leftOut: true }`). A person's own page is
// refused outright (personIsLeftOut).
//
// Different from the admin's left-out list (services/journey-left-out.js):
// a test account or somebody who objected is left out of the numbers too.

const usageAnalytics = require('./usage-analytics');

// Lists whose entries keep their places: a pair is two people.
const KEEP_PLACES = new Set(['pair']);

const BLANK = Object.freeze({ userId: null, name: null, leftOut: true });

/** The ids of everyone who chose Leave me out, as a Set. Throws when unreadable. */
async function leftOutSet(pool) {
  return new Set(await usageAnalytics.leftOutIds(pool));
}

function isLeftOut(value, ids) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('userId' in value)) return false;
  const id = Number(value.userId);
  return Number.isSafeInteger(id) && ids.has(id);
}

/** Pure: `value` with every left-out person dropped from lists and blanked elsewhere. */
function maskPeople(value, ids) {
  if (!ids || !ids.size) return value;
  const walk = (v, key) => {
    if (Array.isArray(v)) {
      if (KEEP_PLACES.has(key)) return v.map((x) => (isLeftOut(x, ids) ? { ...BLANK } : walk(x, null)));
      return v.filter((x) => !isLeftOut(x, ids)).map((x) => walk(x, null));
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (isLeftOut(v, ids)) return { ...BLANK };
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null);
}

/** Whether `userId` chose Leave me out, so has no Journey page. */
function personIsLeftOut(userId, ids) {
  const id = Number(userId);
  return Number.isSafeInteger(id) && !!ids && ids.has(id);
}

const LEFT_OUT_PERSON = 'This person chose Leave me out in Settings › Privacy, so Journey counts them only in totals.';

module.exports = { LEFT_OUT_PERSON, leftOutSet, maskPeople, personIsLeftOut };
