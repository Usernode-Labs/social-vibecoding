// Gmail API transport — send platform mail through a Google/Workspace
// mailbox using an OAuth2 installed-app refresh token.
//
// Why the API and not SMTP: the runtime image installs with
// `npm ci --production`, so a transport may not add a dependency, and
// SMTP would mean nodemailer. Gmail's REST send endpoint is one POST with
// a base64url RFC-2822 blob, which `fetch` can do unaided.
//
// Configuration (platform_env → "Platform mail"):
//   GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET — the OAuth client
//   GMAIL_OAUTH_REFRESH_TOKEN — minted once for the sending mailbox with
//     the https://www.googleapis.com/auth/gmail.send scope
//   PLATFORM_MAIL_FROM — the address that mailbox is authorised to send
//     as (an alias or a "send mail as" identity is fine; Gmail rejects
//     the send otherwise)
//
// The refresh token is long-lived; access tokens last an hour, so they
// are cached in module memory and refreshed slightly early. A single
// in-flight refresh promise is shared, so N concurrent sends after a boot
// cause one token request, not N.
'use strict';

const log = require('../../logger');
const { buildMessage } = require('../templates');

const PROVIDER = 'gmail';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// Same hard cap as the HTTP transport: these sends ride on always-200
// endpoints, so a hung provider must degrade to "not delivered" fast
// rather than holding a user's request open.
const SEND_TIMEOUT_MS = 8000;
// Refresh this far before the token actually expires, so a send never
// races the boundary.
const TOKEN_SKEW_MS = 60_000;

const KEYS = [
  'GMAIL_OAUTH_CLIENT_ID',
  'GMAIL_OAUTH_CLIENT_SECRET',
  'GMAIL_OAUTH_REFRESH_TOKEN',
];

function readEnv(env) {
  const e = env || {};
  return {
    clientId: (e.GMAIL_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: (e.GMAIL_OAUTH_CLIENT_SECRET || '').trim(),
    refreshToken: (e.GMAIL_OAUTH_REFRESH_TOKEN || '').trim(),
  };
}

function missingKeys(env) {
  const { clientId, clientSecret, refreshToken } = readEnv(env);
  return [
    !clientId && 'GMAIL_OAUTH_CLIENT_ID',
    !clientSecret && 'GMAIL_OAUTH_CLIENT_SECRET',
    !refreshToken && 'GMAIL_OAUTH_REFRESH_TOKEN',
  ].filter(Boolean);
}

// ─── RFC 2822 assembly ──────────────────────────────────────────────────

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// RFC 2047 encoded-word, needed only when a header value isn't pure
// ASCII. Subjects are platform copy today, but em dashes and apostrophes
// creep in, so encode rather than emit raw 8-bit bytes in a header.
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Strip anything that could inject an extra header. `to` is a validated
// email by the time it reaches here, but a CR/LF in a header value is the
// one mistake that turns a mailer into an open relay, so refuse it here
// too rather than trusting the caller.
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

// multipart/alternative with the text part first (clients pick the last
// part they understand, so HTML wins where it's supported and the text
// body is what a plain reader sees).
function buildRaw({ from, to, message, boundary }) {
  const lines = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeader(headerSafe(message.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.html || `<pre>${message.text}</pre>`,
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

// ─── the transport ──────────────────────────────────────────────────────

function create(env, { sender = null, fetchImpl = null } = {}) {
  const { clientId, clientSecret, refreshToken } = readEnv(env);
  if (!clientId && !clientSecret && !refreshToken) return null;
  if (!clientId || !clientSecret || !refreshToken) {
    log.error('platform-mail-gmail',
      'Gmail mail is partially configured — email will NOT be delivered',
      { missing: missingKeys(env) });
    return null;
  }
  if (!sender) {
    log.error('platform-mail-gmail',
      'Gmail mail has no sender address — set PLATFORM_MAIL_FROM');
    return null;
  }

  const doFetch = (...args) => (fetchImpl || global.fetch)(...args);

  // Access-token cache. Scoped to this transport instance, so a config
  // reload gets a clean slate rather than a token minted for the old
  // credentials.
  let cached = null;          // { token, expiresAt }
  let inFlight = null;        // shared refresh promise
  let boundaryCounter = 0;

  async function refresh() {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        // Bounded slice only: a token-endpoint error body names the
        // problem ("invalid_grant") without carrying the credential.
        throw new Error(`token HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('token response was not JSON');
      }
      if (!parsed.access_token) throw new Error('token response carried no access_token');
      const ttlMs = Math.max(0, (Number(parsed.expires_in) || 3600) * 1000 - TOKEN_SKEW_MS);
      cached = { token: parsed.access_token, expiresAt: Date.now() + ttlMs };
      return cached.token;
    } finally {
      clearTimeout(timer);
    }
  }

  // One refresh at a time, shared by every concurrent caller.
  async function accessToken({ force = false } = {}) {
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    if (force) cached = null;
    if (!inFlight) {
      inFlight = refresh().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  async function postMessage(token, raw) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await doFetch(SEND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ raw }),
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, status: res.status };
      const detail = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: detail.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: PROVIDER,
    from: sender,
    async send({ to, kind, ...payload }) {
      const message = buildMessage(kind || 'otp', payload);
      boundaryCounter += 1;
      const raw = base64url(buildRaw({
        from: sender,
        to,
        message,
        boundary: `usernode-${process.pid.toString(36)}-${boundaryCounter.toString(36)}`,
      }));

      let token = await accessToken();
      let result = await postMessage(token, raw);

      // Exactly one retry per recoverable class, so a send can't turn
      // into an unbounded loop inside an always-200 request.
      if (!result.ok && result.status === 401) {
        // The cached token was revoked or invalidated early — force one
        // refresh and try again.
        token = await accessToken({ force: true });
        result = await postMessage(token, raw);
      } else if (!result.ok && (result.status === 429 || result.status >= 500)) {
        result = await postMessage(token, raw);
      }

      if (!result.ok) {
        // The raw message (which contains the OTP code) and the token are
        // never logged — only the provider's own bounded complaint.
        throw new Error(`HTTP ${result.status}: ${result.detail || ''}`);
      }
    },
  };
}

module.exports = {
  create, missingKeys, PROVIDER, KEYS, SEND_TIMEOUT_MS,
  // exported for tests
  buildRaw, base64url, encodeHeader,
};
