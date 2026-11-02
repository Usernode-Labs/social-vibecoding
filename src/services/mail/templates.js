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

const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const tracking = require('./tracking');
const log = require('../logger');
const { englishFrom, englishTexts } = require('../push-text');

// Minimal HTML escaping — these bodies interpolate an email address, a
// six-digit code and platform-built URLs, and, since content_report, free
// reporter-written text; every interpolated field goes through this, so the
// rule the comment once stated ("never free user text") is kept by the
// call sites rather than by the payloads.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The ONE branded frame every send goes through (#1555, restyled for #2673).
 *
 * The report was that the mails do not look like one another. They did not:
 * the shell was a bare `<body>` with a font stack, three templates wrapped
 * themselves in it, one was wrapped by `buildMessage`, and the result had no
 * sender identity anywhere except inside the sentences.
 *
 * ── Why a logo image now, reversing the #1555 call ─────────────────────
 *
 * #1555 argued for a text wordmark instead of an `<img>`: Gmail/Outlook block
 * remote images until the reader asks, Apple Mail proxies them, and a data:
 * URI is stripped by some clients and counted against others' clipping
 * threshold. All of that is still true. #2673 asks for the logo anyway, so
 * the tradeoff is accepted deliberately rather than papered over: the `alt`
 * text below IS the wordmark fallback for a client that blocks the image, so
 * the identity still renders as type when the picture does not. The asset is
 * hosted on the platform's OWN origin (public/brand/, the same public,
 * unauthenticated tier /icons/ and /illustrations/ already use — see
 * src/middleware/auth.js), not a third party, so there is nothing here for a
 * mail client's remote-content warning to be right to warn about.
 *
 * ── Table-free, and deliberately ───────────────────────────────────────
 *
 * The layout is one centred block with a max width. There is no grid to hold
 * together, so the usual `<table>` scaffolding buys nothing here and costs
 * every future editor a nested-markup puzzle. Inline styles only: `<style>`
 * blocks and classes are stripped by Gmail's clipper and by Outlook.
 *
 * ── Colors are the platform's own tokens, not generic defaults ─────────
 *
 * Every hex below is read off tailwind.config.js's `violet`/`zinc` scales and
 * public/css/app.css's `--accent*` custom properties — the same accent and
 * neutral ramp the app UI itself renders with, not a default blue or a
 * mail-template grey invented for this file.
 *
 * ── The footer says what this IS and why it arrived ────────────────────
 *
 * Claiming anything more would be a promise the platform does not keep: there
 * is no preference centre and no unsubscribe route for transactional mail, so
 * the footer does not offer one. It names the product, and it says these are
 * account mails rather than marketing — which is the honest answer to "why am
 * I getting this".
 */
const BRAND_NAME = 'Homeroom';
// tailwind.config.js `violet` ramp / public/css/app.css `--accent*`.
const BRAND_ACCENT = '#0a6ee0'; // violet-600, --accent — the CTA fill and link color.
// tailwind.config.js `zinc` ramp — the app's neutral ink and surfaces.
const NEUTRAL_PAGE_BG = '#f5f5f7'; // zinc-50
const NEUTRAL_HAIRLINE = '#e3e3e6'; // zinc-200
const NEUTRAL_INK = '#1c1c1e'; // zinc-900
const NEUTRAL_SECONDARY_INK = '#68686c'; // zinc-500
// #2908: the product's own script logotype (frontend/@/components/ui/
// wordmark.tsx), rasterized, replacing #2673's pixel-font "HOMEROOM". A NEW
// file name rather than new bytes under the old one: mail clients and image
// proxies cache by URL, and the old file stays in place for mail already sent.
const LOGO_URL = `${PRODUCTION_ORIGIN}/brand/homeroom-logotype-black.png`;
const LOGO_ALT = 'Homeroom';
const BODY_STYLE =
  `margin:0;padding:24px 12px;background:${NEUTRAL_PAGE_BG};font-family:-apple-system,`
  + 'Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;'
  + `line-height:1.55;color:${NEUTRAL_INK}`;
const CARD_STYLE =
  'max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;'
  + 'padding:28px 24px';
const LOGO_STYLE = 'display:block;margin:0 0 20px;border:0;outline:none;text-decoration:none';
const FOOTER_STYLE =
  `margin:24px 0 0;padding-top:16px;border-top:1px solid ${NEUTRAL_HAIRLINE};`
  + `font-size:12px;line-height:1.5;color:${NEUTRAL_SECONDARY_INK}`;

// Why a mail arrived, for every kind but one: the recipient's own account
// or waitlist place. A project invite goes to an address somebody ELSE
// typed, so it says that instead (its template returns `why`); claiming the
// recipient asked for it would be the one untrue sentence in the frame.
// This literal is the frame of what only an operator receives, which stays in
// English; every other kind words it from email:frame.why.
const WHY_DEFAULT = 'You are receiving this because of activity on your account or your '
  + 'place on the waitlist. We only send mail you asked for.';

