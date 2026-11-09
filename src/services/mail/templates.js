'use strict';

// The message for every kind of platform mail. Its words are never here: they
// are the stored templates admins write and translate in the admin console
// (./template-store, tables in src/db/migrations/email-templates.sql), and
// ./render.js fills them with the action's values (./actions.js). Nothing here
// knows about a provider: transports/ takes { subject, text, html, headers }
// and encodes them however their API wants.
//
// `kind` is the discriminator every caller passes (see index.js). An unknown
// kind is a programming error, so it throws rather than sending a blank email.
// index.js swallows that (it must never make an always-200 endpoint fail) and
// logs it.

const tracking = require('./tracking');
const { ACTIONS, actionFor } = require('./actions');
const { renderResolved } = require('./render');
const { plainMessage } = require('./plain-message');

function noTemplate(kind, reason) {
  const err = new Error(`No email template to send ${kind} with: ${reason}`);
  err.code = 'no_template';
  return err;
}

// With no stored templates in hand at all (a process with no database: a test,
// a script, a transport called on its own), the first templates in memory, in
// English, as a fresh database would hold them (template-store seededSnapshot).
// They are data, not words written here.
function seededParts(kind) {
  const store = require('./template-store');
  return store.resolve(store.seededSnapshot(), kind, null);
}

/**
 * The message for `kind`: from the stored template `payload.resolved` names
 * (every real send, from send()), or the seeds when there is none in hand. With
 * no template, or one that will not render, the owner's failure order applies:
 * a plain message that says why in `plainBecause`, for send() to log; a mail
 * that cannot go plain throws `no_template`.
 */
function buildMessage(kind, payload = {}) {
  if (!actionFor(kind)) throw new Error(`unknown mail kind: ${kind}`);
  const resolved = payload.resolved !== undefined ? payload.resolved : seededParts(kind);
  const attributed = tracking.attributedPayload(kind, payload);
  let reason = 'none could be loaded';
  if (resolved && resolved.template) {
    try {
      const { why, preheader, headers, ...message } = renderResolved(kind, resolved, attributed); // eslint-disable-line no-unused-vars
      return tracking.decorate(kind, { ...message, ...(headers ? { headers } : {}) }, payload);
    } catch (err) {
      reason = `it did not render (${err.message})`;
    }
  }
  const plain = plainMessage(kind, attributed);
  if (!plain) throw noTemplate(kind, reason);
  const { headers, ...message } = plain;
  return { ...tracking.decorate(kind, { ...message, ...(headers ? { headers } : {}) }, payload), plainBecause: reason };
}

// Every kind there is, for the admin console and for tests that want to assert
// the set didn't quietly shrink.
const KINDS = Object.keys(ACTIONS);

module.exports = { buildMessage, plainMessage, KINDS };
