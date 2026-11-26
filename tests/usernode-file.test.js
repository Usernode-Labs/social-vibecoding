'use strict';

// #7136: worker/usernode-file saves a file the request carries into the
// build's working tree. What matters here is the boundary: build mode only,
// never outside the working tree, never through a symlink, and a reply over
// the chat's own 20 MB ceiling is refused.
//
// Run with: node --test tests/usernode-file.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'worker', 'usernode-file');
const FILE_ID = 'a'.repeat(32);
const PAYLOAD = Buffer.from('PK\x03\x04 a small zip, pretend');

function run(args, env = {}, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* usage prints no JSON */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-file-'));
}

/** A stand-in platform answering the request-files route. */
async function platform({ body = PAYLOAD, status = 200, contentType = 'application/zip', filename = 'site.zip' } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url !== `/api/internal/sessions/7/request-files/${FILE_ID}`) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'This request carries no such file.' }));
      return;
    }
    if (req.headers.authorization !== 'Bearer worker-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'refused' }));
      return;
    }
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-file-name': encodeURIComponent(filename),
    });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('usernode-file', { timeout: 120000 }, async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, url } = await platform();
  t.after(() => new Promise((r) => server.close(r)));
  const env = { WORKER_JWT: 'worker-token', SESSION_ID: '7', PLATFORM_URL: url };

  await t.test('writes the file the request carries, into the working tree', async () => {
    const out = await run(['--from', FILE_ID, '--out', 'data/site.zip'], env, dir);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.path, path.join('data', 'site.zip'));
    assert.equal(out.json.name, 'site.zip');
    assert.equal(out.json.contentType, 'application/zip');
    assert.equal(out.json.bytes, PAYLOAD.length);
    assert.equal(fs.readFileSync(path.join(dir, 'data/site.zip')).toString('hex'), PAYLOAD.toString('hex'));
    // Written to a .part file and renamed: nothing half-written is left.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), ['site.zip']);
  });

  await t.test('a refracted id says so and writes nothing', async () => {
    const out = await run(['--from', 'b'.repeat(32), '--out', 'nope.zip'], env, dir);
    assert.equal(out.code, 1);
    assert.equal(out.json.ok, false);
    assert.match(out.json.message, /This request carries no such file/);
    assert.equal(fs.existsSync(path.join(dir, 'nope.zip')), false);
  });

  await t.test('it works only in a build turn', async () => {
    const out = await run(['--from', FILE_ID, '--out', 'x.zip'], { PLATFORM_URL: url }, dir);
    assert.equal(out.code, 1);
    assert.match(out.json.message, /usernode-file works only in a build turn\./);
    assert.equal(fs.existsSync(path.join(dir, 'x.zip')), false);
  });

  await t.test('usage errors exit 2', async () => {
    const noOut = await run(['--from', FILE_ID], env, dir);
    assert.equal(noOut.code, 2);
    assert.match(noOut.json.message, /^usage: usernode-file --from <id> --out <path>$/);
    const noFrom = await run(['--out', 'x.zip'], env, dir);
    assert.equal(noFrom.code, 2);
    const extra = await run(['--from', FILE_ID, '--out', 'x.zip', 'stray'], env, dir);
    assert.equal(extra.code, 2);
    const unknown = await run(['--from', FILE_ID, '--out', 'x.zip', '--force'], env, dir);
    assert.equal(unknown.code, 2);
  });

  await t.test('never outside the working tree', async () => {
    const outside = path.join(os.tmpdir(), `usernode-file-outside-${process.pid}.zip`);
    for (const [label, target] of [
      ['an absolute path', outside],
      ['a path through ..', '../escape.zip'],
      ['a deeper .. escape', 'data/../../escape.zip'],
      ['a leading dash', '-x.zip'],
      ['anything under .git', '.git/hooks/pre-commit'],
    ]) {
      const out = await run(['--from', FILE_ID, '--out', target], env, dir);
      assert.equal(out.code, 2, label);
      assert.match(out.json.message, /--out must be a path inside this repository/, label);
    }
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape.zip')), false);
  });

  await t.test('never through a symlink', async () => {
    const outside = tmpdir();
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    // A directory symlinked out of the tree.
    fs.symlinkSync(outside, path.join(dir, 'shipped'));
    const throughDir = await run(['--from', FILE_ID, '--out', 'shipped/site.zip'], env, dir);
    assert.equal(throughDir.code, 2, 'a parent that resolves outside the tree is refused');
    assert.equal(fs.existsSync(path.join(outside, 'site.zip')), false);
    // A file that is already a symlink.
    fs.writeFileSync(path.join(outside, 'real.zip'), 'nothing');
    fs.symlinkSync(path.join(outside, 'real.zip'), path.join(dir, 'link.zip'));
    const throughFile = await run(['--from', FILE_ID, '--out', 'link.zip'], env, dir);
    assert.equal(throughFile.code, 2, 'an existing symlink is refused');
    assert.equal(fs.readFileSync(path.join(outside, 'real.zip'), 'utf8'), 'nothing', 'and its target is untouched');
  });

  await t.test('a reply over 20 MB is refused, and nothing is written', async () => {
    const big = await platform({ body: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20) });
    t.after(() => new Promise((r) => big.server.close(r)));
    const out = await run(['--from', FILE_ID, '--out', 'big.zip'], { ...env, PLATFORM_URL: big.url }, dir);
    assert.equal(out.code, 1);
    assert.match(out.json.message, /over 20 MB/);
    assert.equal(fs.existsSync(path.join(dir, 'big.zip')), false);
  });
});
