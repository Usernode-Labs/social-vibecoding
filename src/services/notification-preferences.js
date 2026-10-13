'use strict';

// Per-app notification preferences (#1374): the categories, the three
// layers (per-app row → account-wide row → default) and their reads and
// writes. The module is src/workflow/rules/notification-preferences.ts (its
// header says what this gates and why); the merge-followups machine decides
// the author's merged notification by it inside its transaction.

// A plain object, as before (a test may replace one of its functions).
module.exports = { ...require('../workflow/rules/notification-preferences.ts') };
