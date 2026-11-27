'use strict';

// The first versions of the admin-editable email templates, in plain English,
// and the code that puts them in the database. They are data: what a fresh
// database (a new install, a preview starting empty) starts from, and what a
// process with no database at all renders with (template-store seededSnapshot).
// From then on the words are the admins', written and translated in the admin
// console (Admin, Email templates). Once an action has a row, deleted or not,
// nothing here adds another; a row nobody has edited follows these words (see
// "Untouched rows" below).
//
// They were taken from the hard-coded mails they replaced, and
// tests/mail-seed-equivalence.test.js proves they render what those did, byte
// for byte, against a snapshot of that output. Change them only together with
// that test's accepted differences.
//
// A fresh database gets English only. Its other languages come from Translate
// in the console; until then a reader in another language gets the English.

const crypto = require('node:crypto');
const log = require('../services/logger');
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');
const { ACTIONS, isDrip } = require('../services/mail/actions');

const STANDARD_LAYOUT = 'Homeroom standard';
// tailwind.config.js `zinc` ramp.
const NEUTRAL_PAGE_BG = '#f5f5f7';
const NEUTRAL_HAIRLINE = '#e3e3e6';
const NEUTRAL_INK = '#1c1c1e';
const NEUTRAL_SECONDARY_INK = '#68686c';

// ── The frame ──────────────────────────────────────────────────────────

const BODY_STYLE = `margin:0;padding:24px 12px;background:${NEUTRAL_PAGE_BG};font-family:-apple-system,`
  + `Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${NEUTRAL_INK}`;
const CARD_STYLE = 'max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px';
const LOGO_STYLE = 'display:block;margin:0 0 20px;border:0;outline:none;text-decoration:none';
const FOOTER_STYLE = `margin:24px 0 0;padding-top:16px;border-top:1px solid ${NEUTRAL_HAIRLINE};`
  + `font-size:12px;line-height:1.5;color:${NEUTRAL_SECONDARY_INK}`;
const PREHEADER_STYLE = 'display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent';

const STANDARD_LAYOUT_HTML = `<!doctype html><html><body style="${BODY_STYLE}">`
  + `{{#if preheader}}<div style="${PREHEADER_STYLE}">{{preheader}}</div>{{/if}}`
  + `<div style="${CARD_STYLE}">`
  + `<img src="${PRODUCTION_ORIGIN}/brand/homeroom-logotype-black.png" width="140" height="37" alt="Homeroom" style="${LOGO_STYLE}">`
  + '{{content}}'
  + `<div style="${FOOTER_STYLE}">Homeroom<br>{{why}}</div>`
  + '</div></body></html>';

// ── The seeds ──────────────────────────────────────────────────────────

// The waitlist reminders' shared parts. Each reads as a short note from Evan:
// left-aligned paragraphs (REMINDER_P), and the admit mail's button, which
// signs in an account or starts a new one, left-aligned with them in a table
// of its own (Drea, on 6508).
const REMINDER_P = '<p style="margin:0 0 12px;font-size:16px;line-height:24px;color:#1c1c1e">';
const REMINDER_BUTTON = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:left">'
  + '<p style="margin:8px 0 20px"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">'
  + '{{#if hasAccount}}Sign in{{else}}Get started{{/if}}</a></p></td></tr></table>';
const REMINDER_TEXT_BUTTON = '{{#if hasAccount}}Sign in:{{else}}Get started:{{/if}}\n{{url}}\n\n';

// ── The drip (drafts until the sending is built) ───────────────────────
//
// The new drip's emails (actions.js `drip`). They are seeded as DRAFTS:
// shown, previewed and test-sent in Admin > Email templates, never sent.
// Copy approved by the product owner on 26 Nov 2026; keep it word for word.
// Two looks: the team's in the standard layout, and Evan's as a typed note
// (PLAIN_LAYOUT: no logo, no card, plain text on white, the same footer line).
// One yellow button at most, table-built so Outlook draws it.
const PLAIN_LAYOUT = 'Evan, typed note';
const PLAIN_LAYOUT_HTML = `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#ffffff;font-family:-apple-system,`
  + `Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:${NEUTRAL_INK}">`
  + `{{#if preheader}}<div style="${PREHEADER_STYLE}">{{preheader}}</div>{{/if}}`
  + '<div style="max-width:520px;margin:0;text-align:left">'
  + '{{content}}'
  + `<div style="margin:32px 0 0;padding-top:12px;border-top:1px solid ${NEUTRAL_HAIRLINE};font-size:12px;line-height:18px;color:${NEUTRAL_SECONDARY_INK}">{{why}}</div>`
  + '</div></body></html>';
const DRIP_P = '<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1c1c1e">';
const DRIP_UL = '<ul style="margin:0 0 16px;padding:0 0 0 22px;font-size:16px;line-height:24px;color:#1c1c1e">';
const DRIP_LI = '<li style="margin:0 0 8px">';
const DRIP_GREETING = '{{#if first_name}}Hey {{first_name}},{{else}}Hey!{{/if}}';
const DRIP_TEXT_GREETING = '{{#if first_name}}Hey {{first_name}},{{else}}Hey!{{/if}}';
const DRIP_BUTTON_OPEN = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:8px 0 24px"><tr>'
  + '<td style="border-radius:999px;background:#FFEE6F;border:2px solid #000000;box-shadow:3px 3px 0 #000000">'
  + '<a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;font-size:16px;line-height:20px;font-weight:700;color:#000000;text-decoration:none">';
const DRIP_BUTTON_CLOSE = '</a></td></tr></table>';
const DRIP_UNSUBSCRIBE = '{{#if hasUnsubscribeUrl}} <a href="{{unsubscribeUrl}}" style="color:#68686c">Unsubscribe</a>{{/if}}';
const DRIP_TEXT_UNSUBSCRIBE = '{{#if hasUnsubscribeUrl}}\n\nUnsubscribe: {{unsubscribeUrl}}{{/if}}';
const SKY_BANNER = `<img src="${PRODUCTION_ORIGIN}/brand/email/sky-banner.jpg" width="472" alt="What if we stopped building for people and built with them instead?" `
  + 'style="display:block;width:100%;max-width:472px;height:auto;border:0;border-radius:12px">';
const CHANGE_CARD = `<img src="${PRODUCTION_ORIGIN}/brand/email/change-card.png" width="472" alt="A change card with three parts: what, where, why." `
  + 'style="display:block;width:100%;max-width:472px;height:auto;border:0;border-radius:12px;margin:0 0 16px">';
const EVAN_PHOTO = `<p style="margin:0 0 16px"><img src="${PRODUCTION_ORIGIN}/brand/email/evan-photo-placeholder.png" width="56" height="56" alt="Evan" `
  + 'style="display:block;width:56px;height:56px;border:0;border-radius:28px"></p>';
const DRIP_TILE = 'border:2px solid #000000;border-radius:16px;padding:16px;text-align:left';

