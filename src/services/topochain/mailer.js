// Topochain mobile OTP mailer (plan Global Constraints #6; SPEC §4.5
// POST /api/v4/mobile/auth/otp/request, lines 1657-1680).
//
// This platform has no real mail transport wired in today — every call
// currently falls through to the "no transport configured" branch below.
// The function shape (`sendOtpMail(config, email, code)`) is deliberately
// stable so a real transport (SES, SMTP, a third-party API, ...) can be
// dropped in later behind `config.topochainMailTransport` — an optional
// object exposing `async send({ to, code })` — without any caller
// (mobile-auth.js) changing.
//
// Never throws and never returns a value the caller must check: SPEC 1667
// makes otp/request "always 200", so a mail-delivery hiccup (or an
// intentionally unconfigured transport) must degrade to "logged, not
// delivered", never to a request failure or a leaked distinction between
// "the mail sent" and "the mail didn't".
'use strict';

const log = require('../logger');

async function sendOtpMail(config, email, code) {
  const transport = config && config.topochainMailTransport;

  if (transport) {
    try {
      await transport.send({ to: email, code });
      return;
    } catch (err) {
      log.error('topochain-mailer', 'OTP mail transport failed to send', { email, message: err.message });
      return;
    }
  }

  if (config && config.env === 'production') {
    // Global Constraints #6: NEVER log the raw code in production. An
    // unconfigured transport in prod is an operational failure — log it
    // loudly as an error so it gets noticed — but the caller still gets
    // its normal success response (no enumeration, no user-visible
    // difference between "sent" and "mailer is unconfigured").
    log.error('topochain-mailer', 'No mail transport configured — OTP code NOT delivered', { email });
    return;
  }

  // Dev/staging convenience: with no transport configured and
  // config.env !== 'production', print the code so a developer or a
  // staging tester can complete the OTP flow by hand.
  log.info('topochain-mailer', 'OTP code (no mail transport configured)', { email, code });
}

module.exports = { sendOtpMail };
