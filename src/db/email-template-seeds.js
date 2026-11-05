'use strict';

// The first versions of the admin-editable email templates: today's hard-coded
// mails (src/services/mail/templates.js) written in the template language, and
// the code that puts them in the database once. tests/mail-seed-equivalence.test.js
// proves they render what that file renders, byte for byte, so change them only
// together with it. Once an action has a row, deleted or not, nothing here
// touches it again: from then on the words are the admins'.
//
// ── Catalog references ─────────────────────────────────────────────────
//
// `{{t:email:otp.subject}}` is a message of the email catalog. It is expanded
// when seeding, once per language, so the rows hold finished text and no
// reference: the template language itself would refuse one. In `subject` and
// `text` the message goes in as written. In `html`, `why` and `preheader` it is
// escaped as the code escapes a catalog message today, apostrophes left alone.
// A message's own parameters stay placeholders, filled when a mail is sent.
//
// Options follow a `|`, one each:
//   as:link=iosLink       the message's {{link}} is the action's {{iosLink}}
//   anchor:url=statusUrl  the message's {{url}} becomes a link, showing the
//                         address (`withLink` in templates.js)
//   tags:strong,iosLink   numbered tags: <0> becomes <strong>, <1> a link to
//                         {{iosLink}}; a tag with no entry stays words (`rich`)
//   bareAmp               the message's "&" goes out bare (account_email's lead)
//   breaks                a line break in the message becomes <br>

const log = require('../services/logger');
const languageCache = require('../services/language-cache');
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');
const { ACTIONS } = require('../services/mail/actions');
const { parse } = require('../services/mail/template-language');
const { englishTexts, translatorFrom } = require('../services/push-text');
const { usableMessages } = require('../services/push-language');

const STANDARD_LAYOUT = 'Homeroom standard';

// tailwind.config.js `violet` ramp / public/css/app.css `--accent*`.
const BRAND_ACCENT = '#0a6ee0';
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

// ── The pieces the mails share ─────────────────────────────────────────

const p = (inner) => `<p>${inner}</p>`;
const CODE_BLOCK = '<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>';
const LINK_STYLE = `color:${BRAND_ACCENT}`;

const BUTTON_STYLE = `display:inline-block;padding:11px 20px;border-radius:8px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:15px;font-weight:600;text-decoration:none';
const button = (url, label) => `<p><a href="{{${url}}}" style="${BUTTON_STYLE}">${label}</a></p>`;

const PILL_STYLE = `display:inline-block;padding:12px 28px;border-radius:999px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:16px;font-weight:650;text-decoration:none';
const pill = (url, label) => `<p style="margin:20px 0 0"><a href="{{${url}}}" style="${PILL_STYLE}">${label}</a></p>`;

const centered = (inner) => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
  + ` style="border-collapse:collapse"><tr><td style="text-align:center">${inner}</td></tr></table>`;

const heroEyebrow = (inner, top = 0) => `<p style="margin:${top}px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;`
  + `text-transform:uppercase;color:${NEUTRAL_SECONDARY_INK}">${inner}</p>`;
const heroHeadline = (inner, size = 28, lineHeight = 32) => `<p style="margin:10px 0 0;font-size:${size}px;line-height:${lineHeight}px;font-weight:800;`
  + `color:${NEUTRAL_INK}">${inner}</p>`;
const heroLine = (inner) => `<p style="margin:10px 0 0;font-size:16px;line-height:22px;color:${NEUTRAL_SECONDARY_INK}">${inner}</p>`;

const FRAME_WHY = '{{t:email:frame.why}}';

// ── The three plain code mails ─────────────────────────────────────────

const codeMail = (kind, area, htmlLead, htmlExpiry, textRest, leadOptions = '') => ({
  name: ACTIONS[kind].label,
  layout: STANDARD_LAYOUT,
  subject: `{{t:email:${area}.subject}}`,
  preheader: '',
  why: FRAME_WHY,
  html: p(`{{t:email:${htmlLead}${leadOptions}}}`) + CODE_BLOCK + p(`{{t:email:${htmlExpiry}}}`),
  text: `{{t:email:${area}.text.code}}\n\n{{t:email:${textRest}}}`,
});

