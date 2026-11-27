'use strict';
// Test keys and what the platform signs with them: passes (Ed25519) and
// identity tokens (RS256), plus the twin database's password. Node only,
// no packages. Keys are throwaway, written to a directory the caller picks.
//
//   node lib.js keys <dir>                          make every key and secret
//   node lib.js pass <dir> <json fields>            print a pass
//   node lib.js token <dir> <app> <id> <username>   print an identity token
//   node lib.js password <dir> <db>                 print <db>_owner's password

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64url = (b) => Buffer.from(b).toString('base64url');

function makeKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ed = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'pass.pk8'), ed.privateKey.export({ type: 'pkcs8', format: 'der' }), { mode: 0o600 });
  // The raw 32-byte public key is the last 32 bytes of its SPKI encoding.
  const spki = ed.publicKey.export({ type: 'spki', format: 'der' });
  fs.writeFileSync(path.join(dir, 'pass.pub.b64'), spki.subarray(spki.length - 32).toString('base64'));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path.join(dir, 'jwt.pem'), rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'jwt.pub.pem'), rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'db.secret'), crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'runner.token'), crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
}

function read(dir, name) { return fs.readFileSync(path.join(dir, name)); }

/** A pass, version 1: base64url(JSON) "." base64url(Ed25519 signature over the first part). */
function mintPass(dir, fields) {
  const key = crypto.createPrivateKey({ key: read(dir, 'pass.pk8'), format: 'der', type: 'pkcs8' });
  const now = Math.floor(Date.now() / 1000);
  const p = Object.assign({ v: 1, user: null, scope: 'req' }, fields);
  if (p.exp === undefined) p.exp = now + (p.scope === 'setup' ? 300 : 60);
  const body = b64url(JSON.stringify(p));
  return `${body}.${b64url(crypto.sign(null, Buffer.from(body), key))}`;
}

/** A person's identity token for an app, as /api/iframe-token mints it. */
function mintToken(dir, app, id, username, extra) {
  const key = crypto.createPrivateKey(read(dir, 'jwt.pem'));
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(Object.assign({ id, username, pur: 'iframe', iat: now, exp: now + 3600, aud: `usernode:app:${app}`, iss: 'usernode' }, extra || {})));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

/** hex(HMAC-SHA256(WASM_DB_SECRET, db)): the password of `<db>_owner`. */
function dbPassword(secret, db) { return crypto.createHmac('sha256', secret).update(db).digest('hex'); }

module.exports = { makeKeys, mintPass, mintToken, dbPassword, read };

if (require.main === module) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (cmd === 'keys') makeKeys(dir);
  else if (cmd === 'pass') process.stdout.write(mintPass(dir, JSON.parse(rest[0])) + '\n');
  else if (cmd === 'token') process.stdout.write(mintToken(dir, Number(rest[0]), Number(rest[1]), rest[2]) + '\n');
  else if (cmd === 'password') process.stdout.write(dbPassword(read(dir, 'db.secret').toString().trim(), rest[0]) + '\n');
  else { console.error('usage: lib.js keys|pass|token|password <dir> ...'); process.exit(2); }
}
