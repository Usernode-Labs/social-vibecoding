// Re-export shim. This file used to BE the platform's one mail transport;
// it now points at src/services/mail/, where that transport lives as
// transports/http-api.js alongside a Gmail transport and a log transport.
//
// `create` and `describe` keep the ORIGINAL, HTTP-provider-specific
// meaning — "is TOPOCHAIN_MAIL_* set" — so nothing that required this
// path changes behaviour. The provider-aware selection and the
// provider-aware admin summary are src/services/mail/select.js's
// chooseTransport() and describe(), which is what config.js and the admin
// mail-status route use now.
'use strict';

const httpApi = require('../mail/transports/http-api');
const { buildMessage } = require('../mail/templates');

module.exports = {
  create: httpApi.create,
  describe: httpApi.describe,
  buildMessage,
  SEND_TIMEOUT_MS: httpApi.SEND_TIMEOUT_MS,
};
