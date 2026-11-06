'use strict';

// The plain message of the owner's failure order: when no stored template can
// be had or rendered, a mail that carries a code or a link still goes, as just
// that, undesigned. It is the one email text left in code, by the owner's
// decision, because a sign-in code must reach its reader even when the
// templates cannot be read. Only a plain http(s) link is sent, and a mail that
// must carry an unsubscribe link (activity mail) never goes plain.

const tracking = require('./tracking');
const { actionFor } = require('./actions');

const BRAND_NAME = 'Homeroom';
const LINK_COLOR = '#0a6ee0';

// The code and the links are the only values that reach this mail, and both
// are escaped where they land.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const codeLine = (code) => `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p>`;
const linkLine = (url) => `<p><a href="${esc(url)}" style="color:${LINK_COLOR}">${esc(url)}</a></p>`;

/** `{ subject, text, html, headers }` for `kind`, or null when there is nothing to send. */
function plainMessage(kind, payload) {
  const action = actionFor(kind);
  if (!action || action.required.html.includes('unsubscribeUrl')) return null;
  const code = payload.code == null || payload.code === '' ? null : String(payload.code);
  const links = [payload.url, payload.confirmUrl, payload.statusUrl].map(tracking.destination).filter(Boolean);
  if (!code && !links.length) return null;
  return {
    subject: BRAND_NAME,
    text: [BRAND_NAME, ...(code ? [code] : []), ...links].join('\n\n'),
    html: [...(code ? [codeLine(code)] : []), ...links.map(linkLine)].join(''),
    headers: action.headers ? action.headers(payload) : null,
  };
}

module.exports = { plainMessage };
