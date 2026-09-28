'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, 'database-migration-eligibility.sql'), 'utf8');
const quote = name => '"' + String(name).replace(/"/g, '""') + '"';
async function inspect(client) {
  await client.query('SET search_path = pg_catalog');
  const result = (await client.query(sql)).rows[0]?.inspection;
  if (result?.version !== 2 || !Array.isArray(result.reasons) || !Array.isArray(result.tables) || !Array.isArray(result.analyzeTables)) throw Error('Invalid migration inspection');
  // Check the existing exact row cap before downtime, with bounded scans.
  if (!result.reasons.length) for (const t of result.tables) {
    const count = (await client.query(`SELECT count(*)::integer AS n FROM (SELECT 1 FROM ONLY ${quote(t.schema)}.${quote(t.name)} LIMIT 100001) bounded`)).rows[0].n;
    if (count > 100000) { result.reasons.push('ROW_LIMIT'); break; }
  }
  return result;
}
async function requireEligible(client) {
  const result = await inspect(client);
  if (result.reasons.length) throw Object.assign(new Error('COPY_UNSUPPORTED_METADATA'), { code: 'COPY_UNSUPPORTED_METADATA' });
  return result;
}
module.exports = { sql, inspect, requireEligible };