const SEEDS = {
  layouts: [
    { name: STANDARD_LAYOUT, html: STANDARD_LAYOUT_HTML, text: '{{content}}' },
    { name: PLAIN_LAYOUT, html: PLAIN_LAYOUT_HTML, text: '{{content}}' },
  ],
  templates: {
    otp: {
      name: ACTIONS.otp.label,
      layout: STANDARD_LAYOUT,
      subject: `Your Homeroom login code`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<p>Your Homeroom login code is:</p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It expires in 10 minutes. If you did not request it, you can ignore this email.</p>`,
      text: `Your Homeroom login code is {{code}}.\n\n`
        + `It expires in 10 minutes. If you did not request it, you can ignore this email.`,
    },

    account_email: {
      name: ACTIONS.account_email.label,
      layout: STANDARD_LAYOUT,
      subject: `Verify your account email`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<p>Enter this code in Settings → Email & recovery to link this address to your account:</p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.</p>`,
      text: `Your account email verification code is {{code}}.\n\n`
        + `Enter it in Settings → Email & recovery to link this address to your account. It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.`,
    },

    username_change: {
      name: ACTIONS.username_change.label,
      layout: STANDARD_LAYOUT,
      subject: `Confirm your new username`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<p>Enter this code in Settings, Account, Username to confirm your new username:</p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It expires in 10 minutes. Never share this code. If you did not ask to change your username, ignore this email and nothing will change.</p>`,
      text: `Your code to confirm a username change is {{code}}.\n\n`
        + `Enter it in Settings, Account, Username. It expires in 10 minutes. Never share this code. If you did not ask to change your username, ignore this email and nothing will change.`,
    },

    waitlist_joined: {
      name: ACTIONS.waitlist_joined.label,
      layout: STANDARD_LAYOUT,
      subject: `You're on the Homeroom waitlist 🎉`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `{{#if hasCode}}<p><strong>Confirm your email</strong></p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It works for 15 minutes.</p>{{/if}}`
        + `<p>Thanks for joining the Homeroom waitlist.</p>`
        + `<p>We'll email you at this address as soon as your access is ready.</p>`
        + `<p>Early access opens in small groups, with more groups opening on a rolling basis after that.</p>`
        + `{{#if hasConfirmUrl}}<p><a href="{{confirmUrl}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Confirm my email</a></p>{{/if}}`,
      text: `{{#if hasCode}}Confirm your email\nYour verification code is {{code}}. It works for 15 minutes.\n\n{{/if}}`
        + `Thanks for joining the Homeroom waitlist.\n\n`
        + `We'll email you at this address as soon as your access is ready.\n\n`
        + `Early access opens in small groups, with more groups opening on a rolling basis after that.`
        + `{{#if hasConfirmUrl}}\n\n`
        + `Or confirm in one tap:\n{{confirmUrl}}{{/if}}`,
    },

    waitlist_code: {
      name: ACTIONS.waitlist_code.label,
      layout: STANDARD_LAYOUT,
      subject: `{{#if hasCode}}`
        + `{{#if isConfirmed}}Your Homeroom waitlist status code{{else}}`
        + `Your Homeroom waitlist confirmation code{{/if}}{{else}}`
        + `Your Homeroom waitlist address is already confirmed{{/if}}`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `{{#if hasCode}}`
        + `{{#if isConfirmed}}<p>Your Homeroom waitlist status code is:</p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It works for 15 minutes. Any earlier code has stopped working, so use this one.</p>`
        + `{{#if hasStatusUrl}}<p><a href="{{statusUrl}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Check my status</a></p>{{/if}}`
        + `<p>If you did not ask for this, you can ignore this email.</p>{{else}}`
        + `<p>Your Homeroom waitlist confirmation code is:</p>`
        + `<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>`
        + `<p>It works for 15 minutes. Any earlier code has stopped working, so use this one.</p>`
        + `{{#if hasConfirmUrl}}<p><a href="{{confirmUrl}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Confirm my email</a></p>{{/if}}`
        + `<p>If you did not ask for this, you can ignore this email.</p>{{/if}}{{else}}`
        + `<p>You asked for a new confirmation code for the Homeroom waitlist.</p>`
        + `<p>This address is already confirmed, so there is nothing left to do. You're on the list and we'll email you when your spot opens.</p>`
        + `{{#if hasStatusUrl}}<p>Check where you stand: <a href="{{statusUrl}}" style="color:#0a6ee0">{{statusUrl}}</a></p>{{/if}}{{/if}}`,
      text: `{{#if hasCode}}`
        + `{{#if isConfirmed}}Your Homeroom waitlist status code is {{code}}. It works for 15 minutes.\n\n`
        + `Any earlier code has stopped working, so use this one.`
        + `{{#if hasStatusUrl}}\n\n`
        + `Enter it here:\n{{statusUrl}}{{/if}}\n\n`
        + `If you did not ask for this, you can ignore this email.{{else}}`
        + `Your Homeroom waitlist confirmation code is {{code}}. It works for 15 minutes.\n\n`
        + `Any earlier code has stopped working, so use this one.`
        + `{{#if hasConfirmUrl}}\n\n`
        + `Or confirm in one tap:\n{{confirmUrl}}{{/if}}\n\n`
        + `If you did not ask for this, you can ignore this email.{{/if}}{{else}}`
        + `You asked for a new confirmation code for the Homeroom waitlist.\n\n`
        + `This address is already confirmed, so there is nothing left to do. You're on the list and we'll email you when your spot opens.`
        + `{{#if hasStatusUrl}}\n\n`
        + `Check where you stand: {{statusUrl}}{{/if}}{{/if}}`,
    },

    waitlist_released: {
      name: ACTIONS.waitlist_released.label,
      layout: STANDARD_LAYOUT,
      subject: `You're in. Make your first app on Homeroom`,
      preheader: `Make and share apps with groups and friends. Here's how to get started.`,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center"><img src="${PRODUCTION_ORIGIN}/brand/people.png" width="200" height="150" alt="" style="display:block;margin:0 auto;border:0;max-width:100%;height:auto"><p style="margin:20px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">You're in</p>`
        + `<p style="margin:10px 0 0;font-size:28px;line-height:32px;font-weight:800;color:#1c1c1e">Make and share apps with groups and friends.</p>`
        + `{{#if hasAccount}}<p style="margin:10px 0 0;font-size:16px;line-height:22px;color:#68686c">Your account now has access. Sign in with your waitlist email.</p>{{else}}`
        + `<p style="margin:10px 0 0;font-size:15px;line-height:22px;color:#1c1c1e">Start building, invite your people, or explore what others are making.</p>{{/if}}`
        + `<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">`
        + `{{#if hasAccount}}Sign in{{else}}`
        + `Get started{{/if}}</a></p>`
        + `{{#if needsCodeNote}}<p style="margin:10px 0 0;font-size:13px;color:#68686c">Opening it emails you a 6-digit code to sign in with. The code expires in 10 minutes.</p>{{/if}}</td></tr></table>`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:24px 0 8px;border:1px solid #0b0b0c;box-shadow:2px 2px 4px rgba(161,152,152,0.25)"><tr><td width="34" height="34" bgcolor="#3484fc" style="width:34px;height:34px;background:#3484fc">&nbsp;</td><td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:#1c1c1e">Make an app with your friends</td></tr></table>`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0px 0 8px;border:1px solid #0b0b0c;box-shadow:2px 2px 4px rgba(161,152,152,0.25)"><tr><td width="34" height="34" bgcolor="#8bd669" style="width:34px;height:34px;background:#8bd669">&nbsp;</td><td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:#1c1c1e">Build an app for your community</td></tr></table>`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0px 0 8px;border:1px solid #0b0b0c;box-shadow:2px 2px 4px rgba(161,152,152,0.25)"><tr><td width="34" height="34" bgcolor="#fc5750" style="width:34px;height:34px;background:#fc5750">&nbsp;</td><td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:#1c1c1e">Join and help shape other community-owned apps</td></tr></table>`
        + `{{#if hasMobile}}<p style="margin:24px 0 8px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#68686c">Try it on mobile</p>`
        + `{{#if hasIos}}<p style="margin:0 0 8px"><strong>iPhone</strong>: <a href="{{iosLink}}" style="color:#0a6ee0">Get Homeroom on the App Store</a>.</p>{{/if}}`
        + `{{#if hasAndroid}}<p style="margin:0 0 8px"><strong>Android</strong>: <a href="{{androidLink}}" style="color:#0a6ee0">Get Homeroom on Google Play</a>.</p>{{/if}}{{/if}}`
        + `<p>See you there,<br>Evan from Homeroom</p>`,
      text: `You're in.\nMake and share apps with groups and friends.\n\n`
        + `{{#if hasAccount}}Your account now has access. Sign in with your waitlist email.{{else}}`
        + `Start building, invite your people, or explore what others are making.\n\n`
        + `Get started:{{/if}}\n{{url}}`
        + `{{#if needsCodeNote}}\n\n`
        + `Opening it emails you a 6-digit code to sign in with. The code expires in 10 minutes.{{/if}}\n\n`
        + `- Make an app with your friends\n- Build an app for your community\n- Join and help shape other community-owned apps`
        + `{{#if hasMobile}}\n\n`
        + `Try it on mobile`
        + `{{#if hasIos}}\niPhone: Get Homeroom on the App Store ({{iosLink}}).{{/if}}`
        + `{{#if hasAndroid}}\nAndroid: Get Homeroom on Google Play ({{androidLink}}).{{/if}}{{/if}}\n\n`
        + `See you there,\nEvan from Homeroom`,
    },

    // The two reminders to somebody let in who has not signed in
    // (services/waitlist-reminders.js). Their button is the admit mail's.
    waitlist_reminder: {
      name: ACTIONS.waitlist_reminder.label,
      layout: STANDARD_LAYOUT,
      subject: `You're in! Come see what we're building.`,
      preheader: `Start an app, invite your friends, or jump into something already made.`,
      why: `You are receiving this because you were let in from the waitlist and haven't signed in yet. We send one more reminder, then stop.`
        + `{{#if hasUnsubscribeUrl}} <a href="{{unsubscribeUrl}}" style="color:#68686c">Stop these reminders</a>{{/if}}`,
      html: `${REMINDER_P}Hey!</p>`
        + `${REMINDER_P}Just a quick reminder that you're off the Homeroom waitlist!</p>`
        + `${REMINDER_P}You can start an app with AI, invite your friends to help shape it, or jump into something someone else has already made.</p>`
        + `${REMINDER_P}No big project needed. Start with something small and see where it goes.</p>`
        + `{{#if hasAccount}}${REMINDER_P}Sign in with the email this was sent to.</p>{{/if}}`
        + REMINDER_BUTTON
        + `${REMINDER_P}See you in there,<br>Evan</p>`,
      text: `Hey!\n\n`
        + `Just a quick reminder that you're off the Homeroom waitlist!\n\n`
        + `You can start an app with AI, invite your friends to help shape it, or jump into something someone else has already made.\n\n`
        + `No big project needed. Start with something small and see where it goes.\n\n`
        + `{{#if hasAccount}}Sign in with the email this was sent to.\n\n{{/if}}`
        + REMINDER_TEXT_BUTTON
        + `See you in there,\nEvan`
        + `{{#if hasUnsubscribeUrl}}\n\nStop these reminders: {{unsubscribeUrl}}{{/if}}`,
    },

    waitlist_reminder_last: {
      name: ACTIONS.waitlist_reminder_last.label,
      layout: STANDARD_LAYOUT,
      subject: `One last nudge 👋`,
      preheader: `Your Homeroom invite is ready whenever you are.`,
      why: `You are receiving this because you were let in from the waitlist and haven't signed in yet. This is the last reminder.`,
      html: `${REMINDER_P}Hey!</p>`
        + `${REMINDER_P}Just wanted to send one last reminder that your Homeroom invite is ready.</p>`
        + `${REMINDER_P}We're building Homeroom around a simple idea: apps shouldn't just be made for people. The people using them should be able to help make them better, too.</p>`
        + `${REMINDER_P}And we'd love for you to be part of that.</p>`
        + REMINDER_BUTTON
        + `${REMINDER_P}{{#if hasAccount}}You can sign in any time with the email this was sent to.{{else}}`
        + `{{#if hasLinkUntil}}This button works until {{linkUntil}}, but you can still sign in with this email anytime afterward.{{else}}`
        + `You can sign in any time with this email.{{/if}}{{/if}}</p>`
        + `${REMINDER_P}And if now's not the right time, no worries. We won't keep sending reminders.</p>`
        + `${REMINDER_P}Hope to see you around,<br>Evan</p>`,
      text: `Hey!\n\n`
        + `Just wanted to send one last reminder that your Homeroom invite is ready.\n\n`
        + `We're building Homeroom around a simple idea: apps shouldn't just be made for people. The people using them should be able to help make them better, too.\n\n`
        + `And we'd love for you to be part of that.\n\n`
        + REMINDER_TEXT_BUTTON
        + `{{#if hasAccount}}You can sign in any time with the email this was sent to.{{else}}`
        + `{{#if hasLinkUntil}}This link works until {{linkUntil}}, but you can still sign in with this email anytime afterward.{{else}}`
        + `You can sign in any time with this email.{{/if}}{{/if}}\n\n`
        + `And if now's not the right time, no worries. We won't keep sending reminders.\n\n`
        + `Hope to see you around,\nEvan`,
    },

    password_reset: {
      name: ACTIONS.password_reset.label,
      layout: STANDARD_LAYOUT,
      subject: `Reset your Homeroom password`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<p>Someone asked to reset the password for the Homeroom account with this email address.</p>`
        + `<p><a href="{{url}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Set a new password</a></p>`
        + `<p>If the button does not work, copy this address into your browser: <a href="{{url}}" style="color:#0a6ee0">{{url}}</a></p>`
        + `<p>The link expires in 30 minutes and works once. If you did not request this, you can ignore it. Your password is unchanged.</p>`,
      text: `Someone asked to reset the password for the Homeroom account with this email address.\n\n`
        + `Set a new password here: {{url}}\n\n`
        + `The link expires in 30 minutes and works once. If you did not request this, you can ignore it. Your password is unchanged.`,
    },

    admin_test: {
      name: ACTIONS.admin_test.label,
      layout: STANDARD_LAYOUT,
      subject: `Homeroom test email`,
      preheader: ``,
      why: `You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center"><p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">Test email</p>`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">This is a test email from the Homeroom platform admin console.</p></td></tr></table>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:20px 0 0;border:1px solid #e3e3e6;border-radius:12px"><tbody><tr><td style="font-size:14px;line-height:1.5;padding:6px 12px;color:#68686c">Provider</td><td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right"><strong>{{provider}}</strong></td></tr>`
        + `<tr><td style="font-size:14px;line-height:1.5;padding:6px 12px;color:#68686c;border-top:1px solid #e3e3e6">Sent as</td><td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right">{{from}}</td></tr>`
        + `<tr><td style="font-size:14px;line-height:1.5;padding:6px 12px;color:#68686c;border-top:1px solid #e3e3e6">Sent at</td><td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right">{{sentAt}}</td></tr>`
        + `<tr><td style="font-size:14px;line-height:1.5;padding:6px 12px;color:#68686c;border-top:1px solid #e3e3e6">Reference</td><td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right"><code>{{reference}}</code></td></tr>`
        + `</tbody></table>`
        + `<p style="margin:16px 0 0;text-align:center;font-size:13px;color:#68686c">An administrator sent it to check that outbound email works. No action is needed.</p>`,
      text: `This is a test email from the Homeroom platform admin console.\n\n`
        + `Provider: {{provider}}\nSent as: {{from}}\nSent at: {{sentAt}}\nReference: {{reference}}\n\n`
        + `An administrator sent it to check that outbound email works. No action is needed.`,
    },

    content_report: {
      name: ACTIONS.content_report.label,
      layout: STANDARD_LAYOUT,
      subject: `{{subject}}`,
      preheader: `New {{reason}} report on {{targetLabel}}`,
      why: `You are receiving this because this address is Homeroom's compliance inbox for content reports.`,
      html: `<p>A new report was submitted on Homeroom.</p>`
        + `<p>Reason: <strong>{{reason}}</strong><br>Reported: {{typeLabel}} · {{targetLabel}}<br>Reporter: {{reporter}}<br>Case #{{caseId}} · Report #{{reportId}}</p>`
        + `<p>Details from the reporter:</p>`
        + `<p style="white-space:pre-wrap">{{detail}}</p>`
        + `<p><a href="{{url}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Open in Moderation</a></p>`,
      text: `A new report was submitted on Homeroom.\n\n`
        + `Reason: {{reason}}\nReported: {{typeLabel}} · {{targetLabel}}\nReporter: {{reporter}}\nCase #{{caseId}} · Report #{{reportId}}\n\n`
        + `Details from the reporter:\n{{detail}}\n\n`
        + `Open in Moderation: {{url}}`,
    },

    release_hold: {
      name: ACTIONS.release_hold.label,
      layout: STANDARD_LAYOUT,
      subject: `{{#if held}}⚠️ Approval needed: {{title}}{{else}}{{#if asks}}{{#if hasApp}}{{app}} now asks for a device capability: {{title}}{{else}}A change asks for a device capability: {{title}}{{/if}}{{else}}{{#if unread}}Not read in full: {{title}}{{else}}For your information: {{title}}{{/if}}{{/if}}{{/if}}`,
      preheader: `{{#if held}}{{#if hasApp}}A change in {{app}} is held until an admin votes yes.{{else}}A change is held until an admin votes yes.{{/if}}`
        + `{{else}}{{#if asks}}{{#if hasApp}}A change in {{app}} asks for a device capability. It is not held.{{else}}A change asks for a device capability. It is not held.{{/if}}`
        + `{{else}}{{#if unread}}{{#if hasApp}}A change in {{app}} was too large to read in full. It is not held.{{else}}A change was too large to read in full. It is not held.{{/if}}`
        + `{{else}}{{#if hasApp}}A change in {{app}} is not held. Here is what it does.{{else}}A change is not held. Here is what it does.{{/if}}{{/if}}{{/if}}{{/if}}`,
      why: `You are receiving this because you are an administrator of Homeroom, and `
        + `{{#if held}}a change is waiting for an administrator's approval.{{else}}{{#if asks}}a change asks for a device capability.{{else}}{{#if unread}}Homeroom could not read a change in full.{{else}}a change does something administrators are told about.{{/if}}{{/if}}{{/if}}`,
      html: `{{#if held}}`
        + `<p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#a85f00">⚠️ Held for an admin</p>`
        + `<p><strong>{{title}}</strong>{{#if hasApp}} in {{app}}{{/if}}{{#if hasAuthor}}, by {{author}},{{/if}} cannot go live until an administrator approves it.</p>`
        + `<p>Why it is held: {{reasons}}</p>`
        + `<p>Vote yes on the change to let it through once its votes and checks allow. Vote no, with a reason, to close it and the request it was built for. Without an answer it stays held.</p>`
        + `<p><a href="{{url}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Review the change</a></p>`
        + `{{else}}`
        + `<p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#5f6673">For your information</p>`
        + `<p><strong>{{title}}</strong>{{#if hasApp}} in {{app}}{{/if}}{{#if hasAuthor}}, by {{author}},{{/if}} is not held. It goes live on its votes and checks, like any other change.</p>`
        + `<p>Why you are told: {{reasons}}</p>`
        + `{{#if asks}}<p>Nobody's camera, microphone or location is reached by this alone: each person is asked before the app can use it, and chooses Allow this time, Always allow or Not now. You do not need to do anything.</p>{{/if}}`
        + `{{#if unread}}<p>Homeroom's risk rules read only the first part of it, most often because it includes a large built file. You do not need to do anything. Open the change if you want to look at the rest.</p>{{/if}}`
        + `{{#if asks}}{{else}}{{#if unread}}{{else}}<p>You do not need to do anything. Open the change if you want to look at it.</p>{{/if}}{{/if}}`
        + `<p><a href="{{url}}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0a6ee0;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Open the change</a></p>`
        + `{{/if}}`,
      text: `{{#if held}}`
        + `Held for an admin\n\n`
        + `{{title}}{{#if hasApp}} in {{app}}{{/if}}{{#if hasAuthor}}, by {{author}},{{/if}} cannot go live until an administrator approves it.\n\n`
        + `Why it is held: {{reasons}}\n\n`
        + `Vote yes on the change to let it through once its votes and checks allow. Vote no, with a reason, to close it and the request it was built for. Without an answer it stays held.\n\n`
        + `Review the change: {{url}}`
        + `{{else}}`
        + `For your information\n\n`
        + `{{title}}{{#if hasApp}} in {{app}}{{/if}}{{#if hasAuthor}}, by {{author}},{{/if}} is not held. It goes live on its votes and checks, like any other change.\n\n`
        + `Why you are told: {{reasons}}\n\n`
        + `{{#if asks}}Nobody's camera, microphone or location is reached by this alone: each person is asked before the app can use it, and chooses Allow this time, Always allow or Not now. You do not need to do anything.\n\n{{/if}}`
        + `{{#if unread}}Homeroom's risk rules read only the first part of it, most often because it includes a large built file. You do not need to do anything. Open the change if you want to look at the rest.\n\n{{/if}}`
        + `{{#if asks}}{{else}}{{#if unread}}{{else}}You do not need to do anything. Open the change if you want to look at it.\n\n{{/if}}{{/if}}`
        + `Open the change: {{url}}`
        + `{{/if}}`,
    },

    project_invite: {
      name: ACTIONS.project_invite.label,
      layout: STANDARD_LAYOUT,
      subject: `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}} on Homeroom{{else}}`
        + `@{{inviter}} invited you to a project on Homeroom{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}} on Homeroom{{else}}`
        + `Someone invited you to a project on Homeroom{{/if}}{{/if}}`,
      preheader: ``,
      why: `You are receiving this because someone on Homeroom invited this address to a project. You will not hear from us again unless you join, or somebody invites you again.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center"><p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">You're invited</p>`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">`
        + `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}}.{{else}}`
        + `@{{inviter}} invited you to a project.{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}}.{{else}}`
        + `Someone invited you to a project.{{/if}}{{/if}}</p>`
        + `<p style="margin:10px 0 0;font-size:16px;line-height:22px;color:#68686c">It's a private community on Homeroom, where communities build the apps they use together. Join the waitlist with this email address. Once you are in, the invite will be waiting for you.</p>`
        + `{{#if hasUrl}}<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">Join the waitlist</a></p>{{/if}}`
        + `<p style="margin:16px 0 0;font-size:13px;color:#68686c">If you were not expecting this, you can ignore this email.</p></td></tr></table>`,
      text: `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}}, a private community on Homeroom, where communities build the apps they use together.{{else}}`
        + `@{{inviter}} invited you to a project, a private community on Homeroom, where communities build the apps they use together.{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}}, a private community on Homeroom, where communities build the apps they use together.{{else}}`
        + `Someone invited you to a project, a private community on Homeroom, where communities build the apps they use together.{{/if}}{{/if}}\n\n`
        + `Join the waitlist with this email address. Once you are in, the invite will be waiting for you.`
        + `{{#if hasUrl}}\n\n`
        + `{{url}}{{/if}}\n\n`
        + `If you were not expecting this, you can ignore this email.`,
    },

    build_ready: {
      name: ACTIONS.build_ready.label,
      layout: STANDARD_LAYOUT,
      subject: `{{subject}}`,
      preheader: `{{lead}}`,
      why: `You are receiving this because there was news on Homeroom for you and no phone to send it to. Turn these emails off with the link above.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center"><p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">{{app}}</p>`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">{{lead}}</p>`
        + `<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">Open it</a></p>`
        + `{{#if hasUnsubscribeUrl}}<p style="margin:16px 0 0;font-size:13px"><a href="{{unsubscribeUrl}}" style="color:#68686c">Stop these emails</a></p>{{/if}}</td></tr></table>`,
      text: `{{lead}}\n\nOpen it: {{url}}`
        + `{{#if hasUnsubscribeUrl}}\n\n`
        + `To stop these emails: {{unsubscribeUrl}}{{/if}}`,
    },

    invite_activity: {
      name: ACTIONS.invite_activity.label,
      layout: STANDARD_LAYOUT,
      subject: `{{subject}}`,
      preheader: `{{line}}`,
      why: `You are receiving this because there was news on Homeroom for you and no phone to send it to. Turn these emails off with the link above.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center">`
        + `{{#if hasApp}}<p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">{{app}}</p>{{/if}}`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">{{line}}</p>`
        + `<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">`
        + `{{#if hasApp}}Open {{app}}{{else}}`
        + `Open your project{{/if}}</a></p>`
        + `{{#if hasUnsubscribeUrl}}<p style="margin:16px 0 0;font-size:13px"><a href="{{unsubscribeUrl}}" style="color:#68686c">Stop these emails</a></p>{{/if}}</td></tr></table>`,
      text: `{{line}}\n\n{{#if hasApp}}Open {{app}}: {{url}}{{else}}`
        + `Open your project: {{url}}{{/if}}`
        + `{{#if hasUnsubscribeUrl}}\n\n`
        + `To stop these emails: {{unsubscribeUrl}}{{/if}}`,
    },

    project_opened: {
      name: ACTIONS.project_opened.label,
      layout: STANDARD_LAYOUT,
      subject: `{{#if hasApp}}{{app}} is open{{else}}`
        + `A project you joined is open{{/if}}`,
      preheader: `{{#if hasApp}}{{app}} is ready to use. Take a look.{{else}}`
        + `A project you joined is ready to use. Take a look.{{/if}}`,
      why: `You are receiving this because there was news on Homeroom for you and no phone to send it to. Turn these emails off with the link above.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center">`
        + `{{#if hasApp}}<p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">{{app}}</p>{{/if}}`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">`
        + `{{#if hasApp}}{{app}} is ready to use. Take a look.{{else}}`
        + `A project you joined is ready to use. Take a look.{{/if}}</p>`
        + `<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">Open it</a></p>`
        + `{{#if hasUnsubscribeUrl}}<p style="margin:16px 0 0;font-size:13px"><a href="{{unsubscribeUrl}}" style="color:#68686c">Stop these emails</a></p>{{/if}}</td></tr></table>`,
      text: `{{#if hasApp}}{{app}} is ready to use. Take a look.{{else}}`
        + `A project you joined is ready to use. Take a look.{{/if}}\n\n`
        + `Open it: {{url}}`
        + `{{#if hasUnsubscribeUrl}}\n\n`
        + `To stop these emails: {{unsubscribeUrl}}{{/if}}`,
    },

    app_slots_granted: {
      name: ACTIONS.app_slots_granted.label,
      layout: STANDARD_LAYOUT,
      subject: `{{#if oneTotal}}You have 1 app slot now{{else}}`
        + `You have {{total}} app slots now{{/if}}`,
      preheader: `{{#if oneAdded}}You have 1 more app slot. Take a look.{{else}}`
        + `You have {{added}} more app slots. Take a look.{{/if}}`,
      why: `You are receiving this because an admin changed your app slots on Homeroom. Turn these emails off with the link above.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center">`
        + `<p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">App slots</p>`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">`
        + `{{#if oneAdded}}You have 1 more app slot{{else}}`
        + `You have {{added}} more app slots{{/if}}</p>`
        + `<p style="margin:12px 0 0;font-size:15px;line-height:22px;color:#3a3a3c">`
        + `{{#if hasUsername}}Hi {{username}}, {{else}}Hi, {{/if}}`
        + `an admin gave you {{#if oneAdded}}1 more app slot{{else}}{{added}} more app slots{{/if}}. `
        + `You can now have {{#if oneTotal}}1 app{{else}}{{total}} apps{{/if}} on Homeroom.</p>`
        + `<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">Open Homeroom</a></p>`
        + `{{#if hasUnsubscribeUrl}}<p style="margin:16px 0 0;font-size:13px"><a href="{{unsubscribeUrl}}" style="color:#68686c">Stop these emails</a></p>{{/if}}</td></tr></table>`,
      text: `{{#if oneAdded}}You have 1 more app slot{{else}}`
        + `You have {{added}} more app slots{{/if}}\n\n`
        + `{{#if hasUsername}}Hi {{username}}, {{else}}Hi, {{/if}}`
        + `an admin gave you {{#if oneAdded}}1 more app slot{{else}}{{added}} more app slots{{/if}}. `
        + `You can now have {{#if oneTotal}}1 app{{else}}{{total}} apps{{/if}} on Homeroom.\n\n`
        + `Open Homeroom: {{url}}`
        + `{{#if hasUnsubscribeUrl}}\n\n`
        + `To stop these emails: {{unsubscribeUrl}}{{/if}}`,
    },

    // ── The drip: seeded as drafts (see "The drip" above) ─────────────

    drip_welcome: {
      name: ACTIONS.drip_welcome.label,
      layout: PLAIN_LAYOUT,
      subject: `hey, evan from homeroom here`,
      preheader: `anything i can help with?`,
      why: `You are receiving this because you just made a Homeroom account.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}{{#if first_name}}Hi {{first_name}}!{{else}}Hey!{{/if}} Thanks for joining Homeroom.</p>`
        + `${DRIP_P}I'm Evan, the co-founder. A few things:</p>`
        + `${DRIP_UL}${DRIP_LI}Homeroom is built for groups. Anyone can describe a change in plain words, everyone previews it, and the group votes on what ships.</li>`
        + `${DRIP_LI}The fastest way to see how it all works is to open a project and suggest one tiny change. A color. A button. A joke on the homepage.</li>`
        + `${DRIP_LI}It's early, and some things will be rough. When something feels weird, tell me. Screenshots help a lot.</li></ul>`
        + `${DRIP_P}And the why behind all this: we're trying to build a different kind of place on the internet. One that feels like the old one, where you could explore, tinker and make things with people. Except this time, you get to shape the apps you use, not just consume them.</p>`
        + `${DRIP_P}Hope you like it! If we can make anything better, let me know. I read every reply (me, not the Homeroom bot lol).</p>`
        + `${DRIP_BUTTON_OPEN}Open Homeroom${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}Evan</p>`
        + EVAN_PHOTO
        + `${DRIP_P}P.S. What would you build if your friends could help? Feel free to reply. I'm collecting ideas.</p>`,
      text: `{{#if first_name}}Hi {{first_name}}!{{else}}Hey!{{/if}} Thanks for joining Homeroom.\n\n`
        + `I'm Evan, the co-founder. A few things:\n\n`
        + `- Homeroom is built for groups. Anyone can describe a change in plain words, everyone previews it, and the group votes on what ships.\n`
        + `- The fastest way to see how it all works is to open a project and suggest one tiny change. A color. A button. A joke on the homepage.\n`
        + `- It's early, and some things will be rough. When something feels weird, tell me. Screenshots help a lot.\n\n`
        + `And the why behind all this: we're trying to build a different kind of place on the internet. One that feels like the old one, where you could explore, tinker and make things with people. Except this time, you get to shape the apps you use, not just consume them.\n\n`
        + `Hope you like it! If we can make anything better, let me know. I read every reply (me, not the Homeroom bot lol).\n\n`
        + `Open Homeroom: {{url}}\n\n`
        + `Evan\n\n`
        + `P.S. What would you build if your friends could help? Feel free to reply. I'm collecting ideas.\n\n`
        + `You are receiving this because you just made a Homeroom account.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_no_project: {
      name: ACTIONS.drip_no_project.label,
      layout: STANDARD_LAYOUT,
      subject: `Homeroom is more fun together`,
      preheader: `two easy ways to get started`,
      why: `You are receiving this because you signed up for Homeroom.${DRIP_UNSUBSCRIBE}`,
      html: `<p style="margin:0 0 20px">${SKY_BANNER}</p>`
        + `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}You signed in a couple of days ago and then life happened. Totally fair.</p>`
        + `${DRIP_P}Here's the thing. Homeroom gets good once you're in a room with other people making something. Two easy ways in:</p>`
        + `${DRIP_UL}${DRIP_LI}Peek at what people are already building and join one that looks fun.</li>`
        + `${DRIP_LI}Start your own and bring two friends. A silly idea is fine. Silly ideas are usually the most fun to build.</li></ul>`
        + `${DRIP_BUTTON_OPEN}Find something to build${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `You signed in a couple of days ago and then life happened. Totally fair.\n\n`
        + `Here's the thing. Homeroom gets good once you're in a room with other people making something. Two easy ways in:\n\n`
        + `- Peek at what people are already building and join one that looks fun.\n`
        + `- Start your own and bring two friends. A silly idea is fine. Silly ideas are usually the most fun to build.\n\n`
        + `Find something to build: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you signed up for Homeroom.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_suggest_change: {
      name: ACTIONS.drip_suggest_change.label,
      layout: STANDARD_LAYOUT,
      subject: `the trick to a change people say yes to`,
      preheader: `say what, say where, say why`,
      why: `You are receiving this because you joined {{app}} on Homeroom.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}You joined {{app}}. Nice. Here's the easiest way to make your mark:</p>`
        + `${DRIP_UL}${DRIP_LI}<strong>Say what.</strong> "Make the sign-up button bigger."</li>`
        + `${DRIP_LI}<strong>Say where.</strong> "On the home page, under the photo."</li>`
        + `${DRIP_LI}<strong>Say why.</strong> "People keep missing it."</li></ul>`
        + CHANGE_CARD
        + `${DRIP_P}The why is the part most people skip, and it's what the group reads before they vote.</p>`
        + `${DRIP_P}No code, just plain words. Then everyone previews it and votes.</p>`
        + `${DRIP_P}Not ready to suggest anything? Vote on someone else's change. That counts too.</p>`
        + `${DRIP_BUTTON_OPEN}Suggest a change in {{app}}${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `You joined {{app}}. Nice. Here's the easiest way to make your mark:\n\n`
        + `- Say what. "Make the sign-up button bigger."\n`
        + `- Say where. "On the home page, under the photo."\n`
        + `- Say why. "People keep missing it."\n\n`
        + `The why is the part most people skip, and it's what the group reads before they vote.\n\n`
        + `No code, just plain words. Then everyone previews it and votes.\n\n`
        + `Not ready to suggest anything? Vote on someone else's change. That counts too.\n\n`
        + `Suggest a change in {{app}}: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you joined {{app}} on Homeroom.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_change_vote: {
      name: ACTIONS.drip_change_vote.label,
      layout: STANDARD_LAYOUT,
      subject: `your change is up for a vote`,
      preheader: `here's how to get it over the line`,
      why: `You are receiving this because you suggested a change in {{app}}.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}Your change is in front of {{app}} right now. People are previewing it and voting.</p>`
        + `${DRIP_P}You're past the hardest part. A few things help it ship:</p>`
        + `${DRIP_UL}${DRIP_LI}Share it in the project chat and say why you made it.</li>`
        + `${DRIP_LI}Read what people say about it. A small tweak often turns a no into a yes.</li>`
        + `${DRIP_LI}While you wait, vote on someone else's change. You'll get a feel for what the group likes.</li></ul>`
        + `${DRIP_BUTTON_OPEN}See your change${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `Your change is in front of {{app}} right now. People are previewing it and voting.\n\n`
        + `You're past the hardest part. A few things help it ship:\n\n`
        + `- Share it in the project chat and say why you made it.\n`
        + `- Read what people say about it. A small tweak often turns a no into a yes.\n`
        + `- While you wait, vote on someone else's change. You'll get a feel for what the group likes.\n\n`
        + `See your change: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you suggested a change in {{app}}.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_change_failed: {
      name: ACTIONS.drip_change_failed.label,
      layout: STANDARD_LAYOUT,
      subject: `didn't make it this time. that's normal.`,
      preheader: `don't start over. try this.`,
      why: `You are receiving this because you suggested a change in {{app}}.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}Your change in {{app}} didn't pass this time. It happens, and it's not personal.</p>`
        + `${DRIP_P}Don't start over. Usually one of these does it:</p>`
        + `${DRIP_UL}${DRIP_LI}<strong>Make it smaller.</strong> If your change did a few things at once, people may have liked some parts and not others. Split it into smaller changes so the good parts can pass on their own.</li>`
        + `${DRIP_LI}<strong>Ask the room.</strong> Post in the project chat: "what would make this a yes?"</li>`
        + `${DRIP_LI}<strong>Lead with the why.</strong> Suggest it again and start with the reason.</li></ul>`
        + `${DRIP_BUTTON_OPEN}Try again in {{app}}${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `Your change in {{app}} didn't pass this time. It happens, and it's not personal.\n\n`
        + `Don't start over. Usually one of these does it:\n\n`
        + `- Make it smaller. If your change did a few things at once, people may have liked some parts and not others. Split it into smaller changes so the good parts can pass on their own.\n`
        + `- Ask the room. Post in the project chat: "what would make this a yes?"\n`
        + `- Lead with the why. Suggest it again and start with the reason.\n\n`
        + `Try again in {{app}}: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you suggested a change in {{app}}.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_change_live: {
      name: ACTIONS.drip_change_live.label,
      layout: PLAIN_LAYOUT,
      subject: `your idea is live`,
      preheader: `the group said yes`,
      why: `You are receiving this because a change you suggested went live.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}{{#if first_name}}Hey {{first_name}}, Evan here.{{else}}Hey! Evan here.{{/if}}</p>`
        + `${DRIP_P}Just saw your change go live in {{app}} -- the group voted it in. People are using something you came up with right now.</p>`
        + `${DRIP_P}That's pretty much the whole reason we built Homeroom, and tbh it still gets me every time.</p>`
        + `${DRIP_P}Small ask, only if you feel like it: would you <a href="https://x.com/intent/post?text=%40onhomeroom%20" style="color:#1c1c1e;text-decoration:underline">share a bit about your experience so far on X</a>? What you changed, what's been fun, what's been weird. Honest beats nice.</p>`
        + `${DRIP_P}Or if you'd rather just tell me, hit reply. I read all of them.</p>`
        + `${DRIP_P}Evan</p>`,
      text: `{{#if first_name}}Hey {{first_name}}, Evan here.{{else}}Hey! Evan here.{{/if}}\n\n`
        + `Just saw your change go live in {{app}} -- the group voted it in. People are using something you came up with right now.\n\n`
        + `That's pretty much the whole reason we built Homeroom, and tbh it still gets me every time.\n\n`
        + `Small ask, only if you feel like it: would you share a bit about your experience so far on X? What you changed, what's been fun, what's been weird. Honest beats nice.\n`
        + `https://x.com/intent/post?text=%40onhomeroom%20\n\n`
        + `Or if you'd rather just tell me, hit reply. I read all of them.\n\n`
        + `Evan\n\n`
        + `You are receiving this because a change you suggested went live.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_alone: {
      name: ACTIONS.drip_alone.label,
      layout: STANDARD_LAYOUT,
      subject: `{{app}} needs some company`,
      preheader: `building alone is only half the fun`,
      why: `You are receiving this because you made {{app}} on Homeroom.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}You made {{app}} a few days ago. Love that.</p>`
        + `${DRIP_P}Right now it's just you in there. Which is fine! But Homeroom was made for the part where other people show up, suggest things you'd never think of, and vote on what ships.</p>`
        + `${DRIP_P}Think of two people who'd have opinions about {{app}}. Send them the link. Worst case, they say no. Best case, they make it way better than you would alone.</p>`
        + `${DRIP_BUTTON_OPEN}Invite people to {{app}}${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`
        + `<p style="margin:8px 0 0">${SKY_BANNER}</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `You made {{app}} a few days ago. Love that.\n\n`
        + `Right now it's just you in there. Which is fine! But Homeroom was made for the part where other people show up, suggest things you'd never think of, and vote on what ships.\n\n`
        + `Think of two people who'd have opinions about {{app}}. Send them the link. Worst case, they say no. Best case, they make it way better than you would alone.\n\n`
        + `Invite people to {{app}}: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you made {{app}} on Homeroom.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_invite_waiting: {
      name: ACTIONS.drip_invite_waiting.label,
      layout: STANDARD_LAYOUT,
      subject: `nobody's joined {{app}} from your invite yet`,
      preheader: `a quick nudge from you usually does it`,
      why: `You are receiving this because you invited people to {{app}}.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}You shared an invite to {{app}} a few days ago. Nobody's joined through it yet.</p>`
        + `${DRIP_P}Totally normal. Links get lost in busy group chats and inboxes, and people mean to click later.</p>`
        + `${DRIP_P}A quick follow-up from you is what typically gets people in. Something like "hey, did you see this? I'd love your take" goes a long way. Send it however you sent the first one.</p>`
        + `${DRIP_BUTTON_OPEN}Share your invite again${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `You shared an invite to {{app}} a few days ago. Nobody's joined through it yet.\n\n`
        + `Totally normal. Links get lost in busy group chats and inboxes, and people mean to click later.\n\n`
        + `A quick follow-up from you is what typically gets people in. Something like "hey, did you see this? I'd love your take" goes a long way. Send it however you sent the first one.\n\n`
        + `Share your invite again: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you invited people to {{app}}.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_missed: {
      name: ACTIONS.drip_missed.label,
      layout: STANDARD_LAYOUT,
      subject: `here's what you missed in {{app}}`,
      preheader: `some of these votes are close`,
      why: `You are receiving this because you're a member of {{app}}.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}${DRIP_GREETING}</p>`
        + `${DRIP_P}It's been about a week since you were in {{app}}. While you were away:</p>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px"><tr>`
        + `<td width="50%" valign="top" style="padding:0 6px 0 0"><div style="background:#FFFEEA;${DRIP_TILE}">`
        + `<div style="font-size:32px;line-height:38px;font-weight:800;color:#000000">{{changes_shipped}}</div>`
        + `<div style="font-size:14px;line-height:20px;color:#1c1c1e">changes shipped</div></div></td>`
        + `<td width="50%" valign="top" style="padding:0 0 0 6px"><div style="background:#FFEE6F;${DRIP_TILE}">`
        + `<div style="font-size:32px;line-height:38px;font-weight:800;color:#000000">{{changes_waiting}}</div>`
        + `<div style="font-size:14px;line-height:20px;color:#1c1c1e">waiting on votes</div></div></td>`
        + `</tr></table>`
        + `${DRIP_P}No pressure. But the community is better with you in it.</p>`
        + `${DRIP_BUTTON_OPEN}Catch up on {{app}}${DRIP_BUTTON_CLOSE}`
        + `${DRIP_P}The Homeroom team</p>`,
      text: `${DRIP_TEXT_GREETING}\n\n`
        + `It's been about a week since you were in {{app}}. While you were away:\n\n`
        + `- {{changes_shipped}} changes shipped.\n`
        + `- {{changes_waiting}} are waiting on votes, and yours could tip them.\n\n`
        + `No pressure. But the community is better with you in it.\n\n`
        + `Catch up on {{app}}: {{url}}\n\n`
        + `The Homeroom team\n\n`
        + `You are receiving this because you're a member of {{app}}.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_honest_question: {
      name: ACTIONS.drip_honest_question.label,
      layout: PLAIN_LAYOUT,
      subject: `honest question`,
      preheader: `what should we fix?`,
      why: `You are receiving this because you have a Homeroom account.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}{{#if first_name}}Hey {{first_name}}, Evan here.{{else}}Hey! Evan here.{{/if}}</p>`
        + `${DRIP_P}You haven't been on <a href="${PRODUCTION_ORIGIN}/" style="color:#1c1c1e;text-decoration:underline">Homeroom</a> in a few weeks, so I'm guessing something didn't work for you.</p>`
        + `${DRIP_P}I'd really like to know what. We're a small team, and the most useful thing anyone can tell us right now is where we fell short.</p>`
        + `${DRIP_P}Was something confusing? Missing? Did your group go quiet? Whatever it is, big or small, I want to know. Just hit reply. I read every one.</p>`
        + `${DRIP_P}And whenever you want to come back, we'll be right here.</p>`
        + `${DRIP_P}Evan</p>`,
      text: `{{#if first_name}}Hey {{first_name}}, Evan here.{{else}}Hey! Evan here.{{/if}}\n\n`
        + `You haven't been on Homeroom in a few weeks, so I'm guessing something didn't work for you.\n`
        + `${PRODUCTION_ORIGIN}/\n\n`
        + `I'd really like to know what. We're a small team, and the most useful thing anyone can tell us right now is where we fell short.\n\n`
        + `Was something confusing? Missing? Did your group go quiet? Whatever it is, big or small, I want to know. Just hit reply. I read every one.\n\n`
        + `And whenever you want to come back, we'll be right here.\n\n`
        + `Evan\n\n`
        + `You are receiving this because you have a Homeroom account.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },

    drip_monthly: {
      name: ACTIONS.drip_monthly.label,
      layout: PLAIN_LAYOUT,
      subject: `how it's going at homeroom`,
      preheader: `the good and the bad, no filter`,
      why: `You are receiving this because you have a Homeroom account.${DRIP_UNSUBSCRIBE}`,
      html: `${DRIP_P}Hey all, Evan from Homeroom here.</p>`
        + `${DRIP_P}I want to tell you how it's going. The good and the bad.</p>`
        + `${DRIP_P}<strong>The good.</strong> {one or two real wins, with real numbers if we're happy to share them}</p>`
        + `${DRIP_P}<strong>The bad.</strong> {one honest problem, and what we're doing about it}</p>`
        + `${DRIP_P}<strong>What we shipped this month:</strong></p>`
        + `${DRIP_UL}${DRIP_LI}{thing}: {one plain sentence on why it matters}</li>`
        + `${DRIP_LI}{thing}: {one plain sentence}</li>`
        + `${DRIP_LI}{thing}: {one plain sentence}</li></ul>`
        + `${DRIP_P}Shoutout to {teammate} for {what they did}.</p>`
        + `${DRIP_P}Any q's? Just reply. See you in there.</p>`
        + `${DRIP_P}Evan</p>`
        + EVAN_PHOTO
        + `${DRIP_P}P.S. {something human: a teammate's birthday, a project someone built that made us smile, a small ask}</p>`,
      text: `Hey all, Evan from Homeroom here.\n\n`
        + `I want to tell you how it's going. The good and the bad.\n\n`
        + `The good. {one or two real wins, with real numbers if we're happy to share them}\n\n`
        + `The bad. {one honest problem, and what we're doing about it}\n\n`
        + `What we shipped this month:\n\n`
        + `- {thing}: {one plain sentence on why it matters}\n`
        + `- {thing}: {one plain sentence}\n`
        + `- {thing}: {one plain sentence}\n\n`
        + `Shoutout to {teammate} for {what they did}.\n\n`
        + `Any q's? Just reply. See you in there.\n\n`
        + `Evan\n\n`
        + `P.S. {something human: a teammate's birthday, a project someone built that made us smile, a small ask}\n\n`
        + `You are receiving this because you have a Homeroom account.`
        + DRIP_TEXT_UNSUBSCRIBE,
    },
  },

  // Drafts of new versions of emails that are live today, staged for review:
  // each is added once as its action's draft (never live), and an admin puts
  // it live from its editor when it should go out. Keyed by action; `draftName`
  // marks it, so a draft an admin deleted is not added back.
  drafts: {
    // For when the waitlist goes: the invite sends people straight to sign-up.
    // The button's address comes from the sender, which must pass the sign-up
    // link (https://app.onhomeroom.com/?signup=1) before this goes live.
    project_invite: {
      name: `Project invite (sign-up, no waitlist)`,
      layout: STANDARD_LAYOUT,
      subject: `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}} on Homeroom{{else}}`
        + `@{{inviter}} invited you to a project on Homeroom{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}} on Homeroom{{else}}`
        + `Someone invited you to a project on Homeroom{{/if}}{{/if}}`,
      preheader: ``,
      why: `You are receiving this because someone on Homeroom invited this address to a project. You will not hear from us again unless you join, or somebody invites you again.`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="text-align:center"><p style="margin:0px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#68686c">You're invited</p>`
        + `<p style="margin:10px 0 0;font-size:24px;line-height:30px;font-weight:800;color:#1c1c1e">`
        + `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}}.{{else}}`
        + `@{{inviter}} invited you to a project.{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}}.{{else}}`
        + `Someone invited you to a project.{{/if}}{{/if}}</p>`
        + `<p style="margin:10px 0 0;font-size:16px;line-height:22px;color:#68686c">It's a private community on Homeroom, where communities build the apps they use together. Sign up with this email address.</p>`
        + `{{#if hasUrl}}<p style="margin:20px 0 0"><a href="{{url}}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a6ee0;color:#ffffff;font-size:16px;font-weight:650;text-decoration:none">{{#if hasProject}}Join {{project}}{{else}}Join the project{{/if}}</a></p>{{/if}}`
        + `<p style="margin:16px 0 0;font-size:13px;color:#68686c">If you were not expecting this, you can ignore this email.</p></td></tr></table>`,
      text: `{{#if hasInviter}}`
        + `{{#if hasProject}}@{{inviter}} invited you to {{project}}, a private community on Homeroom, where communities build the apps they use together.{{else}}`
        + `@{{inviter}} invited you to a project, a private community on Homeroom, where communities build the apps they use together.{{/if}}{{else}}`
        + `{{#if hasProject}}Someone invited you to {{project}}, a private community on Homeroom, where communities build the apps they use together.{{else}}`
        + `Someone invited you to a project, a private community on Homeroom, where communities build the apps they use together.{{/if}}{{/if}}\n\n`
        + `Sign up with this email address.`
        + `{{#if hasUrl}}\n\n`
        + `{{#if hasProject}}Join {{project}}{{else}}Join the project{{/if}}: {{url}}{{/if}}\n\n`
        + `If you were not expecting this, you can ignore this email.`,
    },
  },
};

