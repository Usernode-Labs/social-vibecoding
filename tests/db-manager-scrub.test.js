// The template and its clones are scrubbed independently. A ctid-only
// placeholder can collide with an existing placeholder on a second scrub,
// so every pass reserves a new namespace before updating NOT NULL columns.
//
// Run with: node --test tests/db-manager-scrub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// scrubPrivateColumns issues one discovery SELECT, then one UPDATE per
// discovered column. `discoveryRows` is the canned psql -At output (one
// line per column) for the discovery query.
function loadDbManager(discoveryRows, occupiedAnswers = []) {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const updateCalls = [];
  const reservationCalls = [];
  const fakeExecFile = (cmd, args) => {
    const sql = args[args.indexOf('-c') + 1];
    if (/col_description/.test(sql)) {
      return Promise.resolve({ stdout: discoveryRows.join('\n') + '\n', stderr: '' });
    }
    if (/SELECT EXISTS/.test(sql)) {
      reservationCalls.push(sql);
      return Promise.resolve({ stdout: `${occupiedAnswers.shift() || 'f'}\n`, stderr: '' });
    }
    if (/^UPDATE/.test(sql)) {
      updateCalls.push(sql);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  };
  return { dbManager, updateCalls, reservationCalls, restore };
}

test('scrubPrivateColumns reserves a fresh namespace and keeps the entire per-row suffix', async () => {
  // Mirrors public.onchain_accounts.registration_code: VARCHAR(64) NOT NULL UNIQUE.
  const { dbManager, updateCalls, reservationCalls, restore } = loadDbManager([
    'public.onchain_accounts|registration_code|t|64',
  ]);
  try {
    const result = await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    const match = /^UPDATE public\.onchain_accounts SET registration_code = '(__staging_redacted__[0-9a-f]{16}:)' \|\| ctid::text$/.exec(updateCalls[0]);
    assert.ok(match, 'the unique ctid suffix is never truncated');
    assert.ok(match[1].length + 18 <= 64);
    assert.match(reservationCalls[0], /SELECT EXISTS \(SELECT 1 FROM public\.onchain_accounts WHERE left\(registration_code::text, 37\) = '__staging_redacted__[0-9a-f]{16}:'\)/);
    assert.deepEqual(result.scrubbed, ['public.onchain_accounts.registration_code']);
  } finally {
    restore();
  }
});

test('scrubPrivateColumns omits the length cap for an unbounded NOT NULL column', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.some_table|some_col|t|',
  ]);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    assert.match(updateCalls[0], /^UPDATE public\.some_table SET some_col = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text$/);
  } finally {
    restore();
  }
});

test('an occupied namespace is rejected before updating the column', async () => {
  const { dbManager, updateCalls, reservationCalls, restore } = loadDbManager([
    'public.onchain_accounts|registration_code|t|64',
  ], ['t', 'f']);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(reservationCalls.length, 2);
    assert.equal(updateCalls.length, 1);
    const firstPrefix = reservationCalls[0].match(/= '([^']+)'/)[1];
    const secondPrefix = reservationCalls[1].match(/= '([^']+)'/)[1];
    assert.notEqual(firstPrefix, secondPrefix);
    assert.ok(updateCalls[0].includes(`'${secondPrefix}'`));
  } finally {
    restore();
  }
});

test('a VARCHAR(32) private code uses a compact, still unique namespace', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.short_codes|code|t|32',
  ]);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.match(updateCalls[0], /^UPDATE public\.short_codes SET code = '~[0-9a-f]{8}:' \|\| ctid::text$/);
  } finally {
    restore();
  }
});

test('a short NOT NULL column fails closed before a truncated value could collide', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.short_codes|code|t|20',
  ]);
  try {
    await assert.rejects(dbManager.scrubPrivateColumns('app_demo_staging_x_abc123'),
      /max length 20 cannot hold unique redaction values/);
    assert.deepEqual(updateCalls, []);
  } finally {
    restore();
  }
});

test('scrubPrivateColumns still NULLs out nullable columns (no per-row placeholder needed)', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.users|email_confirmation_token|f|255',
  ]);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0], 'UPDATE public.users SET email_confirmation_token = NULL');
  } finally {
    restore();
  }
});