// ── The activity mails ─────────────────────────────────────────────────

const STOP_LINK = '{{#if hasUnsubscribeUrl}}<p style="margin:16px 0 0;font-size:13px">'
  + `<a href="{{unsubscribeUrl}}" style="color:${NEUTRAL_SECONDARY_INK}">{{t:email:activity.stop.link}}</a></p>{{/if}}`;
const STOP_TEXT = '{{#if hasUnsubscribeUrl}}\n\n{{t:email:activity.stop.text|as:url=unsubscribeUrl}}{{/if}}';

const activityHtml = (eyebrow, lead, label) => centered(eyebrow + heroHeadline(lead, 24, 30) + pill('url', label) + STOP_LINK);
const activityText = (lead, textLink) => `${lead}\n\n${textLink}${STOP_TEXT}`;

// ── Which sentence a project invite takes ──────────────────────────────

const inviteWords = (part) => '{{#if hasInviter}}'
  + `{{#if hasProject}}{{t:email:projectInvite.named.${part}}}{{else}}{{t:email:projectInvite.noProject.${part}}}{{/if}}`
  + '{{else}}'
  + `{{#if hasProject}}{{t:email:projectInvite.noInviter.${part}}}{{else}}{{t:email:projectInvite.nothing.${part}}}{{/if}}`
  + '{{/if}}';

// ── The waitlist release mail's chips ──────────────────────────────────

const releaseChip = (line, color, top = 0) => '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
  + ` style="border-collapse:separate;margin:${top}px 0 8px;border:1px solid #0b0b0c;box-shadow:2px 2px 4px rgba(161,152,152,0.25)">`
  + '<tr>'
  + `<td width="34" height="34" bgcolor="${color}" style="width:34px;height:34px;background:${color}">&nbsp;</td>`
  + `<td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:${NEUTRAL_INK}">${line}</td>`
  + '</tr></table>';

// ── The admin test mail's detail rows ──────────────────────────────────

const detailRow = (label, value, first = false) => '<tr>'
  + `<td style="font-size:14px;line-height:1.5;padding:6px 12px;color:${NEUTRAL_SECONDARY_INK}`
  + (first ? '' : `;border-top:1px solid ${NEUTRAL_HAIRLINE}`) + `">${label}</td>`
  + `<td style="font-size:14px;line-height:1.5;padding:6px 12px;text-align:right">${value}</td></tr>`;

// ── The seeds ──────────────────────────────────────────────────────────

