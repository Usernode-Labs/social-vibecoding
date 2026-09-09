'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const secrets = require('../secrets');

const PROTOCOL = 2;
const AUDIENCE = 'usernode-native-session-v2';
const DESIRED_RUNTIME = 'running';
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;
// Protocol 2 deliberately preserves the product's existing 7-day cookie
// session and 90-day mobile bearer lifetime. TODO(native-session-v3): move to
// persistent product sessions plus server-driven internal credential rotation.
const CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const ATTEMPT_RE = /^nsa_[A-Za-z0-9_-]{43}$/;
const HANDOFF_RE = /^nsh_[A-Za-z0-9_-]{43}$/;
const TICKET_RE = /^nst_[A-Za-z0-9_-]{43}$/;
const INSTALLATION_RE = /^nsi_[A-Za-z0-9_-]{43}$/;

function canonicalOpaque(prefix, pattern) {
  return z.string().regex(pattern).refine((value) => {
    const encoded = value.slice(prefix.length);
    try {
      const decoded = Buffer.from(encoded, 'base64url');
      return decoded.length === 32 && decoded.toString('base64url') === encoded;
    } catch {
      return false;
    }
  }, 'must contain a canonical 32-byte base64url value');
}

const canonicalB64Url = (bytes) => z.string().refine((value) => {
  if (!B64URL_32_RE.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}, `must be canonical base64url for exactly ${bytes} bytes`);

const ecPublicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: canonicalB64Url(32),
  y: canonicalB64Url(32),
}).strict();

const rsaPublicJwkSchema = z.object({
  kty: z.literal('RSA'),
  n: z.string().min(1),
  e: z.literal('AQAB'),
}).strict();

const ticketRequestSchema = z.object({
  protocol: z.literal(PROTOCOL),
  attemptId: canonicalOpaque('nsa_', ATTEMPT_RE),
  desiredRuntime: z.literal(DESIRED_RUNTIME),
}).strict();

const handoffTokenSchema = canonicalOpaque('nsh_', HANDOFF_RE);

