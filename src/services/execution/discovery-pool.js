'use strict';

const { Pool } = require('pg');
const { z } = require('zod');

function createDiscoveryPool(databaseUrl, {
  lockTimeoutMs = 100,
  statementTimeoutMs = 1000,
  connectionTimeoutMs = 1000,
} = {}) {
  z.number().int().min(1).max(30000).parse(lockTimeoutMs);
  z.number().int().min(lockTimeoutMs).max(60000).parse(statementTimeoutMs);
  z.number().int().min(1).max(60000).parse(connectionTimeoutMs);
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get('options') || '';
  url.searchParams.set('options', [existingOptions,
    `-c lock_timeout=${lockTimeoutMs}ms`,
    `-c statement_timeout=${statementTimeoutMs}ms`,
  ].filter(Boolean).join(' '));

  // A separate bounded connection budget keeps discovery from occupying the
  // executor's pool. PostgreSQL cancels the waiting statement; B2 awaits its
  // error and rollback before releasing the client. No detached transaction.
  return new Pool({
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: connectionTimeoutMs,
    application_name: 'bounded-work-discovery',
  });
}

module.exports = { createDiscoveryPool };
