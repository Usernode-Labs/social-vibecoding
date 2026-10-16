'use strict';

// The security bot's restricted source tools (services/security-bot/source-tools.js):
// one pinned root, allowlisted extensions, no traversal, no symlinks, no env or
// secret files, bounded reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSourceTools, SourceToolError } = require('../src/services/security-bot/source-tools');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secbot-src-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'server.js'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"target"}');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET_KEY=topsecret');
  fs.writeFileSync(path.join(root, 'signing.pem'), '-----BEGIN KEY-----');
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50]));
  // A secret outside the root the bot must never reach.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'secbot-outside-'));
  fs.writeFileSync(path.join(outside, 'host-secret.txt'), 'do not read');
  try { fs.symlinkSync(path.join(outside, 'host-secret.txt'), path.join(root, 'link.js')); } catch { /* best effort */ }
  return { root, outside };
}

test('reads an allowlisted source file within a bounded line range', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root });
  const out = tools.readFile('src/server.js', { startLine: 5, endLine: 7 });
  assert.equal(out.content, 'line 5\nline 6\nline 7');
  assert.equal(out.startLine, 5);
  assert.equal(out.endLine, 7);
  assert.equal(out.totalLines, 1000);
});

test('a line range is capped at the per-read ceiling', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root, maxLines: 10 });
  const out = tools.readFile('src/server.js', { startLine: 1, endLine: 1000 });
  assert.equal(out.endLine, 10);
  assert.equal(out.truncated, true);
});

test('traversal, absolute paths and escapes are refused', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root });
  for (const bad of ['../etc/passwd', 'src/../../etc', '/etc/passwd', 'src/..']) {
    assert.throws(() => tools.readFile(bad), SourceToolError);
  }
});

test('a symlink is refused, never followed out of the root', () => {
  const { root } = fixtureRoot();
  if (!fs.existsSync(path.join(root, 'link.js'))) return; // platform without symlink support
  const tools = createSourceTools({ root });
  assert.throws(() => tools.readFile('link.js'), /symlink_denied/);
});

test('env and secret files are refused even inside the root', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root });
  assert.throws(() => tools.readFile('.env'), /secret_file_denied/);
  assert.throws(() => tools.readFile('signing.pem'), /secret_file_denied/);
});

test('a non-allowlisted extension is refused', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root });
  assert.throws(() => tools.readFile('image.png'), /extension_denied/);
});

test('a file over the byte ceiling is refused', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root, maxBytes: 16 });
  assert.throws(() => tools.readFile('src/server.js'), /file_too_large/);
});

test('listing hides symlinks, secrets and non-source files', () => {
  const { root } = fixtureRoot();
  const tools = createSourceTools({ root });
  const names = tools.listDir('.').map((e) => e.name);
  assert.ok(names.includes('src'));
  assert.ok(names.includes('package.json'));
  assert.ok(!names.includes('.env'));
  assert.ok(!names.includes('signing.pem'));
  assert.ok(!names.includes('image.png'));
  assert.ok(!names.includes('link.js'));
});

test('an invalid root is refused at construction', () => {
  assert.throws(() => createSourceTools({ root: 'relative/path' }), /invalid_root/);
  assert.throws(() => createSourceTools({ root: '/no/such/dir/secbot' }), /root_unavailable/);
});
