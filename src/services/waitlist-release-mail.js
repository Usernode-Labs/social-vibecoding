'use strict';

/**
 * The "you're in" notice for a waitlist row an admit just released: the
 * email, or a phone row's text. One place, so an Admit by hand, the batch
 * tool, a direct access grant (routes/topochain/admin/waitlist.js) and
 * "Let them all in" (services/waitlist-open.js) send the same thing under
 * the same switch.
 *
 * First release only: a caller sends it for a row whose release was new.
 * Degrades silently when no mail transport is configured.
 */

const log = require('./logger');
const waitlist = require('./waitlist');
const releaseMailSetting = require('./release-mail-setting');
const releaseLinks = require('./release-links');
const { sendWaitlistReleaseMail } = require('./topochain/mailer');
const { loadMobileAppUrls } = require('./mobile-store-links');

/**
 * Send the notice for `released` (a releaseWaitlistSignup or
 * releaseRowsForGrant row). `mobile` is the store-listing lookup, done once
 * by the caller so a batch does not repeat it per row.
 */
async function sendReleaseMail(config, pool, released, mobile) {
  // A phone row has no address: its "you're in" goes by text, the SMS hook
  // (#4096, services/waitlist.js sendReleaseText).
  if (!released.email) {
    await waitlist.sendReleaseText(pool, released);
    return;
  }
  // #5971: an admin can switch the email off; the release itself stands.
  if (!(await releaseMailSetting.releaseMailEnabled(pool))) {
    log.info('topochain-admin', 'Release email switched off; not sent', { signupId: released.id });
    return;
  }
  const hasAccount = released.linked_user_id != null;
  // #4594: a new account's one-time sign-in link. A failure to mint drops
  // the link, not the mail: the mail's link still prefills the address
  // and sends a code, as it did before.
  let link = null;
  if (!hasAccount) {
    try {
      link = await releaseLinks.mintLink(pool, { signupId: released.id, email: released.email });
    } catch (err) {
      log.error('topochain-admin', 'release sign-in link not minted', { signupId: released.id, message: err.message });
    }
  }
  await sendWaitlistReleaseMail(config, released.email, {
    mobile,
    hasAccount,
    signInToken: link ? link.token : null,
    // When the link stops working, for the line above the button.
    signInExpiresAt: link ? link.expiresAt : null,
    // #1548: lets the signup screen prefill the address and send the
    // code without a second step. An unguessable capability already
    // delivered to this address, so it carries nothing the recipient
    // does not already hold — and unlike the address itself it is safe
    // in a query string, which is what survives a link rewriter.
    moreToken: released.more_token || null,
    // The account's language. An address with no account yet has none: the
    // admin's browser says nothing about the person being let in.
    ...(released.recipient_locale ? { locale: released.recipient_locale } : {}),
  });
}

// The mail's mobile steps link the published store listings; a failed
// lookup drops those steps rather than the mail or the release.
function loadReleaseMailMobile(pool) {
  return loadMobileAppUrls(pool).catch((err) => {
    log.error('topochain-admin', 'release mail mobile links failed', { message: err.message });
    return null;
  });
}

module.exports = { sendReleaseMail, loadReleaseMailMobile };
