const fs = require('fs/promises');
const log = require('./logger');
const { execFileAsync } = require('./docker');

const USERNODE_CONF_PATH = process.env.USERNODE_CONF_PATH || '/etc/caddy/usernode.conf';
const USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';

async function registerRoute(hostname, containerName, port) {
  const routeBlock = `\n${hostname} {\n    reverse_proxy ${containerName}:${port}\n}\n`;

  let existing = '';
  try { existing = await fs.readFile(USERNODE_CONF_PATH, 'utf8'); } catch {}

  if (!existing.includes(hostname)) {
    await fs.writeFile(USERNODE_CONF_PATH, existing + routeBlock);
  }

  await reloadCaddy();
  log.info('caddy', 'Route registered', { hostname });
}

async function removeRoute(hostname) {
  try {
    let conf = await fs.readFile(USERNODE_CONF_PATH, 'utf8');
    const escaped = hostname.replace(/\./g, '\\.');
    const regex = new RegExp(`\\n?${escaped} \\{[^}]*\\}\\n?`, 'g');
    conf = conf.replace(regex, '\n');
    await fs.writeFile(USERNODE_CONF_PATH, conf);
    await reloadCaddy();
    log.info('caddy', 'Route removed', { hostname });
  } catch (err) {
    log.warn('caddy', 'Failed to remove route', { hostname, err: err.message });
  }
}

async function reloadCaddy() {
  try {
    await execFileAsync('docker', ['exec', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'], {
      timeout: 10000,
    });
  } catch (err) {
    log.warn('caddy', 'Caddy reload failed', { err: err.message });
  }
}

function productionHostname(slug) {
  return `${slug}.${USERNODE_DOMAIN}`;
}

function stagingHostname(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `${slug}--${username}--${shortHash}.${USERNODE_DOMAIN}`;
}

module.exports = {
  registerRoute,
  removeRoute,
  reloadCaddy,
  productionHostname,
  stagingHostname,
  USERNODE_DOMAIN,
};
