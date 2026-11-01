'use strict';

// Homeroom bot parity, P5: taps on the "build-note" card (see ./index.js).
// Placeholder until P5 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