const SEEDS = {
  layouts: [
    { name: STANDARD_LAYOUT, html: STANDARD_LAYOUT_HTML, text: '{{content}}' },
  ],
  templates: {
    otp: {
      name: ACTIONS.otp.label,
      layout: STANDARD_LAYOUT,
      subject: '{{t:email:otp.subject}}',
      preheader: '',
      why: FRAME_WHY,
      html: p('{{t:email:otp.html.code}}') + CODE_BLOCK + p('{{t:email:otp.expiry}}'),
      text: '{{t:email:otp.text.code}}\n\n{{t:email:otp.expiry}}',
    },

    account_email: codeMail('account_email', 'accountEmail', 'accountEmail.html.lead', 'accountEmail.html.expiry', 'accountEmail.text.instructions', '|bareAmp'),

    username_change: codeMail('username_change', 'usernameChange', 'usernameChange.html.lead', 'usernameChange.html.expiry', 'usernameChange.text.instructions'),

    waitlist_joined: {
      name: ACTIONS.waitlist_joined.label,
      layout: STANDARD_LAYOUT,
      subject: '{{t:email:waitlistJoined.subject}}',
      preheader: '',
      why: FRAME_WHY,
      html: '{{#if hasCode}}'
        + p('<strong>{{t:email:waitlistJoined.heading}}</strong>')
        + CODE_BLOCK
        + p('{{t:email:waitlistJoined.html.codeLife}}')
        + '{{/if}}'
        + p('{{t:email:waitlistJoined.thanks}}')
        + p('{{t:email:waitlistJoined.expectation}}')
        + p('{{t:email:waitlistJoined.groups}}')
        + `{{#if hasConfirmUrl}}${button('confirmUrl', '{{t:email:waitlistJoined.button}}')}{{/if}}`,
      text: '{{#if hasCode}}{{t:email:waitlistJoined.heading}}\n{{t:email:waitlistJoined.text.code}}\n\n{{/if}}'
        + '{{t:email:waitlistJoined.thanks}}\n\n{{t:email:waitlistJoined.expectation}}\n\n{{t:email:waitlistJoined.groups}}'
        + '{{#if hasConfirmUrl}}\n\n{{t:email:waitlistJoined.text.oneTap}}\n{{confirmUrl}}{{/if}}',
    },

    // Three mails in one: an address that needs no code, a status code for a
    // confirmed address, and a confirmation code.
    waitlist_code: {
      name: ACTIONS.waitlist_code.label,
      layout: STANDARD_LAYOUT,
      subject: '{{#if hasCode}}{{#if isConfirmed}}{{t:email:waitlistCode.status.subject}}{{else}}{{t:email:waitlistCode.confirm.subject}}{{/if}}'
        + '{{else}}{{t:email:waitlistCode.done.subject}}{{/if}}',
      preheader: '',
      why: FRAME_WHY,
      html: '{{#if hasCode}}{{#if isConfirmed}}'
        + p('{{t:email:waitlistCode.status.html.code}}')
        + CODE_BLOCK
        + p('{{t:email:waitlistCode.status.html.life}}')
        + `{{#if hasStatusUrl}}${button('statusUrl', '{{t:email:waitlistCode.status.button}}')}{{/if}}`
        + p('{{t:email:waitlistCode.status.ignore}}')
        + '{{else}}'
        + p('{{t:email:waitlistCode.confirm.html.code}}')
        + CODE_BLOCK
        + p('{{t:email:waitlistCode.confirm.html.life}}')
        + `{{#if hasConfirmUrl}}${button('confirmUrl', '{{t:email:waitlistCode.confirm.button}}')}{{/if}}`
        + p('{{t:email:waitlistCode.confirm.ignore}}')
        + '{{/if}}{{else}}'
        + p('{{t:email:waitlistCode.done.asked}}')
        + p('{{t:email:waitlistCode.done.nothingLeft}}')
        + `{{#if hasStatusUrl}}${p('{{t:email:waitlistCode.done.status|anchor:url=statusUrl}}')}{{/if}}`
        + '{{/if}}',
      text: '{{#if hasCode}}{{#if isConfirmed}}'
        + '{{t:email:waitlistCode.status.text.code}}\n\n{{t:email:waitlistCode.status.text.newest}}'
        + '{{#if hasStatusUrl}}\n\n{{t:email:waitlistCode.status.text.enter}}\n{{statusUrl}}{{/if}}'
        + '\n\n{{t:email:waitlistCode.status.ignore}}'
        + '{{else}}'
        + '{{t:email:waitlistCode.confirm.text.code}}\n\n{{t:email:waitlistCode.confirm.text.newest}}'
        + '{{#if hasConfirmUrl}}\n\n{{t:email:waitlistCode.confirm.text.oneTap}}\n{{confirmUrl}}{{/if}}'
        + '\n\n{{t:email:waitlistCode.confirm.ignore}}'
        + '{{/if}}{{else}}'
        + '{{t:email:waitlistCode.done.asked}}\n\n{{t:email:waitlistCode.done.nothingLeft}}'
        + '{{#if hasStatusUrl}}\n\n{{t:email:waitlistCode.done.status|as:url=statusUrl}}{{/if}}'
        + '{{/if}}',
    },

    waitlist_released: {
      name: ACTIONS.waitlist_released.label,
      layout: STANDARD_LAYOUT,
      subject: '{{t:email:waitlistReleased.subject}}',
      preheader: '{{t:email:waitlistReleased.preheader}}',
      why: FRAME_WHY,
      html: centered(
        `<img src="${PRODUCTION_ORIGIN}/brand/people.png" width="272" height="204" alt=""`
          + ' style="display:block;margin:0 auto;border:0;max-width:100%;height:auto">'
        + heroEyebrow('{{t:email:waitlistReleased.eyebrow}}', 20)
        + heroHeadline('{{t:email:waitlistReleased.headline}}')
        + `{{#if hasAccount}}${heroLine('{{t:email:waitlistReleased.signIn.how}}')}{{/if}}`
        + pill('url', '{{#if hasAccount}}{{t:email:waitlistReleased.signIn.button}}{{else}}{{t:email:waitlistReleased.create.button}}{{/if}}')
        + `{{#if needsCodeNote}}<p style="margin:10px 0 0;font-size:13px;color:${NEUTRAL_SECONDARY_INK}">{{t:email:waitlistReleased.codeNote}}</p>{{/if}}`,
      )
        + releaseChip('{{t:email:waitlistReleased.canDo.make}}', '#3484fc', 24)
        + releaseChip('{{t:email:waitlistReleased.canDo.use}}', '#8bd669')
        + releaseChip('{{t:email:waitlistReleased.canDo.suggest}}', '#fc5750')
        + '{{#if hasMobile}}'
        + '<p style="margin:24px 0 8px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;'
        + `color:${NEUTRAL_SECONDARY_INK}">{{t:email:waitlistReleased.mobile.heading}}</p>`
        + '{{#if hasIos}}<p style="margin:0 0 8px">{{t:email:waitlistReleased.mobile.ios.html|tags:strong,iosLink}}</p>{{/if}}'
        + '{{#if hasAndroid}}<p style="margin:0 0 8px">{{t:email:waitlistReleased.mobile.android.html|tags:strong,androidLink}}</p>{{/if}}'
        + '{{/if}}'
        + p('{{t:email:waitlistReleased.signoff|breaks}}'),
      text: '{{t:email:waitlistReleased.text.opening}}\n{{t:email:waitlistReleased.headline}}\n\n'
        + '{{#if hasAccount}}{{t:email:waitlistReleased.signIn.how}}{{else}}{{t:email:waitlistReleased.create.text}}{{/if}}\n{{url}}'
        + '{{#if needsCodeNote}}\n\n{{t:email:waitlistReleased.codeNote}}{{/if}}'
        + '\n\n- {{t:email:waitlistReleased.canDo.make}}\n- {{t:email:waitlistReleased.canDo.use}}\n- {{t:email:waitlistReleased.canDo.suggest}}'
        + '{{#if hasMobile}}\n\n{{t:email:waitlistReleased.mobile.heading}}'
        + '{{#if hasIos}}\n{{t:email:waitlistReleased.mobile.ios.text|as:link=iosLink}}{{/if}}'
        + '{{#if hasAndroid}}\n{{t:email:waitlistReleased.mobile.android.text|as:link=androidLink}}{{/if}}'
        + '{{/if}}'
        + '\n\n{{t:email:waitlistReleased.signoff}}',
    },

    password_reset: {
      name: ACTIONS.password_reset.label,
      layout: STANDARD_LAYOUT,
      subject: '{{t:email:passwordReset.subject}}',
      preheader: '',
      why: FRAME_WHY,
      html: p('{{t:email:passwordReset.requested}}')
        + p('{{t:email:passwordReset.link|anchor:url=url}}')
        + p('{{t:email:passwordReset.expiry}}'),
      text: '{{t:email:passwordReset.requested}}\n\n{{t:email:passwordReset.link}}\n\n{{t:email:passwordReset.expiry}}',
    },

    // What only an admin or an operator receives is English, and asks no catalog.
    admin_test: {
      name: ACTIONS.admin_test.label,
      layout: STANDARD_LAYOUT,
      subject: 'Homeroom test email',
      preheader: '',
      why: 'You are receiving this because of activity on your account or your place on the waitlist. We only send mail you asked for.',
      html: centered(heroEyebrow('Test email') + heroHeadline('This is a test email from the Homeroom platform admin console.', 24, 30))
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
        + ` style="border-collapse:separate;margin:20px 0 0;border:1px solid ${NEUTRAL_HAIRLINE};border-radius:12px"><tbody>`
        + detailRow('Provider', '<strong>{{provider}}</strong>', true)
        + detailRow('Sent as', '{{from}}')
        + detailRow('Sent at', '{{sentAt}}')
        + detailRow('Reference', '<code>{{reference}}</code>')
        + '</tbody></table>'
        + `<p style="margin:16px 0 0;text-align:center;font-size:13px;color:${NEUTRAL_SECONDARY_INK}">`
        + 'An administrator sent it to check that outbound email works. No action is needed.</p>',
      text: 'This is a test email from the Homeroom platform admin console.\n\n'
        + 'Provider: {{provider}}\nSent as: {{from}}\nSent at: {{sentAt}}\nReference: {{reference}}\n\n'
        + 'An administrator sent it to check that outbound email works. No action is needed.',
    },

    content_report: {
      name: ACTIONS.content_report.label,
      layout: STANDARD_LAYOUT,
      subject: '{{subject}}',
      preheader: 'New {{reason}} report on {{targetLabel}}',
      why: "You are receiving this because this address is Homeroom's compliance inbox for content reports.",
      html: p('A new report was submitted on Homeroom.')
        + '<p>Reason: <strong>{{reason}}</strong><br>'
        + 'Reported: {{typeLabel}} · {{targetLabel}}<br>'
        + 'Reporter: {{reporter}}<br>'
        + 'Case #{{caseId}} · Report #{{reportId}}</p>'
        + p('Details from the reporter:')
        + '<p style="white-space:pre-wrap">{{detail}}</p>'
        + button('url', 'Open in Moderation'),
      text: 'A new report was submitted on Homeroom.\n\n'
        + 'Reason: {{reason}}\nReported: {{typeLabel}} · {{targetLabel}}\nReporter: {{reporter}}\n'
        + 'Case #{{caseId}} · Report #{{reportId}}\n\n'
        + 'Details from the reporter:\n{{detail}}\n\n'
        + 'Open in Moderation: {{url}}',
    },

    project_invite: {
      name: ACTIONS.project_invite.label,
      layout: STANDARD_LAYOUT,
      subject: inviteWords('subject'),
      preheader: '',
      why: '{{t:email:projectInvite.why}}',
      html: centered(
        heroEyebrow('{{t:email:projectInvite.eyebrow}}')
        + heroHeadline(inviteWords('headline'), 24, 30)
        + heroLine('{{t:email:projectInvite.html.line}}')
        + `{{#if hasUrl}}${pill('url', '{{t:email:projectInvite.button}}')}{{/if}}`
        + `<p style="margin:16px 0 0;font-size:13px;color:${NEUTRAL_SECONDARY_INK}">{{t:email:projectInvite.html.unexpected}}</p>`,
      ),
      text: `${inviteWords('lead')}\n\n{{t:email:projectInvite.text.how}}{{#if hasUrl}}\n\n{{url}}{{/if}}\n\n{{t:email:projectInvite.text.unexpected}}`,
    },

    // {{app}}, {{lead}} and {{subject}} are built in code (src/services/mail/actions.js).
    build_ready: {
      name: ACTIONS.build_ready.label,
      layout: STANDARD_LAYOUT,
      subject: '{{subject}}',
      preheader: '{{lead}}',
      why: '{{t:email:activity.why}}',
      html: activityHtml(heroEyebrow('{{app}}'), '{{lead}}', '{{t:email:buildReady.button}}'),
      text: activityText('{{lead}}', '{{t:email:buildReady.text.open}}'),
    },

    // {{line}} and {{subject}} are built in code (src/services/mail/actions.js).
    invite_activity: {
      name: ACTIONS.invite_activity.label,
      layout: STANDARD_LAYOUT,
      subject: '{{subject}}',
      preheader: '{{line}}',
      why: '{{t:email:activity.why}}',
      html: activityHtml(
        `{{#if hasApp}}${heroEyebrow('{{app}}')}{{/if}}`,
        '{{line}}',
        '{{#if hasApp}}{{t:email:inviteActivity.button}}{{else}}{{t:email:inviteActivity.buttonUnnamed}}{{/if}}',
      ),
      text: activityText('{{line}}', '{{#if hasApp}}{{t:email:inviteActivity.text.open}}{{else}}{{t:email:inviteActivity.text.openUnnamed}}{{/if}}'),
    },

    project_opened: {
      name: ACTIONS.project_opened.label,
      layout: STANDARD_LAYOUT,
      subject: '{{#if hasApp}}{{t:email:projectOpened.subject}}{{else}}{{t:email:projectOpened.subjectUnnamed}}{{/if}}',
      preheader: '{{#if hasApp}}{{t:email:projectOpened.lead}}{{else}}{{t:email:projectOpened.leadUnnamed}}{{/if}}',
      why: '{{t:email:activity.why}}',
      html: activityHtml(
        `{{#if hasApp}}${heroEyebrow('{{app}}')}{{/if}}`,
        '{{#if hasApp}}{{t:email:projectOpened.lead}}{{else}}{{t:email:projectOpened.leadUnnamed}}{{/if}}',
        '{{t:email:projectOpened.button}}',
      ),
      text: activityText(
        '{{#if hasApp}}{{t:email:projectOpened.lead}}{{else}}{{t:email:projectOpened.leadUnnamed}}{{/if}}',
        '{{t:email:projectOpened.text.open}}',
      ),
    },
  },
};

