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
  };

  console.log('[config] Loaded:');
  console.log(`  DATABASE_URL=${mask(config.databaseUrl)}`);
  console.log(`  JWT_SECRET=${mask(config.jwtSecret)}`);
  console.log(`  GITHUB_APP_ID=${config.githubAppId || '(not set)'}`);
  console.log(`  ANTHROPIC_API_KEY=${mask(config.anthropicApiKey)}`);
  console.log(`  LOG_LEVEL=${config.logLevel}`);
  console.log(`  MAX_APPS=${config.maxApps}`);

  return config;
}

module.exports = { load };
