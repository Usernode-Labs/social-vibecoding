const { Router } = require('express');
const associations = require('../config/mobile-app-associations.json');

// Public release identities, not secrets. Android fingerprints must come from
// Play Console's App signing key certificate (not the upload/debug key).
// Keep old and new certificates here together during signing-key rotation.
const assetLinks = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: associations.androidPackage,
    sha256_cert_fingerprints: associations.androidSigningCertificateSha256,
  },
}];
const appleAssociation = {
  applinks: {
    details: [{
      appIDs: [associations.appleApplicationIdentifier],
      components: [{ '/': '/*' }],
    }],
  },
};

function mobileAppLinkRoutes() {
  const router = Router();
  for (const [path, document] of [
    ['/.well-known/assetlinks.json', assetLinks],
    ['/.well-known/apple-app-site-association', appleAssociation],
  ]) {
    router.get(path, (_req, res) => {
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.json(document);
    });
  }
  return router;
}

module.exports = { mobileAppLinkRoutes };