// ── Expanding catalog references ───────────────────────────────────────

const FIELDS = ['subject', 'preheader', 'why', 'html', 'text'];
const PLAIN_FIELDS = new Set(['subject', 'text']);
const REFERENCE = /\{\{t:(email:[^|}]+)((?:\|[^|}]+)*)\}\}/g;

// Today's `esc`: the apostrophe stays, because catalog wording has always gone
// out with it bare. A placeholder has no such character, so it comes through.
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const anchor = (url, inner) => `<a href="{{${url}}}" style="${LINK_STYLE}">${inner}</a>`;

function optionsOf(written) {
  const options = { renames: {}, anchors: {}, tags: null, bareAmp: false, breaks: false };
  for (const option of written.split('|').filter(Boolean)) {
    let m;
    if ((m = /^as:(\w+)=(\w+)$/.exec(option))) options.renames[m[1]] = m[2];
    else if ((m = /^anchor:(\w+)=(\w+)$/.exec(option))) options.anchors[m[1]] = m[2];
    else if ((m = /^tags:(.+)$/.exec(option))) options.tags = m[1].split(',');
    else if (option === 'bareAmp') options.bareAmp = true;
    else if (option === 'breaks') options.breaks = true;
    else throw new Error(`Unknown seed option: ${option}`);
  }
  return options;
}

