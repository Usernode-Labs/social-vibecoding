'use strict';

// A tap under one of the Homeroom bot's DM offers is decided in the person's
// DM machine and done by its work (src/workflow/bot-dm/, dm.act →
// homeroom-bot-mayor.js actOnTap). Suites that test what a tap does, with no
// workflow runtime of their own, pass this as decideOfferTap's
// `deps.replies`: it does the act at once, keyed as the machine keys it.

function tapsNow(pool, config = {}, deps = {}) {
  return {
    async tapDmAction(a) {
      const mayor = require('../../src/services/homeroom-bot-mayor');
      await mayor.actOnTap(pool, config, { ...a, key: `action:${a.actionId}`, deps });
      return { ok: true };
    },
  };
}

module.exports = { tapsNow };
