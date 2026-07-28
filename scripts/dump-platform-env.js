#!/usr/bin/env node
'use strict';

/**
 * Deploy-time resolver for the platform's own environment variables.
 *
 * Run as a ONE-OFF container during the deploy, after .env has been
 * written from GitHub secrets/vars but before the platform is rebuilt:
 *
 *   docker compose run --rm --no-deps --entrypoint node usernode \
 *     scripts/dump-platform-env.js
 *
 * It connects to the platform database, decrypts every writable value in
 * `platform_env_values` for the self-hosted app, and prints them as
 * `.env` lines. Those lines are appended to /opt/usernode/.env LAST, so
 * a console-set value wins over the committed default for the same key —
 * and a value for a key sourced from a GitHub *secret* can never appear
 * at all, because services/platform-env.js refuses to resolve unwritable
 * keys.
 *
 * WHY A ONE-OFF CONTAINER and not the running platform: /opt/usernode/
 * runtime is mounted :ro into the platform container, so the platform
 * cannot write a snapshot of its own env anywhere the deploy can read.
 * A throwaway container with the same image, the same .env, and no
 * dependencies has the database credentials already and needs no new
 * mount, no new port, and no new auth surface.
 *
 * WHY SENTINELS and not bare stdout: config.load() and the logger both
 * write to stdout, so a plain redirect would capture the boot banner
 * too. Everything between the BEGIN and END markers is env lines and
 * nothing else; the deploy extracts that range with awk. If this script
 * dies partway, there is no END marker, the extraction yields nothing,
 * and the deploy falls back to the previous run's cached file rather
 * than truncating the platform's configuration.
 *
 * Exit codes: 0 on success (including "nothing set" — an empty block is
 * a legitimate answer), 1 on any failure. The deploy treats a failure as
 * non-fatal and reuses the cache; losing a tunable override is worth
 * strictly less than a failed deploy.
 */

const BEGIN = '#__PLATFORM_ENV_BEGIN__';
const END = '#__PLATFORM_ENV_END__';

/**
 * Render one .env line. Single-quoted, matching the style deploy.yml
 * uses for GITHUB_PRIVATE_KEY: no interpolation, no word splitting, and
 * multi-line values survive.
 *
 * A value containing a single quote cannot be represented this way at
 * all, so platform-env.validateValue() rejects one at the moment an
 * admin tries to save it. Re-checking here with the SAME function is the
 * belt to that's braces: a row written before the rule existed, or by a
 * direct DB write, is skipped rather than emitted as a line that would
 * corrupt every variable after it.
 */
function envLine(key, value) {
  return `${key}='${value}'`;
}

async function main() {
  const config = require('../src/config').load();
  const { getPool } = require('../src/db/pool');
  const platformEnv = require('../src/services/platform-env');

  const pool = getPool(config);
  const { rows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1 AND self_hosted = TRUE',
    [config.selfAppSlug]
  );
  if (!rows.length) {
    // No self-app row yet (first boot on a fresh database). Emit an
    // empty-but-well-formed block: the deploy should proceed with the
    // committed defaults, not fall back to a stale cache.
    process.stdout.write(`${BEGIN}\n${END}\n`);
    await pool.end();
    return;
  }

  const values = await platformEnv.getRawValues(pool, rows[0].id, config.jwtSecret);
  const keys = Object.keys(values).sort();

  const lines = [BEGIN];
  let skipped = 0;
  for (const key of keys) {
    const invalid = platformEnv.validateValue(values[key]);
    if (invalid) {
      skipped += 1;
      // The reason, never the value.
      console.error(`[dump-platform-env] Skipping ${key}: ${invalid}`);
      continue;
    }
    lines.push(envLine(key, values[key]));
  }
  lines.push(END);

  process.stdout.write(`${lines.join('\n')}\n`);
  console.error(
    `[dump-platform-env] Resolved ${keys.length - skipped} platform variable(s)`
    + (skipped ? `, skipped ${skipped}` : '')
  );
  await pool.end();
}

main().catch((err) => {
  // stderr only — stdout must never carry a partial block.
  console.error(`[dump-platform-env] FAILED: ${err && err.message}`);
  process.exit(1);
});