// The same reading as `rich` in templates.js: after escaping, so anything but a
// tag this message has a wrapper for stays words.
function withTags(escaped, tags) {
  return escaped.replace(/&lt;(\d+)&gt;(.*?)&lt;\/\1&gt;/gs, (whole, n, inner) => {
    const tag = tags[Number(n)];
    if (!tag) return whole;
    return tag === 'strong' ? `<strong>${inner}</strong>` : anchor(tag, inner);
  });
}

function inField(words, field, options) {
  let out = PLAIN_FIELDS.has(field) ? words : esc(words);
  if (!PLAIN_FIELDS.has(field)) {
    if (options.bareAmp) out = out.replace(/&amp;/g, '&');
    if (options.tags) out = withTags(out, options.tags);
    if (options.breaks) out = out.replace(/\n/g, '<br>');
  }
  return out.replace(/\{\{(\w+)\}\}/g, (whole, name) => {
    const target = options.anchors[name] || options.renames[name] || name;
    if (options.anchors[name] && !PLAIN_FIELDS.has(field)) return anchor(target, `{{${target}}}`);
    return `{{${target}}}`;
  });
}

const expand = (source, field, wordsFor) => source.replace(REFERENCE, (_, id, written) => inField(wordsFor(id), field, optionsOf(written)));

