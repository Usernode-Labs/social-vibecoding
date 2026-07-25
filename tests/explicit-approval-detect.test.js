// Tests for #788 explicit-approval DETECTION — normalizeAdmins /
// adminsFromManifestSource / detectAdminsChange in
// src/services/app-admins.js.
//
// The load-bearing property: a proposal is flagged only when the admins
// SET actually moves. Reformatting the manifest, reordering the names,
// or recasing them must not flag — otherwise every routine dapp.json
// edit would silently switch off the app's merge timers.
//
// Run with: node --test tests/explicit-approval-detect.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const APP = { id: 5, slug: 'chess', repo_url: 'https://github.com/bot/chess' };

// Swap services/github for a stub returning scripted file contents per
// ref. Restored after each call so tests stay independent.
function withGithub({ main, head, enabled = true, throws = false }, fn) {
  const key = require.resolve('../src/services/github');
  const original = require.cache[key];
  require.cache[key] = {
    id: key,
    filename: key,
    loaded: true,
    exports: {
      isEnabled: () => enabled,
      getFileContent: async (owner, repo, file, ref) => {
        if (throws) throw new Error('GitHub is down');
        return ref === 'main' ? main : head;
      },
    },
  };
  // app-admins requires github lazily, so the stub binds on next call.
  return Promise.resolve(fn()).finally(() => {
    if (original) require.cache[key] = original;
    else delete require.cache[key];
  });
}

const appAdmins = require('../src/services/app-admins');
const json = (obj) => JSON.stringify(obj, null, 2);

// ── normalizeAdmins ───────────────────────────────────────────────────

test('normalizeAdmins lowercases, trims, dedupes and sorts', () => {
  assert.deepEqual(appAdmins.normalizeAdmins(['Bob', ' alice ', 'ALICE']), ['alice', 'bob']);
  assert.deepEqual(appAdmins.normalizeAdmins([]), []);
  assert.deepEqual(appAdmins.normalizeAdmins(null), []);
  assert.deepEqual(appAdmins.normalizeAdmins('alice'), []);
  assert.deepEqual(appAdmins.normalizeAdmins([1, null, '', 'a']), ['a']);
});

// ── adminsFromManifestSource ──────────────────────────────────────────

test('adminsFromManifestSource treats missing/garbage sources as an empty roster', () => {
  assert.deepEqual(appAdmins.adminsFromManifestSource(null), []);
  assert.deepEqual(appAdmins.adminsFromManifestSource(undefined), []);
  assert.deepEqual(appAdmins.adminsFromManifestSource('{not json'), []);
  assert.deepEqual(appAdmins.adminsFromManifestSource('{}'), []);
  assert.deepEqual(appAdmins.adminsFromManifestSource(json({ admins: 'alice' })), []);
});

test('adminsFromManifestSource normalizes a real block', () => {
  assert.deepEqual(
    appAdmins.adminsFromManifestSource(json({ admins: ['Bob', 'alice'] })),
    ['alice', 'bob']
  );
});

// ── detectAdminsChange: non-changes ───────────────────────────────────

test('reordering the same names is NOT a change', () => withGithub({
  main: json({ admins: ['alice', 'bob'] }),
  head: json({ admins: ['bob', 'alice'] }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'feat/x' });
  assert.equal(r.changed, false);
  assert.deepEqual(r.from, ['alice', 'bob']);
  assert.deepEqual(r.to, ['alice', 'bob']);
}));

test('recasing the same names is NOT a change', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: ['ALICE'] }),
}, async () => {
  assert.equal((await appAdmins.detectAdminsChange(APP, { headRef: 'x' })).changed, false);
}));

test('reformatting the file (whitespace, key order, other blocks) is NOT a change', () => withGithub({
  main: '{"admins":["alice"],"name":"Chess"}',
  head: json({ name: 'Chess', visibility: { build: 'public' }, admins: ['  alice  '] }),
}, async () => {
  assert.equal((await appAdmins.detectAdminsChange(APP, { headRef: 'x' })).changed, false);
}));

test('no admins block on either side is NOT a change', () => withGithub({
  main: json({ name: 'Chess' }),
  head: json({ name: 'Chess Club' }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.changed, false);
  assert.deepEqual(r.from, []);
  assert.deepEqual(r.to, []);
}));

// ── detectAdminsChange: real changes ──────────────────────────────────

test('adding a name IS a change', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: ['alice', 'bob'] }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.from, ['alice']);
  assert.deepEqual(r.to, ['alice', 'bob']);
}));

test('removing a name IS a change', () => withGithub({
  main: json({ admins: ['alice', 'bob'] }),
  head: json({ admins: ['alice'] }),
}, async () => {
  assert.equal((await appAdmins.detectAdminsChange(APP, { headRef: 'x' })).changed, true);
}));

