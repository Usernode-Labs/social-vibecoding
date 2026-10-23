'use strict';

// Brevo's transactional SMS client: POST /v3/transactionalSMS/send.
//
// Marketing goes through the same endpoint with type "marketing"; Brevo
// keeps the two apart for its own compliance reporting and the caller's
// opt-out handling, which index.js enforces.
//
// Retries are conservative and bounded: at most three attempts, 500 ms then
// 1500 ms apart, and only when Brevo is busy (429), has a server error
// (5xx) or the connection failed before any response. A refusal (4xx) is
// never retried, and neither is a timeout — Brevo may already have sent the
// text, and a retry would bill and deliver it twice.

const ENDPOINT = 'https://api.brevo.com/v3/transactionalSMS/send';
const TIMEOUT_MS = 10 * 1000;
const RETRY_DELAYS_MS = [500, 1500];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Send one text. Returns
 *   { ok, status, messageId, providerCode, attempts, unreachable }
 * where `messageId` is Brevo's own id (what the delivery log and the admin
 * card show) and `providerCode` is Brevo's `code` field when it refused
 * (not_enough_credits, invalid_parameter, unauthorized …). `deps.fetch` and
 * `deps.sleep` are injectable so tests never wait or reach the network.
 */
async function send(config, { sender, recipient, content, type, tag }, deps = {}) {
  const apiKey = config && config.brevoApiKey;
  if (typeof apiKey !== 'string' || !apiKey) {
    return { ok: false, status: 0, messageId: null, providerCode: 'missing_api_key', attempts: 0, unreachable: true };
  }
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = {
    sender,
    // Brevo's example carries the number without the leading '+'.
    recipient: String(recipient).replace(/^\+/, ''),
    content,
    type,
  };
  if (tag) body.tag = tag;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout may already have delivered the text: never retry it.
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
        messageId: data && data.messageId != null ? String(data.messageId) : null,
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
    return {
      ok: false,
      status: res.status,
      messageId: null,
      providerCode: (data && typeof data.code === 'string' && data.code) || `http_${res.status}`,
      attempts,
      unreachable: retryable,
    };
  }
}

module.exports = { ENDPOINT, TIMEOUT_MS, RETRY_DELAYS_MS, MAX_ATTEMPTS, send };
