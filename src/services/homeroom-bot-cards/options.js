'use strict';

// Homeroom bot parity, P2: taps on the "options" card (see ./index.js).
// Placeholder until P2 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