// The inbox preview line a template may set. Hidden in the body, and FIRST in
// it: clients take the preview from the first text they find, which would
// otherwise be the logo's alt text.
const PREHEADER_STYLE =
  'display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent';

const HTML_SHELL = (body, why = WHY_DEFAULT, preheader = null) =>
  '<!doctype html><html><body style="' + BODY_STYLE + '">'
  + (preheader ? `<div style="${PREHEADER_STYLE}">${esc(preheader)}</div>` : '')
  + '<div style="' + CARD_STYLE + '">'
  + `<img src="${LOGO_URL}" width="140" height="37" alt="${esc(LOGO_ALT)}" `
  + `style="${LOGO_STYLE}">`
  + body
  + '<div style="' + FOOTER_STYLE + '">'
  + BRAND_NAME
  + '<br>' + esc(why)
  + '</div>'
  + '</div>'
  + '</body></html>';

const p = (s) => `<p>${s}</p>`;
const link = (url) => `<a href="${esc(url)}" style="color:${BRAND_ACCENT}">${esc(url)}</a>`;

// A catalog's text goes into html through esc(), the whole of it, parameters
// included, so a translation (untrusted model output) reaches a mail as words.
// Markup stays here in two shapes, and neither lets a message name an element
// or an address:
//
// A message whose parameter is a link: asked for with LINK_MARK in the
// parameter's place, then the link is put where the mark landed.
const LINK_MARK = '\uE000';
const withLink = (words, url) => esc(words).split(LINK_MARK).join(link(url));

// A message with numbered tags, none with a parameter: each <n>…</n> takes its
// element from `wrappers`, handed its already escaped inside. Read after
// escaping, so anything but a tag this message has stays text.
const rich = (words, wrappers) =>
  esc(words).replace(/&lt;(\d+)&gt;(.*?)&lt;\/\1&gt;/gs, (whole, n, inner) => (
    wrappers[Number(n)] ? wrappers[Number(n)](inner) : whole
  ));

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
  `display:inline-block;padding:11px 20px;border-radius:8px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:15px;font-weight:600;text-decoration:none';
const button = (url, label) =>
  `<p><a href="${esc(url)}" style="${BUTTON_STYLE}">${esc(label)}</a></p>`;

// The welcome hero's two pieces, shared with the plainer mails that now wear
// the same treatment (#5068): the landing page's full-round pill and the one
// centred cell the release mail drew for itself. Inline styles on a real
// `<a>`: `<button>` does nothing in a mail client, `<style>` blocks are
// stripped by Gmail's clipper and Outlook, and a `mso-` conditional table
// would be scaffolding for a single control. Padding on the anchor is what
// every client renders consistently.
const PILL_STYLE =
  `display:inline-block;padding:12px 28px;border-radius:999px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:16px;font-weight:650;text-decoration:none';
const pill = (url, label) =>
  `<p style="margin:20px 0 0"><a href="${esc(url)}" style="${PILL_STYLE}">${esc(label)}</a></p>`;

// The hero (eyebrow, headline, line, pill) is one centred cell, like the
// landing page's pitch block. Table scaffolding here is not the frame's
// "table-free" rule broken: a cell's text-align:center is the one centreing
// a plain block cannot carry in clients that ignore margins on paragraphs.
const centered = (inner) =>
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
  + ' style="border-collapse:collapse"><tr><td style="text-align:center">'
  + inner
  + '</td></tr></table>';

// The hero's type, as the release mail draws it and now the rest of the
// plain family (#5068): a small uppercase eyebrow over a big weight-800
// headline (the release mail's 28px for its one short sentence, 24px where
// the news can run several sentences), and the grey line under it.
const heroEyebrow = (text, top = 0) =>
  `<p style="margin:${top}px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;`
  + `text-transform:uppercase;color:${NEUTRAL_SECONDARY_INK}">${esc(text)}</p>`;
const heroHeadline = (text, size = 28, lineHeight = 32) =>
  `<p style="margin:10px 0 0;font-size:${size}px;line-height:${lineHeight}px;font-weight:800;`
  + `color:${NEUTRAL_INK}">${esc(text)}</p>`;
const heroLine = (text) =>
  `<p style="margin:10px 0 0;font-size:16px;line-height:22px;`
  + `color:${NEUTRAL_SECONDARY_INK}">${esc(text)}</p>`;

// A one-time code, set big enough to read at arm's length and to copy by
// eye off a phone. Three mails carry one and all three render it this way;
// #1516 asked for the join mail to stop being the odd one out.
const codeBlock = (code) =>
  `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p>`;

function otp(payload, t) {
  const code = payload.code;
  return {
    subject: t('email:otp.subject'),
    text: `${t('email:otp.text.code', { code })}\n\n${t('email:otp.expiry')}`,
    html: (
      p(esc(t('email:otp.html.code')))
      + codeBlock(code)
      + p(esc(t('email:otp.expiry')))
    ),
  };
}

