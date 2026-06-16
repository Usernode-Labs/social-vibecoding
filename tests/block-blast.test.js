// Tests for src/routes/block-blast.js
//
// Route-handler tests that mount blockBlastRoutes() on a throwaway Express
// app, swap getPool() out for an in-memory mock, and assert on HTTP status
// + response body for the cases the spec calls out:
//   - POST without auth                          → 401
//   - POST when usernode_pubkey is NULL           → 403
//   - POST with valid score (new user)            → 200 + personal_best
//   - POST with higher score (upsert keeps best) → 200, best updated
//   - POST with lower score (upsert keeps old)   → 200, best unchanged
//   - GET leaderboard rows sorted descending      → 200 + rows[]
//   - walletShort format (first-6 … last-4)       → verified on leaderboard
//
// Run with: node --test tests/block-blast.test.js
//
// No real Postgres needed. The mock pool returns canned rows based on SQL
// pattern matching.

const test = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const express = require('express');

// ── Pool-swap helper ─────────────────────────────────────────────────────

function withMockPool(mockPool, fn) {
  const poolPath = require.resolve('../src/db/pool');
  const bbPath   = require.resolve('../src/routes/block-blast');
  const logPath  = require.resolve('../src/services/logger');

  const origPool = require.cache[poolPath];
  const origBb   = require.cache[bbPath];

  // Stub logger so we don't see output during tests
  const origLog = require.cache[logPath];
  require.cache[logPath] = {
    exports: { error: () => {}, warn: () => {}, info: () => {} },
    loaded: true, id: logPath, filename: logPath,
    paths: origLog ? origLog.paths : [],
  };

  require.cache[poolPath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolPath, filename: poolPath,
    paths: origPool ? origPool.paths : [],
  };
  delete require.cache[bbPath];

  try {
    return fn();
  } finally {
    if (origPool) require.cache[poolPath] = origPool;
    else delete require.cache[poolPath];
    if (origBb) require.cache[bbPath] = origBb;
    else delete require.cache[bbPath];
    if (origLog) require.cache[logPath] = origLog;
    else delete require.cache[logPath];
    delete require.cache[bbPath];
  }
}

// ── Mini HTTP helper ─────────────────────────────────────────────────────

async function request(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body != null) req.write(JSON.stringify(body));
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// ── Mock pool factory ─────────────────────────────────────────────────────

function makeMockPool({ walletPubkey = 'ut1abcdefghij1234', scores = new Map() } = {}) {
  const localScores = new Map(scores); // user_id → score

  return {
    async query(sql, params = []) {
      const s = String(sql);

      // SELECT usernode_pubkey FROM users WHERE id = $1
      if (/SELECT usernode_pubkey FROM users WHERE id = \$1/i.test(s)) {
        return { rows: [{ usernode_pubkey: walletPubkey }] };
      }

      // INSERT INTO block_blast_scores ... RETURNING score AS personal_best
      if (/INSERT INTO block_blast_scores/i.test(s)) {
        const [userId, , incomingScore] = params;
        const existing = localScores.get(userId) ?? null;
        const newBest = existing === null ? incomingScore : Math.max(existing, incomingScore);
        localScores.set(userId, newBest);
        return { rows: [{ personal_best: newBest }] };
      }

      // SELECT b.score, u.username, u.usernode_pubkey FROM block_blast_scores
      if (/SELECT b\.score[\s\S]*FROM block_blast_scores/i.test(s)) {
        return {
          rows: [
            { score: 3200, username: 'alice', usernode_pubkey: 'ut1aabbccddeeff1111' },
            { score: 2750, username: 'bob',   usernode_pubkey: 'ut1bbbbccccdddd2222' },
            { score: 880,  username: 'carol', usernode_pubkey: 'ut1ccccddddeeee3333' },
          ],
        };
      }

      return { rows: [] };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('POST /api/block-blast/scores → 401 when not authenticated', async () => {
  const pool = makeMockPool();
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    // No req.user injected → unauthenticated
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 100 });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });
});

test('POST /api/block-blast/scores → 403 when wallet not linked', async () => {
  const pool = makeMockPool({ walletPubkey: null });
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); });
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 100 });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'Wallet not linked');
    } finally {
      server.close();
    }
  });
});

test('POST /api/block-blast/scores → 200 with personalBest on first submit', async () => {
  const pool = makeMockPool();
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 42, username: 'tester' }; next(); });
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 1500 });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.personalBest, 1500);
    } finally {
      server.close();
    }
  });
});

test('Score upsert keeps the higher score — lower submission leaves best unchanged', async () => {
  // Seed an existing score of 2000 for user 7
  const pool = makeMockPool({ scores: new Map([[7, 2000]]) });
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      // Submit a LOWER score
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 800 });
      assert.equal(res.status, 200);
      // Personal best must remain the old higher value
      assert.equal(res.body.personalBest, 2000);
    } finally {
      server.close();
    }
  });
});

test('Score upsert updates personal best when new score is higher', async () => {
  const pool = makeMockPool({ scores: new Map([[9, 500]]) });
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 9, username: 'tester' }; next(); });
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 3100 });
      assert.equal(res.status, 200);
      assert.equal(res.body.personalBest, 3100);
    } finally {
      server.close();
    }
  });
});

test('GET /api/block-blast/leaderboard returns rows sorted descending', async () => {
  const pool = makeMockPool();
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'GET', '/api/block-blast/leaderboard');
      assert.equal(res.status, 200);
      const rows = res.body.rows;
      assert.ok(Array.isArray(rows));
      assert.ok(rows.length > 0);
      // Verify descending order
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1].score >= rows[i].score,
          `Row ${i-1} score ${rows[i-1].score} should be >= row ${i} score ${rows[i].score}`);
      }
      // Verify rank field
      assert.equal(rows[0].rank, 1);
      assert.equal(rows[1].rank, 2);
    } finally {
      server.close();
    }
  });
});

test('Leaderboard walletShort is first-6 + ellipsis + last-4', async () => {
  const pool = makeMockPool();
  await withMockPool(pool, async () => {
    const { blockBlastRoutes, walletShort } = require('../src/routes/block-blast');

    // Unit-test walletShort directly
    assert.equal(walletShort('ut1aabbccddeeff1111'), 'ut1aab…1111');
    assert.equal(walletShort('abcdefXXXXyyyy'), 'abcdef…yyyy');
    assert.equal(walletShort('short'), 'short'); // < 10 chars: returned as-is
    assert.equal(walletShort(''), '');
    assert.equal(walletShort(null), '');

    // Also verify walletShort appears in leaderboard response
    const app = express();
    app.use(express.json());
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'GET', '/api/block-blast/leaderboard');
      const rows = res.body.rows;
      // ut1aabbccddeeff1111 → ut1aab…1111
      assert.equal(rows[0].walletShort, 'ut1aab…1111');
    } finally {
      server.close();
    }
  });
});

test('POST /api/block-blast/scores → 400 for non-integer score', async () => {
  const pool = makeMockPool();
  await withMockPool(pool, async () => {
    const { blockBlastRoutes } = require('../src/routes/block-blast');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); });
    app.use(blockBlastRoutes({}));
    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/api/block-blast/scores', { score: 'lots' });
      assert.equal(res.status, 400);
    } finally {
      server.close();
    }
  });
});
