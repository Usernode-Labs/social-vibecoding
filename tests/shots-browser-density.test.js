'use strict';

// Before/after shots can be saved at the browser's device density: 3 on a
// phone (the iPhone 15 device), 2 on a desktop (write-shots-mcp-config.js).
// Experimental, off unless the platform switches it on for a run
// (services/shots-density.js). The pinned Playwright MCP saves every
// screenshot at the scale it is asked for, so the worker image patches its
// bundled tools (patch-playwright-mcp.js) to follow SHOTS_SCREENSHOT_SCALE,
// to answer a named screenshot with its image, to take close-ups and to keep
// the page snapshot in an action's answer, and proves them in a real browser
// (verify-shots-browser-mcp.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { patchSource, EDITS } = require('../worker/patch-playwright-mcp');
const { pngWidth } = require('../worker/verify-shots-browser-mcp');

const root = path.join(__dirname, '..');
// From @playwright/mcp 0.0.85's playwright-core 1.66.0-alpha-2026-11-09,
// lib/coreBundle.js (Apache-2.0, Microsoft Corporation): where an answer's
// files are saved, the three lines of the answer renderer that decide where
// an action's snapshot goes, then the whole browser_take_screenshot tool.
const HANDLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'playwright-mcp-0.0.85-screenshot.txt'), 'utf8');
// The tool on its own is a whole piece of the bundle that parses.
const toolOf = (text) => text.slice(text.indexOf('// packages/playwright-core/src/tools/backend/screenshot.ts'));
const handlerOf = (text) => text.slice(text.indexOf('handle: async (tab2, params2, response2) => {'));

test('the patched tool saves at device scale only when asked, and always answers the agent at CSS scale', () => {
  assert.match(HANDLE, /scale: params2\.scale,\n/, 'the fixture is the unpatched tool');
  const patched = patchSource(HANDLE);
  assert.match(patched, /scale: process\.env\.SHOTS_SCREENSHOT_SCALE === "device" \? "device" : params2\.scale,\n/);
  // Asked (a run taken at device density), the file is the device-scale
  // capture and the image the model reads a second capture at CSS scale,
  // saved nowhere. Not asked, the one capture serves both, as before.
  assert.match(patched, /const data = target \? await target\.locator\.screenshot\(options\) : await tab2\.page\.screenshot\(options\);/);
  assert.match(patched, /registerImageResult\(options\.scale === "css" \? data : await \(target \? target\.locator\.screenshot\(\{ \.\.\.options, scale: "css" \}\) : tab2\.page\.screenshot\(\{ \.\.\.options, scale: "css" \}\)\), fileType\);/);
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', toolOf(patched)));
});