// Waitlist join confirmation. One optional link:
//   - payload.confirmUrl — the one-click "confirm this address" link.
//     Following it stamps waitlist_signups.confirmed_at and lands on the
//     stage-2 survey, so confirming and answering are one motion.
// It may be absent (an idempotent re-join carries none), and the copy must
// not grow an empty paragraph or the string "undefined" when that happens.
//
// #2908 removed the closing "Want to increase your chances of getting into
// an earlier group?" paragraph and its #more/<token> survey link. Callers
// still pass payload.url; this template no longer prints it.
//
// The shape follows Andrea's copy (doc comment, 27 Aug 2026): thank, set
// the expectation, confirm, and only then offer the optional questions.
//
// Two deliberate departures from that draft. It opens "The first early
// access group opens [September 9]" — the date is a placeholder and no
// wave has been committed to, so the sentence keeps the rolling-groups
// promise and drops the date rather than shipping one that slips. And it
// addresses the reader as [BRAND NAME], which is BRAND_NAME above — the
// rename to Homeroom moved every surface at once, and this line moved
// with the rest.
function waitlistJoined(payload, t) {
  const confirmUrl = payload.confirmUrl || null;

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
    text += `${t('email:waitlistJoined.heading')}\n`
      + `${t('email:waitlistJoined.text.code', { code: payload.code })}\n\n`;
    html += p(`<strong>${esc(t('email:waitlistJoined.heading'))}</strong>`)
      + codeBlock(payload.code)
      + p(esc(t('email:waitlistJoined.html.codeLife')));
  }

  const welcome = [t('email:waitlistJoined.thanks'), t('email:waitlistJoined.expectation'), t('email:waitlistJoined.groups')];
  text += welcome.join('\n\n');
  html += welcome.map((line) => p(esc(line))).join('');

  if (confirmUrl) {
    text += `\n\n${t('email:waitlistJoined.text.oneTap')}\n${confirmUrl}`;
    html += button(confirmUrl, t('email:waitlistJoined.button'));
  }

  return { subject: t('email:waitlistJoined.subject'), text, html };
}

// A REQUESTED confirmation code (POST /api/public/waitlist/resend, and the
// re-join branch of POST /api/public/waitlist). Separate from
// waitlist_joined because the join mail is a welcome that happens to carry
// a code, is capped at one per address per day, and re-sending it would
// tell somebody they had "joined" a list they joined weeks ago.
//
// Three shapes, and the branch is the ONLY place the platform ever
// discloses whether an address is already confirmed. The endpoint answers
// the same words to everyone; the inbox belongs to the address itself, so
// it is the one channel where saying "you are already confirmed" leaks
// nothing.
//
// `payload.confirmed` picks between the two code shapes. A confirmed
// address asking for a code is check-my-status (#1538), so the mail is a
// status code and its one button carries NO capability token — a code you
// type is the thing that survives a mail scanner rewriting links (#1545),
// and moving away from mailed magic links is the direction #1531 wants.
function waitlistCode(payload, t) {
  // Minting failed for an already-confirmed address: there is no code to
  // type, so the useful answer is where to look at where they stand.
  if (!payload.code) {
    const statusUrl = payload.statusUrl || null;
    const asked = t('email:waitlistCode.done.asked');
    const nothingLeft = t('email:waitlistCode.done.nothingLeft');
    let text = `${asked}\n\n${nothingLeft}`;
    let html = p(esc(asked)) + p(esc(nothingLeft));
    if (statusUrl) {
      text += `\n\n${t('email:waitlistCode.done.status', { url: statusUrl })}`;
      html += p(withLink(t('email:waitlistCode.done.status', { url: LINK_MARK }), statusUrl));
    }
    return { subject: t('email:waitlistCode.done.subject'), text, html };
  }

  // The status-code shape: same six digits, different errand.
  if (payload.confirmed) {
    const statusUrl = payload.statusUrl || null;
    let text = `${t('email:waitlistCode.status.text.code', { code: payload.code })}\n\n`
      + t('email:waitlistCode.status.text.newest');
    let html = p(esc(t('email:waitlistCode.status.html.code')))
      + codeBlock(payload.code)
      + p(esc(t('email:waitlistCode.status.html.life')));
    if (statusUrl) {
      text += `\n\n${t('email:waitlistCode.status.text.enter')}\n${statusUrl}`;
      html += button(statusUrl, t('email:waitlistCode.status.button'));
    }
    text += `\n\n${t('email:waitlistCode.status.ignore')}`;
    html += p(esc(t('email:waitlistCode.status.ignore')));
    return { subject: t('email:waitlistCode.status.subject'), text, html };
  }

  const confirmUrl = payload.confirmUrl || null;
  let text = `${t('email:waitlistCode.confirm.text.code', { code: payload.code })}\n\n`
    + t('email:waitlistCode.confirm.text.newest');
  let html = p(esc(t('email:waitlistCode.confirm.html.code')))
    + codeBlock(payload.code)
    + p(esc(t('email:waitlistCode.confirm.html.life')));
  if (confirmUrl) {
    text += `\n\n${t('email:waitlistCode.confirm.text.oneTap')}\n${confirmUrl}`;
    html += button(confirmUrl, t('email:waitlistCode.confirm.button'));
  }
  text += `\n\n${t('email:waitlistCode.confirm.ignore')}`;
  html += p(esc(t('email:waitlistCode.confirm.ignore')));

  return { subject: t('email:waitlistCode.confirm.subject'), text, html };
}

