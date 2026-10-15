'use strict';

// #30 BYOK encryption helpers: AES-256-GCM at rest, keyed off
// `config.dataEncryptionKey`. The envelope, the KDF and the reasons not to
// touch either are in src/workflow/rules/secrets.ts, the one copy (the
// workflow machines encrypt and decrypt inside their transactions with it).

const { encrypt, decrypt } = require('../workflow/rules/secrets.ts');

module.exports = { encrypt, decrypt };
