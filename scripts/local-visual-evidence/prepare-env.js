#!/usr/bin/env node
'use strict';

// Bootstrap an ignored, local-only Homeroom config for the evidence lab.
// Never overwrites an existing .env or imports production credentials.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { bech32m } = require('bech32');

const target = path.resolve(__dirname, '../..', '.env');
if (fs.existsSync(target)) {
  const existing = fs.readFileSync(target, 'utf8');
  if (!/^USERNODE_LOCAL_DEV=1$/m.test(existing)
      || !/^DATABASE_URL=postgres:\/\/usernode:localdev@db:5432\/usernode$/m.test(existing)) {
    throw new Error('Existing .env is not the evidence lab config; refusing to modify it.');
  }
  process.stdout.write('Local evidence .env already exists; kept unchanged.\n');
  process.exit(0);
}

const secret = () => crypto.randomBytes(32).toString('hex');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key, type) => key.export({ format: 'pem', type }).replace(/\n/g, '\\n');
const dataKey = secret();
const config = {
  ADMIN_USERNAME: 'localadmin',
  ADMIN_PASSWORD: secret(),
  SESSION_SECRET: secret(),
  USERNODE_DOMAIN: 'localhost',
  CLI_CANONICAL_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgres://usernode:localdev@db:5432/usernode',
  USERNODE_DB_PASSWORD: 'localdev',
  DATA_ENCRYPTION_KEY: dataKey,
  JWT_SECRET: dataKey,
  IFRAME_JWT_PRIVATE_KEY: pem(keys.privateKey, 'pkcs8'),
  IFRAME_JWT_PUBLIC_KEY: pem(keys.publicKey, 'spki'),
  WORKER_JWT_SECRET: secret(),
  EDGE_JWT_SECRET: secret(),
  NODE_RPC_URL: 'http://host.docker.internal:3001',
  EXPLORER_UPSTREAM: '127.0.0.1:9',
  TOPOCHAIN_PARTNER_API_KEY: secret(),
  NATIVE_SESSION_V2_TESTNET_CHAIN_ID:
    bech32m.encode('utc', bech32m.toWords(crypto.randomBytes(32)), 1023),
  USERNODE_LOCAL_DEV: '1',
  VISUAL_EVIDENCE_V2_ENABLED: 'true',
  APP_HEAL_INTERVAL_MS: '0',
};
fs.writeFileSync(target,
  `${Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  { mode: 0o600, flag: 'wx' });
process.stdout.write('Created ignored local-only .env. Run make up, then npm run test:visual-evidence:platform-local.\n');