// Waitlist release, the "you're in" welcome. #4570 restyled it after the
// signed-out landing page (frontend/src/features/auth/landing.tsx) and cut it
// to its one job: get the person in now that their spot is open. A
// no-account link without a one-time sign-in carries only the released
// address, and opening it asks for a sign-in code straight away, so say so:
// the recipient should be expecting a second email rather than hunting for a
// button. The 10-minute figure must match OTP_TTL_MS in
// src/services/email-signup.js (the message is email:waitlistReleased.codeNote).
//
// A link WITH the one-time sign-in (#4594, services/release-links.js) gets no
// note: the button signs them in, and the screen its fallback opens says
// itself that a code was sent. The link is bound to the released address and
// the fallback fills it in, so the mail does not ask them to remember which
// address they joined with either.
// The landing page's people illustration, the same file that screen draws at
// /brand/people.png. An absolute URL for the same reason the logo's is: a
// mail client has no page context to resolve a relative one against. Empty
// `alt` because it is decorative — the headline under it carries the meaning,
// and a client that blocks images shows a blank gap, not a broken layout.
const ILLUSTRATION_URL = `${PRODUCTION_ORIGIN}/brand/people.png`;

// The three "once you're inside" points as landing-page chips. The colours are
// the MID stops of frontend/src/features/auth/landing.tsx's `CHIPS`
// gradients — one solid fill per chip rather than the gradient itself,
// because mail clients do not draw `radial-gradient` reliably.
const RELEASE_CAN_DO = [
  { id: 'email:waitlistReleased.canDo.make', color: '#3484fc' },
  { id: 'email:waitlistReleased.canDo.use', color: '#8bd669' },
  { id: 'email:waitlistReleased.canDo.suggest', color: '#fc5750' },
];

// Install notes per platform, one line each with the one step that is a
// link. The links are the published store listings
// (services/mobile-store-links.js), so a platform whose listing is cleared
// drops out instead of pointing nowhere.
const RELEASE_MOBILE = [
  { os: 'ios', text: 'email:waitlistReleased.mobile.ios.text', html: 'email:waitlistReleased.mobile.ios.html' },
  { os: 'android', text: 'email:waitlistReleased.mobile.android.text', html: 'email:waitlistReleased.mobile.android.html' },
];

// `inner` is html already (it comes through rich()).
const inlineLink = (url, inner) =>
  `<a href="${esc(url)}" style="color:${BRAND_ACCENT}">${inner}</a>`;

// One chip, as the landing rail draws it: a square card, no radius (the
// corners are the chip's whole character on a page of round pills), a 1px
// near-black hairline, the board's hard 2px/2px offset shadow, and a 34px
// solid colour block flush into its left edge. Its own table because a
// floating row needs one, and `border-collapse:separate` so the hairline
// draws around the card rather than collapsing away.
const releaseChip = (line, color, top = 0) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
  + ` style="border-collapse:separate;margin:${top}px 0 8px;border:1px solid #0b0b0c;`
  + 'box-shadow:2px 2px 4px rgba(161,152,152,0.25)">'
  + '<tr>'
  + `<td width="34" height="34" bgcolor="${color}" style="width:34px;height:34px;background:${color}">&nbsp;</td>`
  + `<td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:${NEUTRAL_INK}">${esc(line)}</td>`
  + '</tr></table>';

