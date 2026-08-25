// Message bodies for every kind of platform mail, in one place.
//
// `kind` is the discriminator every caller passes (see index.js). A
// template returns { subject, text, html } — text is the authoritative
// copy (it is what the tests assert on, and what a text-only client
// shows); html is a minimal, style-light rendering of the same words so
// the mail doesn't look broken in a modern client. Nothing here knows
// about a provider: transports/ takes these three fields and encodes
// them however their API wants.
//
// An unknown kind is a programming error, so it throws rather than
// sending a blank email. index.js swallows that (it must never make an
// always-200 endpoint fail) and logs it.
'use strict';

// Minimal HTML escaping — these bodies interpolate an email address, a
// six-digit code and platform-built URLs, never free user text, but
// escaping is cheap and keeps that true if a payload field ever grows.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HTML_SHELL = (body) =>
  '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,'
  + 'Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">'
  + body
  + '</body></html>';

const p = (s) => `<p>${s}</p>`;
const link = (url) => `<a href="${esc(url)}">${esc(url)}</a>`;

function otp(payload) {
  const code = payload.code;
  return {
    subject: 'Your Usernode login code',
    text: `Your Usernode login code is ${code}.\n\n`
      + 'It expires in 10 minutes. If you did not request it, you can ignore this email.',
    html: HTML_SHELL(
      p('Your Usernode login code is:')
      + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p>`
      + p('It expires in 10 minutes. If you did not request it, you can ignore this email.')
    ),
  };
}

// Waitlist join confirmation. Two optional links, independent of each
// other:
//   - payload.confirmUrl — the one-click "confirm this address" link.
//     Following it stamps waitlist_signups.confirmed_at and lands on the
//     stage-2 survey, so confirming and answering are one motion.
//   - payload.url — the durable stage-2 survey link (#more/<token>). The
//     join response shows it once; the email is its lasting home.
// Either may be absent (an idempotent re-join carries neither), and the
// copy must not grow an empty paragraph or the string "undefined" when
// that happens.
function waitlistJoined(payload) {
  const confirmUrl = payload.confirmUrl || null;
  const surveyUrl = payload.url || null;

  let text = 'Thanks for joining the Usernode waitlist.\n\n'
    + "We'll email you at this address as soon as your access is ready.";
  let html = p('Thanks for joining the Usernode waitlist.')
    + p("We'll email you at this address as soon as your access is ready.");

  if (confirmUrl) {
    text += '\n\nConfirm this email address so we can reach you when it opens up:\n'
      + confirmUrl;
    html += p('Confirm this email address so we can reach you when it opens up:')
      + p(link(confirmUrl));
  }
  if (surveyUrl) {
    text += '\n\nWant in sooner? A few optional questions move you up the list. '
      + `Answer (or add to) them any time here: ${surveyUrl}`;
    html += p('Want in sooner? A few optional questions move you up the list. '
      + `Answer (or add to) them any time here: ${link(surveyUrl)}`);
  }

  return { subject: "You're on the Usernode waitlist", text, html };
}

function waitlistReleased(payload) {
  const url = payload.url;
  const text = payload.hasAccount
    ? "Good news: you're off the Usernode waitlist and your account now has platform access.\n\n"
      + `Sign in to get started: ${url}`
    : "Good news: you're off the Usernode waitlist.\n\n"
      + `Create your account with this email address to get started: ${url}`;
  return {
    subject: 'Your Usernode access is ready',
    text,
    html: HTML_SHELL(
      p(payload.hasAccount
        ? "Good news: you're off the Usernode waitlist and your account now has platform access."
        : "Good news: you're off the Usernode waitlist.")
      + p(payload.hasAccount
        ? `Sign in to get started: ${link(url)}`
        : `Create your account with this email address to get started: ${link(url)}`)
    ),
  };
}

// Password-reset magic link (#login → "Forgot password"). Carries the
// tokenized link and nothing else the recipient could be phished with —
// no username, no code to read back to anyone. The 30-minute figure must
// match RESET_TOKEN_TTL_MS in src/routes/auth.js.
function passwordReset(payload) {
  const url = payload.url;
  return {
    subject: 'Reset your Usernode password',
    text: 'Someone asked to reset the password for the Usernode account with this '
      + 'email address.\n\n'
      + `Set a new password here: ${url}\n\n`
      + 'The link expires in 30 minutes and works once. If you did not request '
      + 'this, you can ignore this email. Your password is unchanged.',
    html: HTML_SHELL(
      p('Someone asked to reset the password for the Usernode account with this '
        + 'email address.')
      + p(`Set a new password here: ${link(url)}`)
      + p('The link expires in 30 minutes and works once. If you did not request '
        + 'this, you can ignore this email. Your password is unchanged.')
    ),
  };
}

// The admin console's "send a test email" message.
//
// Deliberately carries NOTHING sensitive: no code, no token, no link a
// recipient could act on. Its whole job is to be identifiable in an
// inbox and traceable back to the attempt that produced it, so it names
// the provider, the sender, the timestamp and the short reference id
// that the console's activity table also shows.
function adminTest(payload) {
  const provider = payload.provider || 'unknown';
  const from = payload.from || '(unset)';
  const sentAt = payload.sentAt || '';
  const reference = payload.reference || '(none)';

  const text = 'This is a test email from the Usernode platform admin console.\n\n'
    + `Provider: ${provider}\n`
    + `Sent as: ${from}\n`
    + `Sent at: ${sentAt}\n`
    + `Reference: ${reference}\n\n`
    + 'An administrator sent it to check that outbound email works. '
    + 'No action is needed.';

  return {
    subject: 'Usernode test email',
    text,
    html: HTML_SHELL(
      p('This is a test email from the Usernode platform admin console.')
      + `<p>Provider: <strong>${esc(provider)}</strong><br>`
      + `Sent as: ${esc(from)}<br>`
      + `Sent at: ${esc(sentAt)}<br>`
      + `Reference: <code>${esc(reference)}</code></p>`
      + p('An administrator sent it to check that outbound email works. '
        + 'No action is needed.')
    ),
  };
}

function buildMessage(kind, payload = {}) {
  switch (kind) {
    case 'otp':
      return otp(payload);
    case 'admin_test':
      return adminTest(payload);
    case 'waitlist_joined': {
      const m = waitlistJoined(payload);
      return { ...m, html: HTML_SHELL(m.html) };
    }
    case 'waitlist_released':
      return waitlistReleased(payload);
    case 'password_reset':
      return passwordReset(payload);
    default:
      throw new Error(`unknown mail kind: ${kind}`);
  }
}

// Every kind this module can render, for the admin console and for tests
// that want to assert the set didn't quietly shrink.
const KINDS = ['otp', 'waitlist_joined', 'waitlist_released', 'password_reset', 'admin_test'];

module.exports = { buildMessage, KINDS };
