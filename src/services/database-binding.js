'use strict';

// Explicit connection construction for the future binding-driven callers.
// No fallback to the legacy administrative endpoint when a binding is given.
function bindingConnectionUrl(binding, password) {
  const ident = /^[a-z_][a-z0-9_]{0,62}$/;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!binding || typeof binding.database !== 'string' || !ident.test(binding.database)
    || typeof binding.owner !== 'string' || !ident.test(binding.owner)
    || typeof binding.host !== 'string' || binding.host.length > 253
    || !binding.host.split('.').every((part) => label.test(part))
    || !Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535
    || !['require', 'verify-ca', 'verify-full'].includes(binding.sslMode)) {
    throw new Error('Invalid database binding');
  }
  if (typeof password !== 'string' || !password) throw new Error('Database credential is required');
  const url = new URL('postgresql://localhost');
  url.hostname = binding.host;
  url.port = String(binding.port);
  url.username = binding.owner;
  url.password = password;
  url.pathname = `/${binding.database}`;
  url.searchParams.set('sslmode', binding.sslMode);
  return url.toString();
}

module.exports = { bindingConnectionUrl };
