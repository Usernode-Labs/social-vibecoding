'use strict';

// Homeroom bot parity, P8: taps on the "gallery" card (see ./index.js).
// Placeholder until P8 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