function waitlistReleased(payload, t) {
  const url = payload.url;
  const hasAccount = !!payload.hasAccount;
  const mobile = payload.mobile || {};
  const platforms = RELEASE_MOBILE.filter((m) => mobile[m.os]);

  const action = hasAccount ? t('email:waitlistReleased.signIn.button') : t('email:waitlistReleased.create.button');
  const how = hasAccount ? t('email:waitlistReleased.signIn.how') : null;
  // #1548: a no-account link with no one-time sign-in sends a code the
  // moment it is opened, so say so. Somebody who is not told to expect a
  // SECOND email goes hunting for a button that is not there.
  const note = !hasAccount && !payload.signInLink ? t('email:waitlistReleased.codeNote') : null;
  const headline = t('email:waitlistReleased.headline');

  // The text part has no button, so it names the action over the link.
  let text = `${t('email:waitlistReleased.text.opening')}\n${headline}\n\n`
    + `${how || t('email:waitlistReleased.create.text')}\n${url}`;
  if (note) text += `\n\n${note}`;
  text += '\n\n' + RELEASE_CAN_DO.map((c) => `- ${t(c.id)}`).join('\n');

  let html = centered(
    `<img src="${ILLUSTRATION_URL}" width="272" height="204" alt=""`
      + ' style="display:block;margin:0 auto;border:0;max-width:100%;height:auto">'
    + heroEyebrow(t('email:waitlistReleased.eyebrow'), 20)
    + heroHeadline(headline)
    + (how ? heroLine(how) : '')
    + pill(url, action)
    + (note ? `<p style="margin:10px 0 0;font-size:13px;`
      + `color:${NEUTRAL_SECONDARY_INK}">${esc(note)}</p>` : '')
  )
    + RELEASE_CAN_DO.map((c, i) => releaseChip(t(c.id), c.color, i === 0 ? 24 : 0)).join('');

  if (platforms.length) {
    const heading = t('email:waitlistReleased.mobile.heading');
    text += `\n\n${heading}`;
    html += `<p style="margin:24px 0 8px;font-size:12px;font-weight:700;`
      + `letter-spacing:0.06em;text-transform:uppercase;`
      + `color:${NEUTRAL_SECONDARY_INK}">${esc(heading)}</p>`;
    for (const m of platforms) {
      const store = mobile[m.os];
      text += `\n${t(m.text, { link: store })}`;
      html += '<p style="margin:0 0 8px">'
        + rich(t(m.html), [(inner) => `<strong>${inner}</strong>`, (inner) => inlineLink(store, inner)])
        + '</p>';
    }
  }

  const signoff = t('email:waitlistReleased.signoff');
  text += `\n\n${signoff}`;
  html += p(esc(signoff).replace(/\n/g, '<br>'));

  return {
    subject: t('email:waitlistReleased.subject'),
    preheader: t('email:waitlistReleased.preheader'),
    text,
    html,
  };
}

