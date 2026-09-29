const { Router } = require('express');
const associations = require('../config/mobile-app-associations.json');

// Public release identities, not secrets. Use the Play app signing certificate
// from Play Console or a verified Play-installed APK, never an upload/debug key.
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
  const serve = document => (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('X-Content-Type-Options', 'nosniff');
    res.json(document);
  };
  router.get('/.well-known/assetlinks.json', serve(assetLinks));
  router.get('/.well-known/apple-app-site-association', serve(appleAssociation));
  return router;
}

module.exports = { mobileAppLinkRoutes };
