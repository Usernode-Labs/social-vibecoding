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

/**
 * The ONE branded frame every send goes through (#1555).
 *
 * The report was that the mails do not look like one another. They did not:
 * the shell was a bare `<body>` with a font stack, three templates wrapped
 * themselves in it, one was wrapped by `buildMessage`, and the result had no
 * sender identity anywhere except inside the sentences.
 *
 * ── Why a wordmark and not a logo image ────────────────────────────────
 *
 * A remote `<img>` in an email is a tracking pixel as far as every mail
 * client is concerned: Gmail and Outlook block it until the reader asks,
 * Apple Mail proxies it, and the mail's identity would be the one thing that
 * arrives broken. An inline data: URI is worse — several clients strip them,
 * and the ones that do not count the bytes against the clipping threshold.
 * Type always renders. The wordmark is the product's own name in the
 * platform's accent, which is what the header, the landing page and the
 * manifest already put there.
 *
 * ── Table-free, and deliberately ───────────────────────────────────────
 *
 * The layout is one centred block with a max width. There is no grid to hold
 * together, so the usual `<table>` scaffolding buys nothing here and costs
 * every future editor a nested-markup puzzle. Inline styles only: `<style>`
 * blocks and classes are stripped by Gmail's clipper and by Outlook.
 *
 * ── The footer says what this IS and why it arrived ────────────────────
 *
 * Claiming anything more would be a promise the platform does not keep: there
 * is no preference centre and no unsubscribe route for transactional mail, so
 * the footer does not offer one. It names the product, and it says these are
 * account mails rather than marketing — which is the honest answer to "why am
 * I getting this".
 */
const BRAND_NAME = 'Usernode';
const BRAND_ACCENT = '#1f86ff';
const BODY_STYLE =
  'margin:0;padding:24px 12px;background:#f4f4f5;font-family:-apple-system,'
  + 'Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;'
  + 'line-height:1.55;color:#111';
const CARD_STYLE =
  'max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;'
  + 'padding:28px 24px';
const WORDMARK_STYLE =
  `margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:-0.2px;color:${BRAND_ACCENT}`;
const FOOTER_STYLE =
  'margin:24px 0 0;padding-top:16px;border-top:1px solid #e4e4e7;'
  + 'font-size:12px;line-height:1.5;color:#71717a';

const HTML_SHELL = (body) =>
  '<!doctype html><html><body style="' + BODY_STYLE + '">'
  + '<div style="' + CARD_STYLE + '">'
  + '<div style="' + WORDMARK_STYLE + '">' + BRAND_NAME + '</div>'
  + body
  + '<div style="' + FOOTER_STYLE + '">'
  + BRAND_NAME + ' Social Vibecoding'
  + '<br>You are receiving this because of activity on your account or your '
  + 'place on the waitlist. We only send mail you asked for.'
  + '</div>'
  + '</div>'
  + '</body></html>';

const p = (s) => `<p>${s}</p>`;
const link = (url) => `<a href="${esc(url)}">${esc(url)}</a>`;

/**
 * The mail's ONE action, as a button (#1540).
 *
 * The confirm step used to be a sentence followed by the raw URL printed as
 * its own link text — sixty-odd characters of `https://…/api/public/waitlist/
 * confirm/<48 hex>` wrapping across two lines. That is not a call to action,
 * it is a machine address a person is being asked to aim at, and next to a
 * large six-digit code it read as the lesser of two chores rather than the
 * one-tap path it actually is.
 *
 * Inline styles and a real `<a>`: `<button>` does nothing in a mail client,
 * `<style>` blocks are stripped by Gmail's clipper and Outlook, and a
 * `mso-` conditional table would be scaffolding for a single control. Padding
 * on the anchor is what every client renders consistently.
 *
 * The URL still appears in the TEXT part, which is where a reader who cannot
 * see HTML needs it.
 */
const BUTTON_STYLE =
  'display:inline-block;padding:11px 20px;border-radius:8px;background:#1f86ff;'
  + 'color:#ffffff;font-size:15px;font-weight:600;text-decoration:none';
const button = (url, label) =>
  `<p><a href="${esc(url)}" style="${BUTTON_STYLE}">${esc(label)}</a></p>`;