function expandTemplate(kind, wordsFor) {
  const seed = SEEDS.templates[kind];
  if (!seed) throw new Error(`No seed for ${kind}`);
  const out = { name: seed.name, layout: seed.layout };
  for (const field of FIELDS) out[field] = expand(seed[field], field, wordsFor);
  return out;
}

// A catalog message as written, whatever parameters it has.
function englishWords(source) {
  const texts = englishTexts(source, 'email');
  return (id) => {
    const key = id.slice(id.indexOf(':') + 1);
    if (!Object.hasOwn(texts, key)) throw new Error(`The email catalog has no ${id}`);
    return texts[key];
  };
}

function englishTemplate(kind, { source } = {}) {
  return expandTemplate(kind, englishWords(source));
}

function seededLayout(name) {
  const layout = SEEDS.layouts.find((candidate) => candidate.name === name);
  if (!layout) throw new Error(`No seeded layout named ${name}`);
  return layout;
}

// A translator fills a message's parameters in. Asked with this, each one answers
// with itself, so what comes back is the translation as written, a parameter the
// English does not have included.
const SELF = new Proxy({}, {
  get: (_, name) => (typeof name === 'string' ? `{{${name}}}` : undefined),
  getOwnPropertyDescriptor: (_, name) => ({ value: `{{${String(name)}}}`, enumerable: true, configurable: true }),
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;
const controls = (text) => (text.match(CONTROL) || []).join('');
const tagsOf = (text) => [...text.matchAll(/<(\d+)>/g)].map((m) => m[1]);
const keepsItsTags = (answer, english) => tagsOf(english).every((tag) => tagsOf(answer).includes(tag));

// The placeholders of a message, or null if it holds anything else the template
// language would act on. Today such text would reach a reader as words.
function placeholdersOfMessage(words) {
  try {
    const { nodes } = parse(words);
    if (nodes.some((node) => node.type !== 'text' && node.type !== 'var')) return null;
    return nodes.filter((node) => node.type === 'var').map((node) => node.name).sort().join();
  } catch {
    return null;
  }
}

class UnusableTranslation extends Error {}

/**
 * A kind's template in the language of `t`, or null if the English should go
 * instead. Message by message, as today: an answer that is empty or brings line
 * breaks the English does not have costs that one message its translation. A
 * message that loses or changes its placeholders or tags is what
 * `keepsWhatItCarries` refuses at send time (the code or the link is gone), and
 * costs the whole mail: not seeded for this language, so it falls back to English.
 *
 * A language gets its row even where this kind's own words are all still English:
 * the words built in code may be translated, and a translated mail's subject is
 * cleaned, so that row is what keeps the mail what it is today.
 */
function translatedTemplate(kind, t, { source } = {}) {
  const inEnglish = englishWords(source);
  const wordsFor = (id) => {
    const english = inEnglish(id);
    const answer = t(id, SELF);
    if (typeof answer !== 'string' || !answer.trim() || controls(answer) !== controls(english)) return english;
    const placeholders = placeholdersOfMessage(answer);
    if (placeholders === null || placeholders !== placeholdersOfMessage(english) || !keepsItsTags(answer, english)) {
      throw new UnusableTranslation(id);
    }
    return answer;
  };
  try {
    return expandTemplate(kind, wordsFor);
  } catch (err) {
    if (err instanceof UnusableTranslation) return null;
    throw err;
  }
}

// ── Into the database ──────────────────────────────────────────────────

// Any server may be the one to seed. The lock is only tried, never waited for: a
// server that does not get it leaves the work to the one that did.
const SEED_LOCK = 'email_template_seeds';

// Every kind and the layout have a row, deleted rows included. One query on every
// boot, and nothing more once seeding is done.
async function nothingToSeed(pool) {
  const { rows: [row] } = await pool.query(
    `SELECT (SELECT count(DISTINCT action)::int FROM email_templates WHERE action = ANY($1::text[])) AS seeded,
            EXISTS (SELECT 1 FROM email_layouts WHERE name = $2) AS layout`,
    [Object.keys(SEEDS.templates), STANDARD_LAYOUT],
  );
  return row.layout && row.seeded === Object.keys(SEEDS.templates).length;
}

// Whether `t` translates any email message at all. A language that does not has
// no rows, and its reader gets the English template.
function saysAnything(t, { source } = {}) {
  return Object.entries(englishTexts(source, 'email')).some(([key, english]) => {
    const answer = t(`email:${key}`, SELF);
    return typeof answer === 'string' && answer !== english.replace(/\{\{\s*(\w+)\s*\}\}/g, '{{$1}}');
  });
}

// What the catalog and the language cache can say now, per kind, for the
// languages that say anything at all. Read before the transaction starts, so it
// holds no connection while these reads wait for one. They go to the cache
// directly and a failed one throws: the translator a mail asks with would answer
// English instead, and this seed happens once, so a blip would lose the language
// for good. Here it rolls the seed back and the next boot tries again.
async function translationsToSeed(pool, source) {
  const languages = Object.keys(source?.files?.['config.json']?.languages || {}).filter((language) => language !== 'en');
  const inEnglish = englishTexts(source, 'email');
  const out = {};
  for (const language of languages) {
    const cached = await languageCache.cachedNamespace(pool, language, 'email');
    const t = translatorFrom(language, usableMessages(language, source, cached, 'email'), inEnglish);
    if (!saysAnything(t, { source })) continue;
    for (const [kind, action] of Object.entries(ACTIONS)) {
      if (action.englishOnly) continue;
      const template = translatedTemplate(kind, t, { source });
      if (template) (out[kind] ||= {})[language] = template;
    }
  }
  return out;
}

async function seedInTransaction(client, source, translations) {
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
    const template = englishTemplate(kind, { source });
    const family = families[template.layout];
    // An admin deleted the layout this seed wears. A mail with no frame would be
    // a surprise, so this kind stays on the code until an admin gives it one.
    if (!family) {
      log.error('email-templates', 'A seed\'s layout was deleted, so its template was not added', { kind, layout: template.layout });
      continue;
    }
    // ON CONFLICT: an admin's first save for this action got in between.
    const { rows: [row] } = await client.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, preheader, why, html, text)
       VALUES ($1, $2, $3, 1, 'live', $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [kind, template.name, family, template.subject, template.preheader, template.why, template.html, template.text],
    );
    if (!row) continue;
    seeded.push(kind);
    for (const [locale, words] of Object.entries(translations[kind] || {})) {
      await client.query(
        `INSERT INTO email_template_translations (template_id, locale, subject, preheader, why, html, text, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'machine')`,
        [row.id, locale, words.subject, words.preheader, words.why, words.html, words.text],
      );
    }
  }
  return { locked: true, seeded };
}

/**
 * Adds version 1 of every kind that has no row at all, with the translations
 * that can be had now. Runs on every boot, and costs one query once it is done.
 * Nothing sends from these yet, and a boot must not depend on them: a problem is
 * logged and the next boot tries again.
 */
async function seedEmailTemplates(pool, { source = languageCache.readSource() } = {}) {
  let client = null;
  try {
    if (await nothingToSeed(pool)) return;
    const translations = await translationsToSeed(pool, source);
    client = await pool.connect();
    await client.query('BEGIN');
    const { locked, seeded } = await seedInTransaction(client, source, translations);
    await client.query('COMMIT');
    if (locked && seeded.length) {
      const languages = new Set(Object.values(translations).flatMap((byLanguage) => Object.keys(byLanguage))).size;
      log.info('email-templates', 'Seeded email templates', { kinds: seeded.length, languages });
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.error('email-templates', 'Could not seed email templates', { message: err.message });
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  SEEDS, STANDARD_LAYOUT, englishTemplate, translatedTemplate, seededLayout, saysAnything, seedEmailTemplates,
};
