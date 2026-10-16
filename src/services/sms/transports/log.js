// The log transport: renders the body and writes it to the platform log
// instead of delivering it.
//
// This is not a stub - it is the transport STAGING always uses (see
// select.js: USERNODE_ENV=staging can never reach a real carrier) and the one
// a developer gets by default. It deliberately prints the code and any link,
// because the point is that a human testing a staging preview can read the
// log and complete the flow by hand.
//
// Never printing a raw code in production is upheld structurally: select.js
// will not hand this transport to a production deploy (PLATFORM_SMS_PROVIDER
// =auto returns null there rather than falling back to logging), so the
// branch that prints `code` is unreachable when USERNODE_ENV/NODE_ENV is
// production unless an operator explicitly sets PLATFORM_SMS_PROVIDER=log.
'use strict';

const log = require('../../logger');
const { buildBody } = require('../templates');

const PROVIDER = 'log';

function create() {
  return {
    provider: PROVIDER,
    async send({ to, kind, ...payload }) {
      log.info('platform-sms', 'SMS rendered to the log (not delivered)', {
        to,
        kind,
        body: buildBody(kind || 'waitlist_code_sms', payload),
        // The whole reason this transport exists: a staging tester needs the
        // code to finish the flow by hand.
        code: payload.code || undefined,
        url: payload.url || undefined,
      });
    },
  };
}

module.exports = { create, PROVIDER };
