'use strict';

// Before/after shots can be saved at the browser's device density: 3 on a
// phone (the iPhone 15 device), 2 on a desktop (write-shots-mcp-config.js).
// Experimental, off unless the platform switches it on for a run
// (services/shots-density.js). The pinned Playwright MCP saves every
// screenshot at CSS scale, so the worker image patches its screenshot tool
// (patch-playwright-mcp-screenshot.js) to follow SHOTS_SCREENSHOT_SCALE, and
// proves both modes in a real browser (verify-shots-browser-mcp.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchSource, EDITS } = require('../worker/patch-playwright-mcp-screenshot');
const { pngWidth } = require('../worker/verify-shots-browser-mcp');

const root = path.join(__dirname, '..');
// browser_take_screenshot's handler as @playwright/mcp 0.0.41 ships it
// (playwright 1.56.0-alpha-2025-10-01, lib/mcp/browser/tools/screenshot.js;
// Apache-2.0, Microsoft Corporation).
const HANDLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'playwright-mcp-0.0.41-screenshot-handle.txt'), 'utf8');

test('the patched tool saves at device scale only when asked, and always answers the agent at CSS scale', () => {
  assert.match(HANDLE, /scale: "css",\n {6}path: fileName,/, 'the fixture is the unpatched tool');
  const patched = patchSource(HANDLE);
  assert.match(patched, /scale: process\.env\.SHOTS_SCREENSHOT_SCALE === "device" \? "device" : "css",\n {6}path: fileName,/);
  // Asked (a run taken at device density), the file is the device-scale
  // capture and the image the model reads a second capture at CSS scale,
  // saved nowhere. Not asked, the one CSS-scale capture serves both, as before.
  assert.match(patched, /const buffer = locator \? await locator\.screenshot\(options\) : await tab\.page\.screenshot\(options\);/);
  assert.match(patched, /data: options\.scale === "css" \? buffer : await \(locator \? locator\.screenshot\(\{ \.\.\.options, path: void 0, scale: "css" \}\) : tab\.page\.screenshot\(\{ \.\.\.options, path: void 0, scale: "css" \}\)\)/);
  // A full-page screenshot still answers no image.
  assert.match(patched, /if \(!params\.fullPage\) \{\n {6}response\.addImage/);
  // Still a function the module can load.
  assert.doesNotThrow(() => new Function(`return { ${patched.replace(/\}\);\s*$/, '')} };`));
});

test('a Playwright version whose tool moved fails the image build instead of saving 1x shots', () => {
  assert.throws(() => patchSource(patchSource(HANDLE)), /no longer matches the density patch/, 'never applied twice');
  assert.throws(() => patchSource(HANDLE.replace('scale: "css"', 'scale: params.scale')), /no longer matches/);
  assert.throws(() => patchSource(HANDLE.replace('data: buffer', 'data: image')), /no longer matches/);
  assert.throws(() => patchSource(`${HANDLE}\n${EDITS[0][0]}`), /no longer matches/, 'an edit must match exactly once');
});

test('the worker image patches the tool right after installing it, and verifies the density after', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'worker', 'Dockerfile'), 'utf8');
  const install = dockerfile.indexOf('RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}');
  const copy = dockerfile.indexOf('COPY patch-playwright-mcp-screenshot.js /usr/local/bin/patch-playwright-mcp-screenshot.js');
  const patch = dockerfile.indexOf('RUN node /usr/local/bin/patch-playwright-mcp-screenshot.js');
  const verify = dockerfile.indexOf('RUN node /usr/local/bin/verify-shots-browser-mcp.js');
  assert.ok(install >= 0 && install < copy && copy < patch && patch < verify, 'install, patch, then verify');
  const verifier = fs.readFileSync(path.join(root, 'worker', 'verify-shots-browser-mcp.js'), 'utf8');
  assert.match(verifier, /const density = mode === 1 \? 1 : phone \? 3 : 2;/);
  assert.match(verifier, /verifyBrowser\(configs\[mode\]\.mcpServers\[persona\], \[\], \{ density \}\)/);
  assert.match(verifier, /\['browser_member', 'device'\], \['browser_member_phone', 'device'\]/);
  assert.match(verifier, /saved !== answered \* density/);
});

test('the verifier reads a PNG\'s width off its header', () => {
  const header = Buffer.alloc(33);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(1170, 16);
  assert.equal(pngWidth(header), 1170);
  assert.equal(pngWidth(Buffer.alloc(10)), 0);
  assert.equal(pngWidth(Buffer.from('not a png at all, just some text')), 0);
});
