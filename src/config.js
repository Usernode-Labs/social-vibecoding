const REQUIRED = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
];

function mask(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function load() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET,
    githubAppId: process.env.GITHUB_APP_ID || '',
    githubPrivateKey: (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'INFO',
    // Hard cap on non-errored apps per server. Protects against runaway
    // container / DB creation chewing through host resources. Admins bypass
    // the cap; errored rows don't count (they hold ~no resources and users
    // can delete them to free a slot). See src/routes/apps.js.
    maxApps: parseInt(process.env.MAX_APPS || '20', 10),
    usernodeAppPubkey: process.env.USERNODE_APP_PUBKEY || '',
    // Default points at the sidecar usernode container that
    // docker-compose.yml runs alongside the platform (service name
    // `usernode-node`). Production injects NODE_RPC_URL explicitly so
    // this default only matters for local dev and ad-hoc runs; pointing
    // it at the sidecar pattern (rather than a public host that may
    // come and go) keeps the failure mode obvious — "no node reachable
    // at <name>" is clearly a setup issue, not a transient outage.
    nodeRpcUrl: process.env.NODE_RPC_URL || 'http://usernode-node:3000',
    // GitHub URL of the platform's own repo. Read by feedback (file
    // issues here), the import-flow guard (refuse to import the self-
    // repo as a child app), and the self-app boot seed (Phase 2f).
    // Default targets the canonical Usernode-Labs repo; forks self-
    // hosting under their own org just need to override this in .env.
    platformRepoUrl: (process.env.USERNODE_PLATFORM_REPO || 'https://github.com/Usernode-Labs/social-vibecoding').replace(/\/$/, ''),
  };

  console.log('[config] Loaded:');
  console.log(`  DATABASE_URL=${mask(config.databaseUrl)}`);
  console.log(`  JWT_SECRET=${mask(config.jwtSecret)}`);
  console.log(`  GITHUB_APP_ID=${config.githubAppId || '(not set)'}`);
  console.log(`  ANTHROPIC_API_KEY=${mask(config.anthropicApiKey)}`);
  console.log(`  LOG_LEVEL=${config.logLevel}`);
  console.log(`  MAX_APPS=${config.maxApps}`);
  console.log(`  USERNODE_APP_PUBKEY=${config.usernodeAppPubkey || '(not set — wallet linking disabled)'}`);
  console.log(`  NODE_RPC_URL=${config.nodeRpcUrl}`);
  console.log(`  USERNODE_PLATFORM_REPO=${config.platformRepoUrl}`);

  return config;
}

module.exports = { load };