const FIELDS = ['subject', 'preheader', 'why', 'html', 'text'];

/** A kind's seed: `{ name, layout, subject, preheader, why, html, text }`, a copy. */
function englishTemplate(kind) {
  if (!Object.hasOwn(SEEDS.templates, kind)) throw new Error(`No seed for ${kind}`);
  return { ...SEEDS.templates[kind] };
}

function seededLayout(name) {
  const layout = SEEDS.layouts.find((candidate) => candidate.name === name);
  if (!layout) throw new Error(`No seeded layout named ${name}`);
  return layout;
}

// ── Into the database ──────────────────────────────────────────────────

// Any server may be the one to seed. The lock is only tried, never waited for: a
// server that does not get it leaves the work to the one that did.
const SEED_LOCK = 'email_template_seeds';

// ── Untouched rows follow the seeds ────────────────────────────────────
//
// A seed row nobody has edited (its action's only version is 1, written by no
// one) is brought in line with the seeds above on a seed run, in place. Once an
// admin saves a version, the action is theirs and this never touches it again.
// The same holds for the layout. Only what differs is written, and only the
// English: a row whose English is already the seeds' is left alone, its
// translations included, since those are Translate's or an admin's now.
//
// So that a run with nothing new costs one query, the run records what it was
// made from: a hash of the seeds, which are already the English they expand to.
// A change to the seeds gives a new hash, and the next run compares every row
// once. The words no longer depend on the language list or the translation
// cache, so neither is part of it.
const FINGERPRINT_KEY = 'email_template_seed_fingerprint';
const FINGERPRINT = crypto.createHash('sha256')
  .update(JSON.stringify(['frozen seeds', SEEDS]))
  .digest('hex');