// The shots agent names every screenshot it saves and looks at it first.
// Upstream answers a named screenshot with its file alone.
test('a named screenshot answers with its image too; a full page still answers none', () => {
  assert.match(HANDLE, /if \(!params2\.filename\)\n {10}await response2\.registerImageResult\(data, fileType\);/);
  const patched = patchSource(HANDLE);
  assert.doesNotMatch(patched, /if \(!params2\.filename\)/);
  assert.match(patched, /if \(!params2\.fullPage\)\n {10}await response2\.registerImageResult\(/);
  assert.equal(patched.split('registerImageResult(').length - 1, 1);
});

// The shots agent has no file tools, and every prompt expects the page in an
// action's answer: upstream links a file instead.
test('an action answers with the page snapshot, unless a snapshot is saved to a named file', () => {
  const patched = patchSource(HANDLE);
  assert.match(patched, /const snapshotToFile = !!this\._includeSnapshotFileName;/);
  assert.doesNotMatch(patched, /_includeSnapshot !== "explicit" \|\|/);
});

// A named file used to go into --output-dir, like an unnamed one; upstream
// saves it against the client's workspace root, which for a build turn is
// the app checkout its commit step would ship, and for a shots browser not
// the directory the shots bridge reads.
test('a file saved under a given name goes into the output directory, as an unnamed one does', () => {
  assert.match(HANDLE, /if \(template\.suggestedFilename\)\n {10}fileName = await this\.resolveClientFilename/);
  const patched = patchSource(HANDLE);
  const resolver = patched.slice(patched.indexOf('async resolveClientOutputFile('), patched.indexOf('async resolveClientFilename('));
  assert.match(resolver, /let fileName;\n {8}fileName = await this\._context\.outputFile\(template, \{ origin: "llm" \}\);/);
  assert.doesNotMatch(resolver, /resolveClientFilename\(template/);
  // An input (an upload's paths) still resolves against the workspace.
  assert.match(patched, /async resolveClientFilename\(filename\) \{\n {8}return await this\._context\.workspaceFile\(filename, this\._clientWorkspace\);/);
});

test('the patched tool takes a close-up of a screen region at a density, through Chrome\'s own clip.scale', () => {
  const patched = patchSource(HANDLE);
  // The shots tools' own argument, in the tool's schema.
  assert.match(patched, /closeup: z23\.object\(\{ x: z23\.number\(\)\.min\(0\), y: z23\.number\(\)\.min\(0\), width: z23\.number\(\)\.positive\(\), height: z23\.number\(\)\.positive\(\), scale: z23\.number\(\)\.min\(1\)\.max\(16\) \}\)\.optional\(\)/);
  // Handled first: the region is the viewport's, Chrome's clip the document's.
  const handler = handlerOf(patched);
  assert.ok(handler.indexOf('if (params2.closeup)') < handler.indexOf('const fileType'), 'before an ordinary screenshot');
  assert.match(handler, /visualViewport\.pageLeft/);
  assert.match(handler, /visualViewport\.scale/);
  // In whole page pixels: Chrome cuts a fractional clip down before scaling
  // it, so a zoomed-out phone page saved 128 x 63 for 130 x 65.
  assert.match(handler, /Page\.captureScreenshot", \{ format: "png", clip: \{ x: Math\.round\(at\.x \+ c\.x \/ at\.k\), y: Math\.round\(at\.y \+ c\.y \/ at\.k\), width: Math\.max\(1, Math\.round\(c\.width \/ at\.k\)\), height: Math\.max\(1, Math\.round\(c\.height \/ at\.k\)\), scale: c\.scale \* at\.k \} \}/);
  assert.match(handler, /cdp\.detach\(\)/);
  // It answers with no image: nobody but the shots tools reads it.
  const closeup = handler.slice(handler.indexOf('if (params2.closeup)'), handler.indexOf('const fileType'));
  assert.doesNotMatch(closeup, /registerImageResult/);
  assert.match(closeup, /suggestedFilename: params2\.filename/, 'saved under the name it is given, as an ordinary screenshot is');
  assert.match(closeup, /addTextResult\(resolvedFile\.printableLink\)/, 'the answer names the file as an ordinary screenshot does');
});

// #6379: the agent does not always call browser_wait_for first, so a thread
// that rendered just after the page went idle was missing from a shot. With
// SHOTS_SCREENSHOT_SETTLE (every shots browser) each screenshot waits for the
// page to settle first.
test('with SHOTS_SCREENSHOT_SETTLE a screenshot waits for the page to settle, close-ups excepted', () => {
  const patched = patchSource(HANDLE);
  const handler = handlerOf(patched);
  // The close-up branch has returned before it, and it is before the capture.
  assert.ok(handler.indexOf('if (params2.closeup)') < handler.indexOf('SHOTS_SCREENSHOT_SETTLE'));
  assert.ok(handler.indexOf('SHOTS_SCREENSHOT_SETTLE') < handler.indexOf('const data = target ?'));
  assert.match(patched, /if \(process\.env\.SHOTS_SCREENSHOT_SETTLE === "1"\) \{/);
  assert.equal(patched.split('const data = target ?').length - 1, 1);
  // A quarter of a second of quiet, three seconds at most, and never a
  // failure of its own: an evaluate that errors is swallowed.
  assert.match(patched, /await tab2\.page\.evaluate\(settleInPage, \{ quietMs: 250, maxMs: 3000 \}\)\.catch\(\(\) => \{\}\);/);
  assert.match(patched, /while \(Date\.now\(\) - startedAt < maxMs\)/);
  assert.match(patched, /if \(now === previous && \(window\.__usernodeShotsInFlight \|\| 0\) === 0\) return;/);
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', toolOf(patched)));
});

// The wait itself, run as the browser runs it: quiet and no requests.
function settleHarness(patched) {
  const start = patched.indexOf('const settleInPage = ');
  const end = patched.indexOf('\n          };', start) + '\n          };'.length;
  let clock = 0;
  let ticks = 0;
  const sandbox = {
    window: { __usernodeShotsInFlight: 0 },
    document: { getElementsByTagName: () => ({ length: 10 }), body: { textContent: 'a thread' } },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { ticks += 1; clock += ms; fn(); },
  };
  vm.runInNewContext(`${patched.slice(start, end)}\nglobalThis.settleInPage = settleInPage;`, sandbox);
  return { settleInPage: sandbox.settleInPage, sandbox, clock: () => clock, ticks: () => ticks };
}

test('the wait ends on a quiet page at once and gives up after the 3 second cap', async () => {
  const patched = patchSource(HANDLE);
  const quiet = settleHarness(patched);
  await quiet.settleInPage({ quietMs: 250, maxMs: 3000 });
  assert.equal(quiet.ticks(), 1, 'one quarter-second reading is enough');
  assert.equal(quiet.clock(), 250);

  // A request still running: the page does not read as finished.
  const busy = settleHarness(patched);
  busy.sandbox.window.__usernodeShotsInFlight = 1;
  await busy.settleInPage({ quietMs: 250, maxMs: 3000 });
  assert.equal(busy.clock(), 3000, 'no longer than the cap');

  // A page that keeps changing: same, and it resolves rather than throwing.
  const moving = settleHarness(patched);
  let words = 0;
  moving.sandbox.document.body.textContent = 'x';
  moving.sandbox.document.getElementsByTagName = () => ({ length: 10 });
  const counting = moving.sandbox.document;
  Object.defineProperty(counting.body, 'textContent', { get: () => 'x'.repeat((words += 1)) });
  await moving.settleInPage({ quietMs: 250, maxMs: 3000 });
  assert.equal(moving.clock(), 3000);
});

test('a Playwright version whose code moved fails the image build instead of saving 1x shots', () => {
  assert.throws(() => patchSource(patchSource(HANDLE)), /no longer matches the worker's patch/, 'never applied twice');
  assert.throws(() => patchSource(HANDLE.replace('scale: params2.scale,', 'scale: params2.scale ?? "css",')), /no longer matches/);
  assert.throws(() => patchSource(HANDLE.replace('registerImageResult(data, fileType)', 'registerImageResult(image, fileType)')), /no longer matches/);
  assert.throws(() => patchSource(HANDLE.replace('const snapshotToFile = this', 'const toFile = this')), /no longer matches/);
  assert.throws(() => patchSource(`${HANDLE}\n${EDITS[0][0]}`), /no longer matches/, 'an edit must match exactly once');
});

test('the worker image patches the tool right after installing it, and verifies the density after', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'worker', 'Dockerfile'), 'utf8');
  const install = dockerfile.indexOf('npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}');
  const copy = dockerfile.indexOf('COPY patch-playwright-mcp.js /usr/local/bin/patch-playwright-mcp.js');
  const patch = dockerfile.indexOf('RUN node /usr/local/bin/patch-playwright-mcp.js');
  const verify = dockerfile.indexOf('RUN node /usr/local/bin/verify-shots-browser-mcp.js');
  assert.ok(install >= 0 && install < copy && copy < patch && patch < verify, 'install, patch, then verify');
  const verifier = fs.readFileSync(path.join(root, 'worker', 'verify-shots-browser-mcp.js'), 'utf8');
  assert.match(verifier, /const density = mode === 1 \? 1 : 3;/);
  assert.match(verifier, /verifyBrowser\(configs\[mode\]\.mcpServers\[persona\], \[\], \{ density, closeup: mode !== 1, clip: true \}\)/);
  assert.match(verifier, /\['browser_member', 'device'\], \['browser_member_phone', 'device'\]/);
  assert.match(verifier, /saved !== answered \* density/);
  // And a real close-up, in the runs that take them.
  assert.match(verifier, /const CLOSEUP = \{ x: 0, y: 0, width: 20, height: 10, scale: 6\.5 \};/);
  assert.match(verifier, /size\[0\] !== 130 \|\| size\[1\] !== 65/);
});

test('the verifier reads a PNG\'s width off its header', () => {
  const header = Buffer.alloc(33);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(1170, 16);
  assert.equal(pngWidth(header), 1170);
  assert.equal(pngWidth(Buffer.alloc(10)), 0);
  assert.equal(pngWidth(Buffer.from('not a png at all, just some text')), 0);
});