test('adding the block for the first time IS a change', () => withGithub({
  main: json({ name: 'Chess' }),
  head: json({ name: 'Chess', admins: ['alice'] }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.from, []);
}));

test('deleting the block IS a change', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ name: 'Chess' }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.to, []);
}));

test('emptying the block to [] IS a change (that is how a roster is cleared)', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: [] }),
}, async () => {
  assert.equal((await appAdmins.detectAdminsChange(APP, { headRef: 'x' })).changed, true);
}));

test('swapping one name for another IS a change', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: ['mallory'] }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.from, ['alice']);
  assert.deepEqual(r.to, ['mallory']);
}));

// ── Degradation ───────────────────────────────────────────────────────

test('no headRef / GitHub disabled / unparseable repo_url are INDETERMINATE, not "unchanged"', async () => {
  // The distinction matters: an indeterminate result must never be
  // allowed to overwrite a stored `true`, or a thin session row would
  // silently un-flag a proposal and hand back the merge timers.
  await withGithub({ main: json({ admins: ['a'] }), head: json({ admins: ['b'] }) }, async () => {
    const noRef = await appAdmins.detectAdminsChange(APP, {});
    assert.equal(noRef.determinate, false);
    assert.equal(noRef.changed, false);

    const noRepo = await appAdmins.detectAdminsChange({ ...APP, repo_url: null }, { headRef: 'x' });
    assert.equal(noRepo.determinate, false);
  });
  await withGithub({ main: null, head: null, enabled: false }, async () => {
    const off = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
    assert.equal(off.determinate, false);
  });
});

test('a real comparison is marked determinate', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: ['alice'] }),
}, async () => {
  const r = await appAdmins.detectAdminsChange(APP, { headRef: 'x' });
  assert.equal(r.determinate, true);
  assert.equal(r.changed, false, 'determinate AND unchanged is a real, trustworthy verdict');
}));

test('refreshExplicitApproval does not stamp an INDETERMINATE result', () => withGithub({
  main: null, head: null, enabled: false,
}, async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const out = await appAdmins.refreshExplicitApproval(pool, APP, { id: 42, branch_name: 'b' });
  assert.equal(out, null);
  assert.equal(calls.length, 0, 'a stored true must survive an unreadable manifest');
}));

test('a transport error PROPAGATES so callers pick their own fallback', () => withGithub({
  throws: true,
}, async () => {
  await assert.rejects(
    () => appAdmins.detectAdminsChange(APP, { headRef: 'x' }),
    /GitHub is down/
  );
}));

// ── refreshExplicitApproval ───────────────────────────────────────────

test('refreshExplicitApproval stamps the resolved verdict', () => withGithub({
  main: json({ admins: [] }),
  head: json({ admins: ['alice'] }),
}, async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const out = await appAdmins.refreshExplicitApproval(pool, APP,
    { id: 42, branch_name: 'feat/admins' });
  assert.equal(out, true);
  const stamp = calls.find((c) => /requires_explicit_approval/.test(c.sql));
  assert.deepEqual(stamp.params, [42, true, 'admins']);
}));

test('refreshExplicitApproval clears the reason when not flagged', () => withGithub({
  main: json({ admins: ['alice'] }),
  head: json({ admins: ['alice'] }),
}, async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  assert.equal(await appAdmins.refreshExplicitApproval(pool, APP, { id: 42, branch_name: 'b' }), false);
  assert.deepEqual(calls[0].params, [42, false, null]);
}));

test('refreshExplicitApproval swallows a GitHub failure and leaves the flag alone', () => withGithub({
  throws: true,
}, async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const out = await appAdmins.refreshExplicitApproval(pool, APP, { id: 42, branch_name: 'b' });
  assert.equal(out, null, 'null means "could not determine"');
  assert.equal(calls.length, 0, 'nothing is stamped on an indeterminate result');
}));

test('an imported proposal is diffed against its head SHA, not its branch', () => {
  const seen = [];
  const key = require.resolve('../src/services/github');
  const original = require.cache[key];
  require.cache[key] = {
    id: key, filename: key, loaded: true,
    exports: {
      isEnabled: () => true,
      getFileContent: async (o, r, f, ref) => { seen.push(ref); return '{}'; },
    },
  };
  const pool = { query: async () => ({ rows: [] }) };
  return appAdmins.refreshExplicitApproval(pool, APP, {
    id: 7, source: 'imported', imported_pr_head_sha: 'deadbeef', branch_name: 'ignored',
  }).then(() => {
    assert.ok(seen.includes('deadbeef'), `expected the head sha to be fetched, saw ${seen}`);
    assert.ok(!seen.includes('ignored'));
  }).finally(() => {
    if (original) require.cache[key] = original; else delete require.cache[key];
  });
});
