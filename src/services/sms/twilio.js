'use strict';

// Twilio's Programmable Messaging client:
// POST /2010-04-01/Accounts/{AccountSid}/Messages.json
//
// The same contract as brevo.js, so index.js can hand a send to either:
// one call, the same answer shape, the same retry rules. Twilio has no
// transactional/marketing type on the request; index.js keeps the two apart
// with its own gates, and `type`/`tag` are accepted and not sent.
//
// Authentication is HTTP Basic with the Account SID and the Auth Token. The
// body is form-encoded: To (E.164 with its '+'), From (the Sender ID the
// registry resolved) and Body. With TWILIO_STATUS_CALLBACK_URL set, each
// message also names it as StatusCallback, so delivery receipts reach
// routes/sms-webhooks.js.
//
// Retries are conservative and bounded, exactly as Brevo's: at most three
// attempts, 500 ms then 1500 ms apart, and only on 429, a 5xx or a
// connection failure before any response. A refusal (4xx) is never retried,
// and neither is a timeout — Twilio may already have queued the text.

const API_ORIGIN = 'https://api.twilio.com';
const TIMEOUT_MS = 10 * 1000;
const RETRY_DELAYS_MS = [500, 1500];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;


function endpointFor(accountSid) {
  return `${API_ORIGIN}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * The From a registry sender becomes. An alphanumeric Sender ID goes as it
 * is; a long number (seven digits or more) is a phone number and Twilio
 * wants it in E.164; a shorter one is a short code and goes as digits.
 */
function fromOf(sender) {
  const value = String(sender || '');
  if (/^[0-9]{7,15}$/.test(value)) return `+${value}`;
  return value;
}

function toOf(recipient) {
  const value = String(recipient || '');
  return value.startsWith('+') ? value : `+${value}`;
}

/**
 * Send one text. Returns
 *   { ok, status, messageId, providerCode, attempts, unreachable }
 * where `messageId` is Twilio's message SID and `providerCode` is Twilio's
 * numeric error code as a string ('21211', '21610' …) when it refused.
 * `deps.fetch` and `deps.sleep` are injectable so tests never wait or reach
 * the network.
 */
async function send(config, { sender, recipient, content }, deps = {}) {
  const accountSid = config && config.twilioAccountSid;
  const authToken = config && config.twilioAuthToken;
  if (typeof accountSid !== 'string' || !accountSid
      || typeof authToken !== 'string' || !authToken) {
    return { ok: false, status: 0, messageId: null, providerCode: 'missing_credentials', attempts: 0, unreachable: true };
  }
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const form = new URLSearchParams();
  form.set('To', toOf(recipient));
  form.set('From', fromOf(sender));
  form.set('Body', content);
  if (config.twilioStatusCallbackUrl) form.set('StatusCallback', config.twilioStatusCallbackUrl);
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    let res;
    try {
      res = await fetchImpl(endpointFor(accountSid), {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout may already have queued the text: never retry it.
      if (isTimeout(err) || attempts >= MAX_ATTEMPTS) {
        return {
          ok: false, status: 0, messageId: null,
          providerCode: isTimeout(err) ? 'timeout' : 'network_error',
          attempts, unreachable: true,
        };
      }
      await sleep(RETRY_DELAYS_MS[attempts - 1]);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        messageId: data && typeof data.sid === 'string' ? data.sid : null,
        providerCode: null,
        attempts,
        unreachable: false,
      };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempts < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAYS_MS[attempts - 1]);
      continue;
    }
    const code = data && data.code;
    return {
      ok: false,
      status: res.status,
      messageId: null,
      providerCode: (typeof code === 'number' || (typeof code === 'string' && code))
        ? String(code)
        : `http_${res.status}`,
      attempts,
      unreachable: retryable,
    };
  }
}

module.exports = {
  API_ORIGIN,
  TIMEOUT_MS,
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  endpointFor,
  fromOf,
  send,
};
