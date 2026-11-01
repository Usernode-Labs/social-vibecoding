'use strict';

// Homeroom bot parity, P7: taps on the "confirm" card (see ./index.js).
// Placeholder until P7 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