// Every kind and the layout have a row, deleted rows included, and the seeds
// have not changed since the last full run. One query on every boot.
async function nothingToSeed(pool) {
  const { rows: [row] } = await pool.query(
    `SELECT (SELECT count(DISTINCT action)::int FROM email_templates WHERE action = ANY($1::text[])) AS seeded,
            EXISTS (SELECT 1 FROM email_layouts WHERE name = $2) AS layout,
            (SELECT value FROM platform_settings WHERE key = $3) AS fingerprint`,
    [Object.keys(SEEDS.templates), STANDARD_LAYOUT, FINGERPRINT_KEY],
  );
  return row.layout && row.seeded === Object.keys(SEEDS.templates).length && row.fingerprint === FINGERPRINT;
}

// A try-lock, never waited for: an admin saving this action or layout right now
// holds it, and this run leaves that one alone rather than wait (and risk a
// deadlock with the layout row it already holds).
async function tryLock(client, scope, key) {
  const { rows: [{ got }] } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got', [`${scope}:${key}`]);
  return got;
}

// The row if it is the only version, version 1, written by nobody and live.
// A draft beside it (a staged one from SEEDS.drafts, an admin's, or one that
// was discarded) is not a version that ever went out, so it is not counted:
// the live seed is still nobody's edit.
const untouched = (all) => {
  const rows = all.filter((row) => row.status !== 'draft');
  return rows.length === 1 && rows[0].version === 1 && rows[0].created_by == null
    && rows[0].status === 'live' && rows[0].deleted_at == null ? rows[0] : null;
};

