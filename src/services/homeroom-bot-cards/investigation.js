'use strict';

// Homeroom bot parity, P9: taps on the "investigation" card (see ./index.js).
// Placeholder until P9 is built: every tap is refused.

module.exports = {
  decide: async () => ({ ok: false, status: 404, error: 'No such card' }),
};
