// Re-export shim. The platform mailer moved to src/services/mail/ when it
// grew a second provider, a delivery log and an outbound throttle — see
// src/services/mail/index.js for the contract (never throws, never
// returns a value the caller must check) and src/services/mail/select.js
// for how a transport is chosen.
//
// The senders keep their exact signatures, so every existing caller
// (src/services/email-signup.js, src/routes/public-api.js,
// src/routes/topochain/admin/waitlist.js) is unchanged. This path stays so
// those requires — and the tests that pin them — keep resolving.
'use strict';

const mail = require('../mail');

module.exports = {
  sendOtpMail: mail.sendOtpMail,
  sendWaitlistJoinMail: mail.sendWaitlistJoinMail,
  sendWaitlistCodeMail: mail.sendWaitlistCodeMail,
  sendWaitlistReleaseMail: mail.sendWaitlistReleaseMail,
};