const sameFields = (row, want, fields) => fields.every((field) => row[field] === want[field]);

// Translate's job for this version (services/mail/template-translate.js), or
// null, with `busy` while it runs and has not gone quiet. Read lazily: the
// translation module is only needed where an admin has used it.
const translateModule = () => require('../services/mail/template-translate');
async function translateJob(client, kind, id) {
  const { rows: [job] } = await client.query(
    `SELECT per_language, (state = 'running' AND updated_at > NOW() - make_interval(secs => $3)) AS busy
       FROM email_translation_jobs WHERE kind = $1 AND version_id = $2`,
    [kind, id, translateModule().STALE_MS / 1000]);
  return job || null;
}

// The live layout a template is sent in, for a recheck, or null.
async function liveLayoutOf(client, familyId) {
  if (familyId == null) return null;
  const { rows: [layout] } = await client.query(
    "SELECT id, html, text FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL", [familyId]);
  return layout || null;
}

async function refreshUntouched(client, families, seeded) {
  const out = { templates: [], layouts: 0, busy: 0 };
  for (const layout of SEEDS.layouts) {
    const family = families[layout.name];
    if (!family) continue;
    if (!(await tryLock(client, 'email_layouts', family))) { out.busy += 1; continue; }
    const { rows } = await client.query(
      'SELECT id, name, version, status, created_by, deleted_at, html, text FROM email_layouts WHERE family_id = $1 FOR UPDATE', [family]);
    const row = untouched(rows);
    if (!row || row.name !== layout.name || sameFields(row, layout, ['html', 'text'])) continue;
    // A Translate run in progress is left to finish; the next boot refreshes.
    const job = await translateJob(client, 'layout', row.id);
    if (job && job.busy) continue;
    await client.query('UPDATE email_layouts SET html = $2, text = $3 WHERE id = $1', [row.id, layout.html, layout.text]);
    // The machine's translations were of the English just replaced, as was
    // the job that wrote them.
    const { rows: machine } = await client.query("SELECT 1 FROM email_layout_translations WHERE layout_id = $1 AND origin = 'machine' LIMIT 1", [row.id]);
    if (machine.length) await client.query("DELETE FROM email_layout_translations WHERE layout_id = $1 AND origin = 'machine'", [row.id]);
    if (job) await client.query("DELETE FROM email_translation_jobs WHERE kind = 'layout' AND version_id = $1", [row.id]);
    // What the templates it frames send in each language must still work in it.
    const { rows: framed } = await client.query(
      "SELECT * FROM email_templates WHERE layout_family_id = $1 AND status = 'live' AND deleted_at IS NULL", [family]);
    await translateModule().recheckTranslations(client, { templates: framed, layout: { id: row.id, html: layout.html, text: layout.text }, complete: true });
    out.layouts += 1;
  }
  for (const kind of Object.keys(SEEDS.templates)) {
    if (seeded.includes(kind)) continue;
    if (!(await tryLock(client, 'email_templates', kind))) { out.busy += 1; continue; }
    const { rows } = await client.query(
      `SELECT id, version, status, created_by, deleted_at, name, subject, preheader, why, html, text, layout_family_id
         FROM email_templates WHERE action = $1 FOR UPDATE`, [kind]);
    const row = untouched(rows);
    const english = englishTemplate(kind);
    if (!row || sameFields(row, english, ['name', ...FIELDS])) continue;
    // A Translate run in progress is left to finish; the next boot refreshes.
    const job = await translateJob(client, 'template', row.id);
    if (job && job.busy) continue;
    await client.query(
      'UPDATE email_templates SET name = $2, subject = $3, preheader = $4, why = $5, html = $6, text = $7 WHERE id = $1',
      [row.id, english.name, english.subject, english.preheader, english.why, english.html, english.text]);
    // The machine's translations, and the job that wrote them, were of the
    // English just replaced: they go, and the reader gets the new English
    // until Translate runs again. An admin's translation stays, rechecked
    // below, as an admin's save of the English would leave it.
    const { rows: machine } = await client.query("SELECT 1 FROM email_template_translations WHERE template_id = $1 AND origin = 'machine' LIMIT 1", [row.id]);
    if (machine.length) await client.query("DELETE FROM email_template_translations WHERE template_id = $1 AND origin = 'machine'", [row.id]);
    if (job) await client.query("DELETE FROM email_translation_jobs WHERE kind = 'template' AND version_id = $1", [row.id]);
    // Every translation left is checked here, in the same transaction, inside
    // the layout it is sent in, and marked rather than sent if it no longer fits.
    await translateModule().recheckTranslations(client, {
      templates: [{ ...english, id: row.id, action: kind }],
      layout: await liveLayoutOf(client, row.layout_family_id),
    });
    out.templates.push(kind);
  }
  return out;
}

