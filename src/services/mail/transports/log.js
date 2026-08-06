// The log transport: renders the message and writes it to the platform
// log instead of delivering it.
//
// This is not a stub — it is the transport STAGING always uses (see
// select.js: USERNODE_ENV=staging can never reach a real provider) and
// the one a developer gets by default. It deliberately prints the OTP
// code and any link, because the point is that a human testing a staging
// preview can read the log and complete the login or the survey by hand.
//
// Global Constraints #6 — never log the raw code in production — is
// upheld structurally: select.js will not hand this transport to a
// production deploy (PLATFORM_MAIL_PROVIDER=auto returns null there
// rather than falling back to logging), so the branch that prints `code`
// is unreachable when USERNODE_ENV/NODE_ENV is production unless an
// operator explicitly sets PLATFORM_MAIL_PROVIDER=log.
'use strict';

const log = require('../../logger');
const { buildMessage } = require('../templates');

const PROVIDER = 'log';

function create() {
  return {
    provider: PROVIDER,
    async send({ to, kind, ...payload }) {
      const message = buildMessage(kind || 'otp', payload);
      log.info('platform-mail', 'Mail rendered to the log (not delivered)', {
        to,
        kind,
        subject: message.subject,
        // The whole reason this transport exists: a staging tester needs
        // the code / the link to finish the flow by hand.
        code: payload.code || undefined,
        url: payload.url || undefined,
        confirmUrl: payload.confirmUrl || undefined,
      });
    },
  };
}

module.exports = { create, PROVIDER };