const exchangeRequestSchema = z.object({
  protocol: z.literal(PROTOCOL),
  attemptId: canonicalOpaque('nsa_', ATTEMPT_RE),
  desiredRuntime: z.literal(DESIRED_RUNTIME),
  ticket: canonicalOpaque('nst_', TICKET_RE),
  requestDigest: z.string().regex(HEX_64_RE),
  installation: z.object({
    id: canonicalOpaque('nsi_', INSTALLATION_RE),
    keyGeneration: z.literal(1),
    possessionPublicJwk: ecPublicJwkSchema,
    envelopePublicJwk: rsaPublicJwkSchema,
  }).strict(),
  proof: z.object({
    algorithm: z.literal('ES256'),
    signature: z.string().refine((value) => {
      try {
        const decoded = Buffer.from(value, 'base64url');
        return decoded.length === 64 && decoded.toString('base64url') === value;
      } catch {
        return false;
      }
    }, 'must be a canonical 64-byte IEEE-P1363 ES256 signature'),
  }).strict(),
}).strict();

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeOpaque(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function frame(domain, fields) {
  const chunks = [Buffer.from(`${domain}\0`, 'ascii')];
  for (const [name, rawValue] of fields) {
    const value = Buffer.from(String(rawValue), 'utf8');
    chunks.push(Buffer.from(`${name}:${value.length}:`, 'ascii'), value, Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(chunks);
}

function digestFrame(domain, fields) {
  return sha256Hex(frame(domain, fields));
}

function ticketRequestDigest({ attemptId, userId, webSessionIncarnationId, network }) {
  return digestFrame('usernode.native-session.ticket-request.v2', [
    ['protocol', PROTOCOL],
    ['attemptId', attemptId],
    ['desiredRuntime', DESIRED_RUNTIME],
    ['subjectUserId', userId],
    ['webSessionIncarnationId', webSessionIncarnationId],
    ['audience', AUDIENCE],
    ['networkId', network.id],
    ['chainId', network.chainId],
  ]);
}

function canonicalEcJwk(jwk) {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

function canonicalRsaJwk(jwk) {
  return JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
}

function jwkThumbprint(canonicalJwk) {
  return crypto.createHash('sha256').update(canonicalJwk, 'utf8').digest('base64url');
}

function validateInstallationKeys(installation) {
  const possessionJwk = ecPublicJwkSchema.parse(installation.possessionPublicJwk);
  const envelopeJwk = rsaPublicJwkSchema.parse(installation.envelopePublicJwk);

  let possessionKey;
  let envelopeKey;
  try {
    possessionKey = crypto.createPublicKey({ key: possessionJwk, format: 'jwk' });
    envelopeKey = crypto.createPublicKey({ key: envelopeJwk, format: 'jwk' });
  } catch {
    throw new Error('invalid_installation_public_key');
  }

  if (possessionKey.asymmetricKeyType !== 'ec'
      || possessionKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('invalid_possession_public_key');
  }

  const rsaBytes = Buffer.from(envelopeJwk.n, 'base64url');
  if (rsaBytes.toString('base64url') !== envelopeJwk.n
      || rsaBytes.length !== 384
      || (rsaBytes[0] & 0x80) === 0
      || envelopeKey.asymmetricKeyType !== 'rsa'
      || envelopeKey.asymmetricKeyDetails?.modulusLength !== 3072
      || envelopeKey.asymmetricKeyDetails?.publicExponent !== 65537n) {
    throw new Error('invalid_envelope_public_key');
  }

  const possessionKeyThumbprint = jwkThumbprint(canonicalEcJwk(possessionJwk));
  const envelopeKeyThumbprint = jwkThumbprint(canonicalRsaJwk(envelopeJwk));
  return {
    possessionJwk,
    envelopeJwk,
    possessionKey,
    envelopeKey,
    possessionKeyThumbprint,
    envelopeKeyThumbprint,
    possessionKeyId: `nskp_${possessionKeyThumbprint}`,
    envelopeKeyId: `nske_${envelopeKeyThumbprint}`,
  };
}

function exchangeSemanticDigest(request, keys) {
  return digestFrame('usernode.native-session.exchange-request.v2', [
    ['protocol', request.protocol],
    ['attemptId', request.attemptId],
    ['desiredRuntime', request.desiredRuntime],
    ['ticketHash', sha256Hex(request.ticket)],
    ['ticketRequestDigest', request.requestDigest],
    ['installationId', request.installation.id],
    ['keyGeneration', request.installation.keyGeneration],
    ['possessionPublicJwk', canonicalEcJwk(keys.possessionJwk)],
    ['envelopePublicJwk', canonicalRsaJwk(keys.envelopeJwk)],
    ['proofAlgorithm', request.proof.algorithm],
  ]);
}

// Cross-language contract: UTF-8 values, ASCII labels/domain, a NUL after the
// domain, then each fixed-order field as `name:<UTF-8 byte length>:value\n`.
// Length framing makes embedded punctuation/newlines unambiguous. Tests pin a
// full transcript hex vector; changing this is a protocol revision.
function possessionTranscript({ request, keys, ticketHash, exchangeChallenge, network }) {
  return frame('usernode.native-session.exchange-pop.v2', [
    ['protocol', request.protocol],
    ['attemptId', request.attemptId],
    ['desiredRuntime', request.desiredRuntime],
    ['ticketHash', ticketHash],
    ['ticketRequestDigest', request.requestDigest],
    ['exchangeChallenge', exchangeChallenge],
    ['installationId', request.installation.id],
    ['keyGeneration', request.installation.keyGeneration],
    ['possessionKeyThumbprint', keys.possessionKeyThumbprint],
    ['envelopeKeyThumbprint', keys.envelopeKeyThumbprint],
    ['networkId', network.id],
    ['chainId', network.chainId],
  ]);
}

function verifyPossessionProof({ request, keys, ticketHash, exchangeChallenge, network }) {
  const signature = Buffer.from(request.proof.signature, 'base64url');
  return crypto.verify(
    'sha256',
    possessionTranscript({ request, keys, ticketHash, exchangeChallenge, network }),
    { key: keys.possessionKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
}

async function compactEncryptCredential(plaintext, keys) {
  const { CompactEncrypt, importJWK } = await import('jose');
  const encryptionKey = await importJWK(keys.envelopeJwk, 'RSA-OAEP');
  const body = Buffer.from(JSON.stringify(plaintext), 'utf8');
  return new CompactEncrypt(body)
    .setProtectedHeader({
      alg: 'RSA-OAEP',
      enc: 'A256GCM',
      kid: keys.envelopeKeyId,
      typ: 'application/usernode-native-session-credential+jwe',
    })
    .encrypt(encryptionKey);
}

function sealReplay({ kind, key, rawJson, dataEncryptionKey }) {
  const responseDigest = sha256Hex(rawJson);
  return {
    responseDigest,
    encryptedResponse: secrets.encrypt(JSON.stringify({
      version: 2,
      kind,
      key,
      responseDigest,
      rawJson,
    }), dataEncryptionKey),
  };
}

function openReplay({ kind, key, encryptedResponse, responseDigest, dataEncryptionKey }) {
  const plaintext = secrets.decrypt(encryptedResponse, dataEncryptionKey);
  if (!plaintext) throw new Error('native_session_replay_decrypt_failed');
  let envelope;
  try { envelope = JSON.parse(plaintext); } catch { throw new Error('native_session_replay_invalid'); }
  if (envelope.version !== 2 || envelope.kind !== kind || envelope.key !== key
      || envelope.responseDigest !== responseDigest
      || sha256Hex(envelope.rawJson) !== responseDigest) {
    throw new Error('native_session_replay_integrity_failed');
  }
  return envelope.rawJson;
}

module.exports = {
  PROTOCOL,
  AUDIENCE,
  DESIRED_RUNTIME,
  HANDOFF_TTL_MS,
  TICKET_TTL_MS,
  CREDENTIAL_TTL_MS,
  ticketRequestSchema,
  handoffTokenSchema,
  exchangeRequestSchema,
  sha256Hex,
  makeOpaque,
  frame,
  ticketRequestDigest,
  validateInstallationKeys,
  exchangeSemanticDigest,
  possessionTranscript,
  verifyPossessionProof,
  compactEncryptCredential,
  sealReplay,
  openReplay,
};