// A one-time code, set big enough to read at arm's length and to copy by
// eye off a phone. Three mails carry one and all three render it this way;
// #1516 asked for the join mail to stop being the odd one out.
const codeBlock = (code) =>
  `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p>`;

function otp(payload) {
  const code = payload.code;
  return {
    subject: 'Your Usernode login code',
    text: `Your Usernode login code is ${code}.\n\n`
      + 'It expires in 10 minutes. If you did not request it, you can ignore this email.',
    html: (
      p('Your Usernode login code is:')
      + codeBlock(code)
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
//
// The shape follows Andrea's copy (doc comment, 27 Aug 2026): thank, set
// the expectation, confirm, and only then offer the optional questions.
//
// Two deliberate departures from that draft. It opens "The first early
// access group opens [September 9]" — the date is a placeholder and no
// wave has been committed to, so the sentence keeps the rolling-groups
// promise and drops the date rather than shipping one that slips. And it
// addresses the reader as [BRAND NAME]; the rename is a separate decision
// that has to move every surface at once, so this stays "Usernode" and
// changes with the rest.
function waitlistJoined(payload) {
  const confirmUrl = payload.confirmUrl || null;
  const surveyUrl = payload.url || null;

  let text = '';
  let html = '';

  // #1516: the code LEADS the mail. Somebody opening this on a phone is
  // here to type six digits, and the welcome above them was three
  // paragraphs to scroll past first — so the ask comes first, in the same
  // large type `otp` and `waitlistCode` already use, and the thank-you
  // follows it. On a phone, leaving for the mail app and coming back loses
  // the WebView's place, so typing the code beats following a link; on
  // desktop the one-click link below is still one click. Either confirms
  // the same row.
  //
  // Confirming is now what puts somebody ON the list rather than a tidy-up
  // afterwards, so the copy asks for it plainly instead of mentioning it in
  // passing.
  if (payload.code) {
    text += 'Confirm your email\n'
      + `Your verification code is ${payload.code}. It works for 15 minutes.\n\n`;
    html += p('<strong>Confirm your email</strong>')
      + codeBlock(payload.code)
      + p('It works for 15 minutes.');
  }

  text += 'Thanks for joining the Usernode waitlist.\n\n'
    + "We'll email you at this address as soon as your access is ready.\n\n"
    + 'Early access opens in small groups, with more groups opening on a '
    + 'rolling basis after that.';
  html += p('Thanks for joining the Usernode waitlist.')
    + p("We'll email you at this address as soon as your access is ready.")
    + p('Early access opens in small groups, with more groups opening on a '
      + 'rolling basis after that.');

  if (confirmUrl) {
    text += '\n\nOr confirm in one tap:\n' + confirmUrl;
    html += button(confirmUrl, 'Confirm my email');
  }
  if (surveyUrl) {
    text += '\n\nWant to increase your chances of getting into an earlier group? '
      + 'Answer a few optional questions, invite someone you would build with, '
      + `and follow along: ${surveyUrl}`;
    html += p('Want to increase your chances of getting into an earlier group? '
      + 'Answer a few optional questions, invite someone you would build with, '
      + `and follow along: ${link(surveyUrl)}`);
  }

  return { subject: "You're on the Usernode waitlist 🎉", text, html };
}

// Waitlist release. The no-account link carries the released address, and
// opening it asks for a sign-in code straight away, so say so: the recipient
// should be expecting a second email rather than hunting for a button. The
// 10-minute figure must match OTP_TTL_MS in src/services/email-signup.js.
const RELEASE_CODE_NOTE = 'Opening the link emails you a 6-digit code to sign in with. '
  + 'The code expires in 10 minutes, and you can ask for a new one at any time.';

// A REQUESTED confirmation code (POST /api/public/waitlist/resend, and the
// re-join branch of POST /api/public/waitlist). Separate from
// waitlist_joined because the join mail is a welcome that happens to carry
// a code, is capped at one per address per day, and re-sending it would
// tell somebody they had "joined" a list they joined weeks ago.
//
// Two shapes, and the branch is the ONLY place the platform ever discloses
// whether an address is already confirmed. The endpoint answers the same
// words to everyone; the inbox belongs to the address itself, so it is the
// one channel where saying "you are already confirmed" leaks nothing.
function waitlistCode(payload) {
  // Already confirmed: no code is minted, so there is nothing to type. The
  // useful answer is where to look at where they stand.
  if (!payload.code) {
    const statusUrl = payload.statusUrl || null;
    let text = 'You asked for a new confirmation code for the Usernode waitlist.\n\n'
      + 'This address is already confirmed, so there is nothing left to do. '
      + "You're on the list and we'll email you when your spot opens.";
    let html = p('You asked for a new confirmation code for the Usernode waitlist.')
      + p('This address is already confirmed, so there is nothing left to do. '
        + "You're on the list and we'll email you when your spot opens.");
    if (statusUrl) {
      text += `\n\nCheck where you stand: ${statusUrl}`;
      html += p(`Check where you stand: ${link(statusUrl)}`);
    }
    return { subject: 'Your Usernode waitlist address is already confirmed', text, html };
  }

  const confirmUrl = payload.confirmUrl || null;
  let text = `Your Usernode waitlist confirmation code is ${payload.code}. `
    + 'It works for 15 minutes.\n\n'
    + 'Any earlier code has stopped working, so use this one.';
  let html = p('Your Usernode waitlist confirmation code is:')
    + codeBlock(payload.code)
    + p('It works for 15 minutes. Any earlier code has stopped working, so use this one.');
  if (confirmUrl) {
    text += '\n\nOr confirm in one tap:\n' + confirmUrl;
    html += button(confirmUrl, 'Confirm my email');
  }
  text += '\n\nIf you did not ask for this, you can ignore this email.';
  html += p('If you did not ask for this, you can ignore this email.');

  return { subject: 'Your Usernode waitlist confirmation code', text, html };
}

function waitlistReleased(payload) {
  const url = payload.url;
  const text = payload.hasAccount
    ? "Good news, you're off the Usernode waitlist and your account now has platform access.\n\n"
      + `Sign in to get started: ${url}`
    : "Good news, you're off the Usernode waitlist.\n\n"
      + `Create your account with this email address to get started: ${url}\n\n`
      + RELEASE_CODE_NOTE;
  return {
    subject: 'Your Usernode access is ready',
    text,
    html: (
      p(payload.hasAccount
        ? "Good news, you're off the Usernode waitlist and your account now has platform access."
        : "Good news, you're off the Usernode waitlist.")
      + p(payload.hasAccount
        ? 'Sign in to get started.'
        : 'Create your account with this email address to get started.')
      // #1540: this mail is one link with a sentence around it, so the link
      // is the button rather than a URL printed mid-paragraph.
      + button(url, payload.hasAccount ? 'Sign in' : 'Create my account')
      + (payload.hasAccount ? '' : p(RELEASE_CODE_NOTE))
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
      + 'this, you can ignore it. Your password is unchanged.',
    html: (
      p('Someone asked to reset the password for the Usernode account with this '
        + 'email address.')
      + p(`Set a new password here: ${link(url)}`)
      + p('The link expires in 30 minutes and works once. If you did not request '
        + 'this, you can ignore it. Your password is unchanged.')
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
    html: (
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

/**
 * Every template returns a FRAGMENT; the frame is applied here, once (#1555).
 *
 * It used to be applied by the templates themselves — six of them wrapped
 * their own html and `waitlist_joined` was wrapped in this switch instead,
 * which is exactly the arrangement where a seventh template ships unbranded
 * because its author copied the wrong neighbour. One wrap, at the one place
 * every kind passes through, makes that impossible rather than unlikely.
 */
const TEMPLATES = {
  otp,
  waitlist_joined: waitlistJoined,
  waitlist_code: waitlistCode,
  waitlist_released: waitlistReleased,
  password_reset: passwordReset,
  admin_test: adminTest,
};

function buildMessage(kind, payload = {}) {
  const template = Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? TEMPLATES[kind]
    : null;
  if (!template) throw new Error(`unknown mail kind: ${kind}`);
  const message = template(payload);
  return { ...message, html: HTML_SHELL(message.html) };
}

// Every kind this module can render, for the admin console and for tests
// that want to assert the set didn't quietly shrink.
const KINDS = Object.keys(TEMPLATES);

module.exports = { buildMessage, KINDS };