/**
 * The actions with no live template on a live layout, sorted. Read by the
 * migration Job (scripts/migrate-kubernetes.js), which stops a release that
 * would send plain mail or none for them.
 */
async function kindsWithoutTemplate(pool) {
  const { rows } = await pool.query(
    `SELECT a.action FROM unnest($1::text[]) AS a(action)
      WHERE NOT EXISTS (
        SELECT 1 FROM email_templates t
         WHERE t.action = a.action AND t.status = 'live' AND t.deleted_at IS NULL
           AND (t.layout_family_id IS NULL OR EXISTS (
             SELECT 1 FROM email_layouts l
              WHERE l.family_id = t.layout_family_id AND l.status = 'live' AND l.deleted_at IS NULL)))
      ORDER BY a.action`,
    // A drip email has no live template on purpose: nothing sends it yet.
    [Object.keys(ACTIONS).filter((kind) => !isDrip(kind))],
  );
  return rows.map((row) => row.action);
}

// The staged drafts (SEEDS.drafts): each is added once as its action's draft,
// beside the live version, which it does not touch. Not when the action has an
// open draft already (an admin's), nor when a row of that name was ever made,
// so a draft an admin deleted or put live stays that way.
async function seedDrafts(client, families) {
  const out = { added: [], busy: 0 };
  for (const kind of Object.keys(SEEDS.drafts || {})) {
    if (!Object.hasOwn(ACTIONS, kind)) continue;
    const draft = SEEDS.drafts[kind];
    const family = families[draft.layout];
    if (!family) continue;
    if (!(await tryLock(client, 'email_templates', kind))) { out.busy += 1; continue; }
    const { rows: present } = await client.query(
      "SELECT 1 FROM email_templates WHERE action = $1 AND ((status = 'draft' AND deleted_at IS NULL) OR name = $2) LIMIT 1", [kind, draft.name]);
    if (present.length) continue;
    const { rows: [row] } = await client.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, preheader, why, html, text)
       SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, 'draft', $4, $5, $6, $7, $8 FROM email_templates WHERE action = $1
       ON CONFLICT DO NOTHING RETURNING id`,
      [kind, draft.name, family, draft.subject, draft.preheader, draft.why, draft.html, draft.text],
    );
    if (row) out.added.push(kind);
  }
  return out;
}

async function seedInTransaction(client) {
  const { rows: [{ got }] } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got', [SEED_LOCK]);
  if (!got) return { locked: false };

  const families = {};
  for (const layout of SEEDS.layouts) {
    // By family: a later version may have another name, and its first keeps this
    // one. FOR SHARE, as the store's saves do, so deleting it waits for this seed.
    const { rows: [live] } = await client.query(
      `SELECT family_id FROM email_layouts
        WHERE status = 'live' AND deleted_at IS NULL
          AND family_id IN (SELECT family_id FROM email_layouts WHERE name = $1)
        ORDER BY family_id LIMIT 1 FOR SHARE`,
      [layout.name],
    );
    if (live) {
      families[layout.name] = live.family_id;
      continue;
    }
    const { rows: ever } = await client.query('SELECT 1 FROM email_layouts WHERE name = $1 LIMIT 1', [layout.name]);
    if (ever.length) {
      families[layout.name] = null;
      continue;
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO email_layouts (family_id, name, version, status, html, text)
       VALUES (nextval('email_layout_family_seq')::int, $1, 1, 'live', $2, $3) RETURNING family_id`,
      [layout.name, layout.html, layout.text],
    );
    families[layout.name] = row.family_id;
  }

  const seeded = [];
  for (const kind of Object.keys(SEEDS.templates)) {
    const { rows: present } = await client.query('SELECT 1 FROM email_templates WHERE action = $1 LIMIT 1', [kind]);
    if (present.length) continue;
    const template = englishTemplate(kind);
    const family = families[template.layout];
    // An admin deleted the layout this seed wears. A mail with no frame would be
    // a surprise, so this kind gets no template until an admin gives it one.
    if (!family) {
      log.error('email-templates', 'A seed\'s layout was deleted, so its template was not added', { kind, layout: template.layout });
      continue;
    }
    // ON CONFLICT: an admin's first save for this action got in between.
    // A drip email nothing sends yet starts as a draft, never live.
    const { rows: [row] } = await client.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, preheader, why, html, text)
       VALUES ($1, $2, $3, 1, $9, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [kind, template.name, family, template.subject, template.preheader, template.why, template.html, template.text,
        isDrip(kind) ? 'draft' : 'live'],
    );
    if (row) seeded.push(kind);
  }
  const drafts = await seedDrafts(client, families);
  const refreshed = await refreshUntouched(client, families, seeded);
  // Only a run that could look at everything records that it did. A busy action
  // is looked at again next time.
  if (!refreshed.busy && !drafts.busy) {
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [FINGERPRINT_KEY, FINGERPRINT]);
  }
  return { locked: true, seeded, refreshed };
}

