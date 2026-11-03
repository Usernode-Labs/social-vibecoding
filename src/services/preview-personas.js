'use strict';

// The two screenshot personas' fixed ids in a platform preview (SEC-06). A
// platform preview's database can start empty, so its own seeds make the
// personas there (db/migrate.js seedCaptureUser, seedCaptureAdminUser), and
// the platform signs their tokens for its own previews with these ids. They
// sit next to the shots fixtures' own fixed ids (shots-fixtures.js), far
// above any production id. Production keeps its personas' own ids.
const PREVIEW_PERSONA_IDS = new Map([
  ['usernode-capture', 2147482996],
  ['usernode-capture-admin', 2147482997],
]);

// The id a platform preview knows this account by: a persona's fixed one,
// anyone else's own.
function previewPersonaId(user) {
  return PREVIEW_PERSONA_IDS.get(user?.username) ?? user?.id;
}

module.exports = { PREVIEW_PERSONA_IDS, previewPersonaId };