// Password-reset magic link (#login → "Forgot password"). Carries the
// tokenized link and nothing else the recipient could be phished with —
// no username, no code to read back to anyone. The 30-minute figure must
// match RESET_TOKEN_TTL_MS in src/routes/auth.js.
function passwordReset(payload, t) {
  const url = payload.url;
  const requested = t('email:passwordReset.requested');
  const expiry = t('email:passwordReset.expiry');
  return {
    subject: t('email:passwordReset.subject'),
    text: `${requested}\n\n${t('email:passwordReset.link', { url })}\n\n${expiry}`,
    html: (
      p(esc(requested))
      + p(withLink(t('email:passwordReset.link', { url: LINK_MARK }), url))
      + p(esc(expiry))
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

  const text = 'This is a test email from the Homeroom platform admin console.\n\n'
    + `Provider: ${provider}\n`
    + `Sent as: ${from}\n`
    + `Sent at: ${sentAt}\n`
    + `Reference: ${reference}\n\n`
    + 'An administrator sent it to check that outbound email works. '
    + 'No action is needed.';

  // #5068: the welcome hero's eyebrow and headline, and the four details as
  // rows of one hairline box instead of a `<br>` run. Still deliberately
  // carries NOTHING sensitive and nothing to act on: no link, no button.
  const row = (label, value, first = false) =>
    '<tr>'
    + `<td style="font-size:14px;line-height:1.5;padding:6px 12px;color:${NEUTRAL_SECONDARY_INK}`
    + (first ? '' : `;border-top:1px solid ${NEUTRAL_HAIRLINE}`) + `">${esc(label)}</td>`
    + '<td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right">'
    + value + '</td></tr>';
  const detail =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
    + ` style="border-collapse:separate;margin:20px 0 0;border:1px solid ${NEUTRAL_HAIRLINE};`
    + 'border-radius:12px"><tbody>'
    + row('Provider', `<strong>${esc(provider)}</strong>`, true)
    + row('Sent as', esc(from))
    + row('Sent at', esc(sentAt))
    + row('Reference', `<code>${esc(reference)}</code>`)
    + '</tbody></table>';

  return {
    subject: 'Homeroom test email',
    text,
    html: (
      centered(heroEyebrow('Test email')
        + heroHeadline('This is a test email from the Homeroom platform admin console.', 24, 30))
      + detail
      + `<p style="margin:16px 0 0;text-align:center;font-size:13px;color:${NEUTRAL_SECONDARY_INK}">`
      + 'An administrator sent it to check that outbound email works. No action is needed.</p>'
    ),
  };
}

// A new content report, to the platform's compliance inbox
// (services/moderation.js submitReport). Unlike every kind above, the text
// here IS free reporter-written text (the reason's optional detail), so every
// field goes through esc() and the html detail keeps its line breaks. It does
// NOT quote the reported message itself or carry evidence files: the link
// opens the case in the admin console, where that copy stays behind the
// admin sign-in. Type labels match the Moderation section's own words.
const REPORT_TYPE_LABELS = {
  app: 'App',
  user: 'User',
  app_message: 'App message',
  conversation_message: 'Private message',
};

function contentReport(payload) {
  const reason = String(payload.reason || 'unknown').replace(/_/g, ' ');
  const targetLabel = String(payload.targetLabel || 'Unknown target').slice(0, 120);
  const typeLabel = REPORT_TYPE_LABELS[payload.targetType] || 'Unknown';
  const reporter = payload.reporter ? `@${payload.reporter}` : 'Unknown';
  const caseId = payload.caseId != null ? payload.caseId : '?';
  const reportId = payload.reportId != null ? payload.reportId : '?';
  const detail = String(payload.detail || '').trim();
  const shownDetail = detail || 'None given';
  const url = payload.url || PRODUCTION_ORIGIN;

  const text = 'A new report was submitted on Homeroom.\n\n'
    + `Reason: ${reason}\n`
    + `Reported: ${typeLabel} · ${targetLabel}\n`
    + `Reporter: ${reporter}\n`
    + `Case #${caseId} · Report #${reportId}\n\n`
    + `Details from the reporter:\n${shownDetail}\n\n`
    + `Open in Moderation: ${url}`;

  return {
    why: 'You are receiving this because this address is Homeroom\'s '
      + 'compliance inbox for content reports.',
    preheader: `New ${reason} report on ${targetLabel}`,
    subject: `New report: ${reason} · ${targetLabel}`.slice(0, 200),
    text,
    html: (
      p('A new report was submitted on Homeroom.')
      + `<p>Reason: <strong>${esc(reason)}</strong><br>`
      + `Reported: ${esc(typeLabel)} · ${esc(targetLabel)}<br>`
      + `Reporter: ${esc(reporter)}<br>`
      + `Case #${esc(String(caseId))} · Report #${esc(String(reportId))}</p>`
      + p('Details from the reporter:')
      + `<p style="white-space:pre-wrap">${esc(shownDetail)}</p>`
      + button(url, 'Open in Moderation')
    ),
  };
}

// A project invite, to an address that is not on Homeroom yet (the create
// dialog's "Will invite" rows; services/email-invites.js). One link: the
// waitlist, joined with this address. Nothing here grants access; the invite
// waits on the account and turns into an ordinary one once the address is
// confirmed on it. Every field is optional so the kind still renders empty.
// A sentence per what is known about the invite: a stand-in word for somebody
// or something unnamed takes a different form from a name in many languages.
const INVITE_WORDS = {
  named: { subject: 'email:projectInvite.named.subject', lead: 'email:projectInvite.named.lead', headline: 'email:projectInvite.named.headline' },
  noInviter: { subject: 'email:projectInvite.noInviter.subject', lead: 'email:projectInvite.noInviter.lead', headline: 'email:projectInvite.noInviter.headline' },
  noProject: { subject: 'email:projectInvite.noProject.subject', lead: 'email:projectInvite.noProject.lead', headline: 'email:projectInvite.noProject.headline' },
  nothing: { subject: 'email:projectInvite.nothing.subject', lead: 'email:projectInvite.nothing.lead', headline: 'email:projectInvite.nothing.headline' },
};

function projectInvite(payload, t) {
  const { inviter, project } = payload;
  const words = inviter
    ? (project ? INVITE_WORDS.named : INVITE_WORDS.noProject)
    : (project ? INVITE_WORDS.noInviter : INVITE_WORDS.nothing);
  const values = { inviter, project };
  const url = payload.url || '';
  return {
    why: t('email:projectInvite.why'),
    subject: t(words.subject, values),
    text: `${t(words.lead, values)}\n\n${t('email:projectInvite.text.how')}${url ? `\n\n${url}` : ''}`
      + `\n\n${t('email:projectInvite.text.unexpected')}`,
    // #5068: the welcome hero, minus the eyebrow's sentence-splitting into
    // headline and line. The text part keeps the whole first sentence.
    html: (
      centered(
        heroEyebrow(t('email:projectInvite.eyebrow'))
        + heroHeadline(t(words.headline, values), 24, 30)
        + heroLine(t('email:projectInvite.html.line'))
        + (url ? pill(url, t('email:projectInvite.button')) : '')
        + `<p style="margin:16px 0 0;font-size:13px;color:${NEUTRAL_SECONDARY_INK}">`
          + `${esc(t('email:projectInvite.html.unexpected'))}</p>`
      )
    ),
  };
}

// WP-E: activity mail, the stand-in for a push somebody's phone cannot take
// (services/activity-mail.js). Unlike every kind above, the recipient did not
// ask for this one by doing something just now, so each says why it came,
// carries a one-click unsubscribe (RFC 8058: `List-Unsubscribe` with
// `List-Unsubscribe-Post`), and offers the same link in its words.
// #5068: the activity mails wear the welcome hero now, without the release
// mail's illustration. The lead is the headline (24px, not 28px: it can run
// several sentences), the project's name is the eyebrow, and "Stop these
// emails" sits small and grey under the pill. Everything else about the
// send is untouched: the same words in the text part, the same preheader,
// the same List-Unsubscribe headers.
function activityFrame(t, { subject, lead, url, label, textLink, eyebrow = '', unsubscribeUrl }) {
  const off = unsubscribeUrl
    ? t('email:activity.stop.text', { url: unsubscribeUrl })
    : '';
  return {
    why: t('email:activity.why'),
    preheader: lead,
    subject,
    text: `${lead}\n\n${textLink}${off ? `\n\n${off}` : ''}`,
    html: centered(
      (eyebrow ? heroEyebrow(eyebrow) : '')
      + heroHeadline(lead, 24, 30)
      + pill(url, label)
      + (unsubscribeUrl ? `<p style="margin:16px 0 0;font-size:13px">`
        + `<a href="${esc(unsubscribeUrl)}" style="color:${NEUTRAL_SECONDARY_INK}">${esc(t('email:activity.stop.link'))}</a></p>` : '')
    ),
    headers: unsubscribeUrl ? {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : null,
  };
}

// Something somebody asked Homeroom bot for is ready to try. "One story":
// worded as its push is (homeroom-bot-notify-copy.js botEmailCopy): the
// request and its project with the body's first sentence ("Dark mode · Plant
// Pal: Ready to try"), over the push's body. A sender that did not hand the
// words over gets the same shape from the project's name.
function buildReady(payload, t) {
  const app = String(payload.appName || t('email:buildReady.unnamedProject')).slice(0, 80);
  const lead = typeof payload.lead === 'string' && payload.lead.trim()
    ? payload.lead.trim().slice(0, 300)
    : (payload.notWorking ? t('email:buildReady.lead.notWorking') : t('email:buildReady.lead.ready'));
  const subject = typeof payload.subject === 'string' && payload.subject.trim()
    ? payload.subject.trim().slice(0, 200)
    : (payload.notWorking ? t('email:buildReady.subject.notWorking', { app }) : t('email:buildReady.subject.ready', { app }));
  const url = payload.url || PRODUCTION_ORIGIN;
  return activityFrame(t, {
    subject,
    lead,
    url,
    label: t('email:buildReady.button'),
    textLink: t('email:buildReady.text.open', { url }),
    unsubscribeUrl: payload.unsubscribeUrl || null,
    eyebrow: app,
  });
}

// The people an invite link brought: "@sam joined Run Club through your invite."
const NOTICE_LINES = {
  first_message: 'email:inviteActivity.firstMessage',
  member_joined: 'email:inviteActivity.joined',
  member_joined_someone: 'email:inviteActivity.joinedSomeone',
};

function inviteActivity(payload, t) {
  const app = payload.appName ? String(payload.appName).slice(0, 80) : null;
  // The notice it stands for names its own message; `line` is its English.
  const noticeId = NOTICE_LINES[payload.notice?.id] || null;
  const fallback = app ? t('email:inviteActivity.joinedSomeone', { app }) : t('email:inviteActivity.joinedUnnamed');
  const line = String(
    (noticeId ? t(noticeId, payload.notice.values) : '') || payload.line || fallback,
  ).slice(0, 200);
  const url = payload.url || PRODUCTION_ORIGIN;
  return activityFrame(t, {
    subject: line.replace(/\.$/, ''),
    lead: line,
    url,
    label: app ? t('email:inviteActivity.button', { app }) : t('email:inviteActivity.buttonUnnamed'),
    textLink: app ? t('email:inviteActivity.text.open', { app, url }) : t('email:inviteActivity.text.openUnnamed', { url }),
    unsubscribeUrl: payload.unsubscribeUrl || null,
    // The eyebrow is the project's name only when the sender gave one; the
    // lowercase fallback reads fine in a sentence, not as a label.
    eyebrow: payload.appName ? String(payload.appName).slice(0, 80) : '',
  });
}

// #4396: a project the reader joined while it was made is open
// (services/project-opened.js), for somebody with no phone to ring.
function projectOpened(payload, t) {
  const app = payload.appName ? String(payload.appName).slice(0, 80) : null;
  const url = payload.url || PRODUCTION_ORIGIN;
  return activityFrame(t, {
    subject: app ? t('email:projectOpened.subject', { app }) : t('email:projectOpened.subjectUnnamed'),
    lead: app ? t('email:projectOpened.lead', { app }) : t('email:projectOpened.leadUnnamed'),
    url,
    label: t('email:projectOpened.button'),
    textLink: t('email:projectOpened.text.open', { url }),
    unsubscribeUrl: payload.unsubscribeUrl || null,
    eyebrow: payload.appName ? String(payload.appName).slice(0, 80) : '',
  });
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
  account_email: ({ code }, t) => ({
    subject: t('email:accountEmail.subject'),
    text: `${t('email:accountEmail.text.code', { code })}\n\n${t('email:accountEmail.text.instructions')}`,
    // Its "&" has always gone out bare, and English stays byte for byte. Nothing
    // here can become markup: only "&amp;" is undone, after every "<" is gone.
    html: p(esc(t('email:accountEmail.html.lead')).replace(/&amp;/g, '&'))
      + codeBlock(code)
      + p(esc(t('email:accountEmail.html.expiry'))),
  }),
  // #5281: confirms a username change on an account that has no password.
  // It names what the code does, so a code nobody asked for reads as a
  // warning rather than as a sign-in prompt.
  username_change: ({ code }, t) => ({
    subject: t('email:usernameChange.subject'),
    text: `${t('email:usernameChange.text.code', { code })}\n\n${t('email:usernameChange.text.instructions')}`,
    html: p(esc(t('email:usernameChange.html.lead')))
      + codeBlock(code)
      + p(esc(t('email:usernameChange.html.expiry'))),
  }),
  waitlist_joined: waitlistJoined,
  waitlist_code: waitlistCode,
  waitlist_released: waitlistReleased,
  password_reset: passwordReset,
  admin_test: adminTest,
  content_report: contentReport,
  project_invite: projectInvite,
  build_ready: buildReady,
  invite_activity: inviteActivity,
  project_opened: projectOpened,
};

// What only an admin or an operator receives is written above in English and
// never asks for a translation.
const ENGLISH_ONLY_KINDS = new Set(['admin_test', 'content_report']);

// A line break, a control character or a separator some client treats as one.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;
const controls = (text) => (text.match(CONTROL) || []).join('');

/**
 * What a template asks with: `t(id, values)`, English unless `translate` has a
 * usable answer. An answer that is not text, is empty, or brings line breaks
 * the English does not have (a translation may not add lines to a mail, or
 * headers to its subject) costs that one message its translation. `missing`
 * records an id the English does not have.
 */
function wordsWith(translate) {
  const english = englishFrom(englishTexts(undefined, 'email'));
  const words = {
    missing: false,
    t(id, values) {
      const inEnglish = english(id, values);
      if (!inEnglish) words.missing = true;
      if (!translate) return inEnglish;
      const answer = translate(id, values);
      return typeof answer === 'string' && answer.trim() && controls(answer) === controls(inEnglish)
        ? answer
        : inEnglish;
    },
  };
  return words;
}

// The values a mail exists to carry. Its translation must carry every one the
// English does, or the English goes instead.
function keepsWhatItCarries(payload, inEnglish, translated) {
  const carried = [payload.code, payload.url, payload.confirmUrl, payload.statusUrl, payload.unsubscribeUrl, ...Object.values(payload.mobile || {})];
  return carried.every((value) => {
    if (value == null || value === '') return true;
    const plain = String(value);
    const marked = esc(plain);
    return (!inEnglish.text.includes(plain) || translated.text.includes(plain))
      && (!inEnglish.html.includes(marked) || translated.html.includes(marked));
  });
}

// With no English at all (a build that lost its catalog), the bare minimum:
// a login mail must not go out blank. Never in a working build.
function lastResort(payload, built) {
  const lines = [payload.code, payload.url, payload.confirmUrl, payload.statusUrl].filter(Boolean).map(String);
  return {
    subject: BRAND_NAME,
    text: [BRAND_NAME, ...lines].join('\n\n'),
    html: [...(payload.code ? [codeBlock(payload.code)] : []),
      ...lines.filter((line) => /^https?:/.test(line)).map((line) => p(link(line)))].join(''),
    why: '',
    headers: built.headers,
  };
}

function render(kind, template, payload, translate) {
  const words = wordsWith(translate);
  const built = template(payload, words.t);
  const message = built.why === undefined && !ENGLISH_ONLY_KINDS.has(kind)
    ? { ...built, why: words.t('email:frame.why') }
    : built;
  return { message, missing: words.missing };
}

/** A kind's template, worded: its translation where that is usable, its English otherwise. */
function wordedTemplate(kind, template) {
  return (payload) => {
    const { message: inEnglish, missing } = render(kind, template, payload, null);
    if (missing) return lastResort(payload, inEnglish);
    if (!payload.translate || ENGLISH_ONLY_KINDS.has(kind)) return inEnglish;
    try {
      const { message: translated } = render(kind, template, payload, payload.translate);
      if (keepsWhatItCarries(payload, inEnglish, translated)) {
        return { ...translated, subject: translated.subject.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim() };
      }
    } catch (err) {
      log.warn('platform-mail', 'A mail\'s translation could not be used', { kind, message: err.message });
    }
    return inEnglish;
  };
}

function buildMessage(kind, payload = {}) {
  const template = Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? wordedTemplate(kind, TEMPLATES[kind])
    : null;
  if (!template) throw new Error(`unknown mail kind: ${kind}`);
  const { why, preheader, headers, ...message } = template(tracking.attributedPayload(kind, payload));
  return tracking.decorate(kind, {
    ...message,
    html: HTML_SHELL(message.html, why, preheader),
    // Extra mail headers a kind needs (activity mail's List-Unsubscribe);
    // a transport adds them as given.
    ...(headers ? { headers } : {}),
  }, payload);
}

// Every kind this module can render, for the admin console and for tests
// that want to assert the set didn't quietly shrink.
const KINDS = Object.keys(TEMPLATES);

module.exports = { buildMessage, KINDS, ENGLISH_ONLY_KINDS };
