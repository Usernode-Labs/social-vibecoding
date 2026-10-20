#!/usr/bin/env node
'use strict';

// Shots are saved at the screen's own density: three device pixels to a CSS
// pixel on a phone, two on a desktop (write-shots-mcp-config.js), so a card
// can zoom into a change without drawing it soft. The pinned Playwright MCP
// (worker/Dockerfile PLAYWRIGHT_MCP_VERSION) hard-codes `scale: "css"` in
// browser_take_screenshot, which saves every shot at 1x whatever the
// browser's deviceScaleFactor. Later Playwright releases take a `scale`
// argument, but they also rename the element target and stop returning the
// image of a named screenshot, which the shots agent relies on; bumping the
// pin is its own change. So the image build edits that one tool:
//
// - the file it saves is captured at `scale: "device"`;
// - the image it answers the agent with is a second capture at `scale:
//   "css"`, the size it always was, so a 3x phone screen never reaches the
//   model as a 1170 x 2532 PNG (an API's per-image byte limit, and no more
//   detail than the model resizes it to anyway).
//
// Each edit must match exactly once, so a pin bump that moves the code fails
// the image build here; verify-shots-browser-mcp.js then proves the result
// in a real browser (saved width = answered width x the browser's density).
// Run at image build time from worker/Dockerfile; exits non-zero otherwise.

const fs = require('node:fs');
const path = require('node:path');

const MCP_DIR = '/usr/local/lib/node_modules/@playwright/mcp';

const EDITS = [
  ['      scale: "css",\n      path: fileName,', '      scale: "device",\n      path: fileName,'],
  ['        data: buffer\n',
    '        data: await (locator ? locator.screenshot({ ...options, path: void 0, scale: "css" })'
    + ' : tab.page.screenshot({ ...options, path: void 0, scale: "css" }))\n'],
];

function patchSource(source) {
  let text = String(source);
  for (const [from, to] of EDITS) {
    const at = text.indexOf(from);
    if (at === -1 || text.indexOf(from, at + 1) !== -1) {
      throw new Error(`browser_take_screenshot no longer matches the density patch (${JSON.stringify(from.trim())}); `
        + 'update worker/patch-playwright-mcp-screenshot.js for this Playwright MCP version.');
    }
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return text;
}

// The screenshot tool of the playwright the MCP package itself loads.
function screenshotToolPath(mcpDir = MCP_DIR) {
  const pkg = require.resolve('playwright/package.json', { paths: [mcpDir] });
  return path.join(path.dirname(pkg), 'lib', 'mcp', 'browser', 'tools', 'screenshot.js');
}

function main(mcpDir = process.argv[2] || MCP_DIR) {
  const file = screenshotToolPath(mcpDir);
  fs.writeFileSync(file, patchSource(fs.readFileSync(file, 'utf8')));
  process.stdout.write(`browser_take_screenshot saves at device scale: ${file}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { EDITS, patchSource, screenshotToolPath };
