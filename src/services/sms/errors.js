'use strict';

/**
 * One refusal type for everything the SMS layer decides before or around
 * the provider's own answer. `code` is this API's word for it (the admin
 * screen and the sign-in sheet switch on it), `providerCode` is Brevo's or
 * Twilio's own code when a send came back with one, and `status` is the HTTP status a caller should
 * use where it has a route of its own.
 */
class SmsError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'SmsError';
    this.code = code;
    this.status = status;
    this.providerCode = null;
  }
}

module.exports = { SmsError };
