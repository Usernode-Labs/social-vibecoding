'use strict';

// The platform's secret-scrubbing rules, in a module of their own.
//
// These began (#30) inside services/logger.js, scrubbing every log line and
// every /status ring-buffer entry. They live here now because #2504 needed
// them somewhere a LOG STUB cannot remove: services/deploy-failure.js writes
// its record to the DATABASE rather than through a log line, and dozens of
// test files stub `services/logger` with a bare
// `{ info(){}, warn(){}, error(){}, debug(){} }`. Reaching the redactor
// through that facade meant every one of those stubs silently deleted it.
//
// One list, two callers — the logger and the deploy-failure record — so the
// two can never drift apart.

// #30: patterns scrubbed from every log line + every ring-buffer entry
// before they're persisted. These are defense in depth — callers
// SHOULD avoid passing secrets in the first place, but a single
// `log.warn('docker', err.message)` where `err.cmd` happens to contain
// a key shouldn't be a security incident. Order matters: more
// specific patterns first so generic ones don't pre-scrub them.
// Each entry is [pattern, replacement]; the replacement defaults to a flat
// '****' when omitted, which is right for anything whose every byte is
// secret. A pattern that matches surrounding context to find the secret
// supplies its own replacement so the context survives.
const SENSITIVE_PATTERNS = [
  [/sk-or-v1-[A-Za-z0-9_-]+/g],           // OpenRouter API keys
  [/sk-ant-[A-Za-z0-9_-]+/g],             // Anthropic API keys (user + admin)
  [/ghp_[A-Za-z0-9]{20,}/g],              // GitHub personal access tokens
  [/ghs_[A-Za-z0-9]{20,}/g],              // GitHub app installation tokens
  [/x-access-token:[^@\s]+@/g],           // credentialed git URLs
  // URI-embedded credentials — `postgres://role:secret@host:5432/db`. A
  // staging boot failure that logs its DATABASE_URL put a live database
  // password in cleartext into the ring buffer the /status dashboard
  // serves. Mask only the password: the scheme, role, host, port and
  // database name are exactly what makes such a line diagnosable, and a
  // flat '****' over the whole URL would throw them away. Must stay ahead
  // of the generic `password` rule below.
  [/(\w+:\/\/[^:@\s/]+):[^@\s/]+@/g, '$1:****@'],
  // #2504: a SECRET-SHAPED ASSIGNMENT, whatever the vendor.
  //
  // Every rule above names a specific issuer — `sk-ant-`, `sk-or-v1-`,
  // `ghp_` — which works for the platform's own credentials and cannot
  // work for a CHILD APP's. Those are declared in the app's own dapp.json
  // and named by whoever wrote it, so `STRIPE_KEY`, `SENDGRID_API_KEY`,
  // `ADMIN_TOKEN` and a bare `MY_APP_SECRET` all passed through in
  // cleartext. `src/services/docker.js` puts every one of them on the
  // `docker run` argv as `-e NAME=value`, and a rejected execFile carries
  // that whole argv in its message.
  //
  // So: match on the NAME's shape instead of the value's. The name itself
  // survives — knowing WHICH variable was set is most of the diagnosis,
  // and the value is never any of it.
  //
  // Deliberately after the URI rule above, which masks only the password
  // inside a connection string and keeps the host diagnosable. `*_URL`
  // does not match this rule, so the two do not compete.
  // The name may BE the secret word (`TOKEN=…`) or carry any prefix
  // (`SENDGRID_API_KEY=…`). A quoted value is consumed whole, so a secret
  // with spaces in it does not leak its tail — app-secrets.normalizeValue
  // only TRIMS, so interior whitespace is preserved and legal.
  [/\b((?:[A-Z][A-Z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|DSN))=(?:"[^"\n]*"|'[^'\n]*'|\S+)/g, '$1=****'],
  // The catch-all for a bare `password: value`. The negative lookahead is
  // #2504: without it this rule re-matched the rule above's own output —
  // `SESSION_PASSWORD=****` became `SESSION_****`, eating the variable name
  // that is most of the diagnosis. Already-masked values are left alone.
  [/password["']?\s*[:=]\s*["']?(?!\*{4})\S+/gi],
];

function redactString(str) {
  if (typeof str !== 'string' || !str) return str;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    str = str.replace(pattern, replacement === undefined ? '****' : replacement);
  }
  return str;
}

function redactString(str) {
  if (typeof str !== 'string' || !str) return str;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    str = str.replace(pattern, replacement === undefined ? '****' : replacement);
  }
  return str;
}

// Mask KNOWN literal secret values, whatever they look like.
//
// #2504: the pattern list above infers a secret from its SHAPE, and that
// inference has a floor. A child app's secret can be any string at all —
// `ADMIN_TOKEN=alpha beta gamma` on an execFile argv is indistinguishable
// from three separate arguments, so no regex can know where the value ends.
// A caller that HOLDS the values has no such problem, and services/docker.js
// does: it builds the `-e NAME=value` argv from an `env` object it was
// handed. Masking the literals removes the guessing entirely.
//
// Longest first, so a secret that contains another one masks completely
// rather than leaving a fragment behind. Values under 8 characters are
// skipped: something that short is as likely to be a substring of ordinary
// log text as a credential, and blanking every occurrence of it would
// destroy the diagnosis this record exists for.
const MIN_LITERAL_LENGTH = 8;
function redactValues(str, values) {
  if (typeof str !== 'string' || !str || !values) return str;
  const list = (Array.isArray(values) ? values : Object.values(values))
    .filter((v) => typeof v === 'string' && v.length >= MIN_LITERAL_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of list) {
    str = str.split(value).join('****');
  }
  return str;
}

// Mask a known `NAME=value` assignment, at ANY value length.
//
// `redactValues` above needs a length floor because it blanks a bare
// occurrence anywhere in the text, and blanking every `abc` in a build log
// destroys the log. That floor left a hole Codex found: an app secret is
// only required to be NON-EMPTY, so a legitimate short one whose variable
// name is not secret-shaped (`FOO=abc123`) was matched by neither rule.
//
// This has no such tension. The value is known AND its position is known —
// `services/docker.js` writes exactly `NAME=value` onto the argv — so
// replacing that whole token is exact. There is nothing to infer and no
// collateral damage, and therefore no floor.
function redactEnvAssignments(str, env) {
  if (typeof str !== 'string' || !str || !env) return str;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value.length) continue;
    str = str.split(`${name}=${value}`).join(`${name}=****`);
  }
  return str;
}

module.exports = {
  redactString, redactValues, redactEnvAssignments, SENSITIVE_PATTERNS, MIN_LITERAL_LENGTH,
};
