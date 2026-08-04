'use strict';

const PERMANENT_TOKEN_CODES = new Set([
  'messaging/invalid-recipient',
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential',
  'messaging/registration-token-not-registered',
]);
const PAYLOAD_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-payload',
  'messaging/invalid-data-payload-key',
  'messaging/payload-size-limit-exceeded',
  'messaging/invalid-options',
]);

function safeCode(err) {
  const raw = err?.code || err?.errorInfo?.code || '';
  if (typeof raw !== 'string') return 'provider_unknown_error';
  return raw.toLowerCase().replace(/[^a-z0-9_./-]/g, '_').slice(0, 96)
    || 'provider_unknown_error';
}

function classifyError(err) {
  const code = safeCode(err);
  if (PERMANENT_TOKEN_CODES.has(code)) return { action: 'drop_registration', code };
  if (PAYLOAD_CODES.has(code)) return { action: 'dead', code: 'invalid_application_payload' };
  return { action: 'retry', code };
}

function parseServiceAccount(encoded, projectId) {
  if (!encoded || !projectId) throw new Error('Firebase push credentials are incomplete');
  let account;
  try {
    account = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('Firebase service account is not valid base64 JSON');
  }
  if (!account || account.project_id !== projectId
      || !account.client_email || !account.private_key) {
    throw new Error('Firebase service account is invalid or belongs to another project');
  }
  return account;
}

function createFirebaseProvider(config, dependencies = {}) {
  const account = parseServiceAccount(
    config.firebaseServiceAccountJsonB64,
    config.firebaseProjectId
  );
  const appSdk = dependencies.appSdk || require('firebase-admin/app');
  const messagingSdk = dependencies.messagingSdk || require('firebase-admin/messaging');
  let app;
  try {
    app = appSdk.initializeApp({
      credential: appSdk.cert(account),
      projectId: config.firebaseProjectId,
    }, `social-push-${config.mobilePushEnvironment}`);
  } catch {
    throw new Error('Firebase push initialization failed');
  }
  const messaging = messagingSdk.getMessaging(app);
  return {
    send: (message) => messaging.send(message, false),
    close: () => appSdk.deleteApp(app),
  };
}

module.exports = {
  PERMANENT_TOKEN_CODES,
  PAYLOAD_CODES,
  safeCode,
  classifyError,
  parseServiceAccount,
  createFirebaseProvider,
};
