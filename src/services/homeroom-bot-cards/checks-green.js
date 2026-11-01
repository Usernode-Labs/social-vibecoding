'use strict';

// Homeroom bot parity, P6: taps on the "checks-green" card (see ./index.js).
// Placeholder until P6 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