/**
 * Adds version 1 of every kind that has no row at all, in English, and brings
 * the rows nobody has edited in line with the seeds. Runs on every migration,
 * and costs one query when nothing has changed. A boot must not depend on it: a
 * problem is logged and the next run tries again (the migration Job then
 * refuses a release with a kind missing).
 */
async function seedEmailTemplates(pool) {
  let client = null;
  let rollbackFailed = null;
  try {
    if (await nothingToSeed(pool)) return;
    client = await pool.connect();
    await client.query('BEGIN');
    const { locked, seeded, refreshed } = await seedInTransaction(client);
    await client.query('COMMIT');
    if (locked && seeded.length) log.info('email-templates', 'Seeded email templates', { kinds: seeded.length });
    if (locked && (refreshed.templates.length || refreshed.layouts)) {
      log.info('email-templates', 'Refreshed untouched email templates from the seeds', { kinds: refreshed.templates, layouts: refreshed.layouts });
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch((rollbackError) => { rollbackFailed = rollbackError; });
    log.error('email-templates', 'Could not seed email templates', { message: err.message });
  } finally {
    // A client whose rollback failed is in an unknown state: it is closed, not reused.
    if (client) client.release(rollbackFailed || undefined);
  }
}

module.exports = {
  SEEDS, STANDARD_LAYOUT, PLAIN_LAYOUT, FINGERPRINT, englishTemplate, seededLayout, seedEmailTemplates, kindsWithoutTemplate,
};
