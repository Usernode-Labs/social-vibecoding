'use strict';

// Homeroom bot parity, P4: taps on the "batch" card (see ./index.js).
// Placeholder until P4 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
