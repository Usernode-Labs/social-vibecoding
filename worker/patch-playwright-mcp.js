#!/usr/bin/env node
'use strict';

// The pinned Playwright MCP (worker/Dockerfile PLAYWRIGHT_MCP_VERSION) keeps
// its browser tools in one bundled file, playwright-core's lib/coreBundle.js.
// The image build edits that file in a few places, so the shots and the
// coding agents' in-loop browser keep working the way they are written for:
//
// - Shots can be saved at the screen's own density: three device pixels to a
//   CSS pixel on a phone, two on a desktop (write-shots-mcp-config.js), so a
//   card can zoom into a change without drawing it soft. That is experimental
//   and off unless the platform switches it on (services/shots-density.js),
//   which reaches this tool as SHOTS_SCREENSHOT_SCALE=device. Then the file
//   browser_take_screenshot saves is captured at `scale: "device"`, and the
//   image it answers the agent with is a second capture at `scale: "css"`, so
//   a 3x phone screen never reaches the model as a 1170 x 2532 PNG (an API's
//   per-image byte limit, and no more detail than the model resizes it to
//   anyway). Without it the tool takes the scale it is asked for, CSS unless
//   the agent says otherwise.
//
// - A screenshot answers the agent with its image whenever it is not a full
//   page, named or not. The shots agent names every screenshot it saves and
//   looks at it before saving; upstream answers a named screenshot with its
//   file alone.
//
// - With SHOTS_SCREENSHOT_SETTLE=1 (every shots browser; never the coding
//   agent's in-loop one) each ordinary screenshot first waits, at most 3 s,
//   until the page's own requests have finished and its markup has stopped
//   changing (#6379), then captures as it always did.
//
// - With a `closeup` argument (the shots tools' own, through the browser
//   observer: shots-browser-observer.js startControl), it saves one region
//   of the visible screen at `closeup.scale` device pixels per CSS pixel,
//   through Chrome's own Page.captureScreenshot clip.scale. Measured
//   2026-10-21: the result is pixel for pixel what a page drawn at that
//   density gives, in about 55 ms, and the page never sees its density
//   change. The region is in the screen still's coordinates (the visual
//   viewport, in screen points); Chrome's clip is the document's, so the
//   scroll offset is added and, on a phone page drawn zoomed out (no
//   viewport meta: laid out wider than the screen), the zoom divided out.
//   Chrome cuts a clip's width and height down to whole CSS pixels before
//   it scales them (a 49.87 x 24.94 clip at 2.6 saved 128 x 63, not
//   130 x 65), so the zoomed region is rounded to whole page pixels: the
//   saved size is then within half a page pixel of the one asked for.
//   Such a call answers with no image: nobody but the shots tools reads it.
//
// - A file a tool saves under the name it is given (a named screenshot, a
//   close-up, a saved snapshot) goes into the server's --output-dir, as an
//   unnamed one does: upstream saves it against the client's workspace
//   root, which for a build turn's in-loop browser is the app checkout,
//   whose commit step would ship it (worker-run.sh --output-dir), and for a
//   shots browser is not the directory the shots bridge reads.
//
// - An action's answer (navigate, click, type, ...) carries the page's
//   snapshot again, as every agent prompt here expects: upstream writes it
//   to a file and answers with a link, which the shots agent cannot read
//   (it has no file tools) and which would cost every step an extra
//   browser_snapshot call. An explicit browser_snapshot with a filename
//   still saves to that file.
//
// Each edit must match exactly once, so a pin bump that moves the code fails
// the image build here; verify-shots-browser-mcp.js then proves the result
// in a real browser (the named screenshot's place and image, its density,
// the close-up, the snapshot in an action's answer).
// Run at image build time from worker/Dockerfile; exits non-zero otherwise.

const fs = require('node:fs');
const path = require('node:path');

const MCP_DIR = '/usr/local/lib/node_modules/@playwright/mcp';

const CLOSEUP_SCHEMA = '      closeup: z23.object({'
  + ' x: z23.number().min(0), y: z23.number().min(0),'
  + ' width: z23.number().positive(), height: z23.number().positive(),'
  + ' scale: z23.number().min(1).max(16) }).optional()'
  + '.describe("For the before/after shots tools only; leave it out.")\n';

const CLOSEUP_HANDLER = '        if (params2.closeup) {\n'
  + '          const c = params2.closeup;\n'
  + '          const resolvedFile = await response2.resolveClientOutputFile({ prefix: "page", ext: "png", suggestedFilename: params2.filename }, "Close-up screenshot");\n'
  + '          const at = await tab2.page.evaluate(() => (window.visualViewport'
  + ' ? { x: window.visualViewport.pageLeft, y: window.visualViewport.pageTop, k: window.visualViewport.scale || 1 }'
  + ' : { x: window.scrollX, y: window.scrollY, k: 1 }));\n'
  + '          const cdp = await tab2.page.context().newCDPSession(tab2.page);\n'
  + '          try {\n'
  + '            const shot = await cdp.send("Page.captureScreenshot", { format: "png",'
  + ' clip: { x: Math.round(at.x + c.x / at.k), y: Math.round(at.y + c.y / at.k),'
  + ' width: Math.max(1, Math.round(c.width / at.k)), height: Math.max(1, Math.round(c.height / at.k)), scale: c.scale * at.k } });\n'
  + '            await require("fs").promises.writeFile(resolvedFile.fileName, Buffer.from(shot.data, "base64"));\n'
  + '          } finally {\n'
  + '            await cdp.detach().catch(() => {});\n'
  + '          }\n'
  + '          response2.addTextResult(resolvedFile.printableLink);\n'
  + '          return;\n'
  + '        }\n';

// #6379: the agent does not always call browser_wait_for before shooting, so
// a conversation that renders just after the page goes idle was missing from
// the shot. With SHOTS_SCREENSHOT_SETTLE=1 (every shots browser,
// write-shots-mcp-config.js; never the coding agent's in-loop one) each
// ordinary screenshot first waits until the page's own requests are done and
// its markup has stopped changing, at most 3 s, and is then taken as before.
// The close-up branch above has already returned, so close-ups do not wait
// again; they follow a screen shot that did.
const SETTLE_HANDLER = '        if (process.env.SHOTS_SCREENSHOT_SETTLE === "1") {\n'
  + '          const settleInPage = async ({ quietMs, maxMs }) => {\n'
  + '            const startedAt = Date.now();\n'
  + '            const signature = () => document.getElementsByTagName("*").length + ":"'
  + ' + (document.body ? document.body.textContent.length : 0);\n'
  + '            let previous = signature();\n'
  + '            while (Date.now() - startedAt < maxMs) {\n'
  + '              await new Promise((done) => setTimeout(done, quietMs));\n'
  + '              const now = signature();\n'
  + '              if (now === previous && (window.__usernodeShotsInFlight || 0) === 0) return;\n'
  + '              previous = now;\n'
  + '            }\n'
  + '          };\n'
  + '          await tab2.page.evaluate(settleInPage, { quietMs: 250, maxMs: 3000 }).catch(() => {});\n'
  + '        }\n';

const CAPTURE = '        const data = target ? await target.locator.screenshot(options) : await tab2.page.screenshot(options);\n';

const EDITS = [
  ['Default is css.\')\n    });\n    screenshot = defineTabTool({',
    `Default is css.'),\n${CLOSEUP_SCHEMA}    });\n    screenshot = defineTabTool({`],
  ['      handle: async (tab2, params2, response2) => {\n        if (params2.fullPage && params2.target)',
    `      handle: async (tab2, params2, response2) => {\n${CLOSEUP_HANDLER}        if (params2.fullPage && params2.target)`],
  ['          scale: params2.scale,\n',
    '          scale: process.env.SHOTS_SCREENSHOT_SCALE === "device" ? "device" : params2.scale,\n'],
  [CAPTURE, `${SETTLE_HANDLER}${CAPTURE}`],
  ['        if (!params2.filename)\n          await response2.registerImageResult(data, fileType);\n',
    '        if (!params2.fullPage)\n          await response2.registerImageResult(options.scale === "css" ? data'
    + ' : await (target ? target.locator.screenshot({ ...options, scale: "css" })'
    + ' : tab2.page.screenshot({ ...options, scale: "css" })), fileType);\n'],
  ['const snapshotToFile = this._includeSnapshot !== "explicit" || !!this._includeSnapshotFileName;',
    'const snapshotToFile = !!this._includeSnapshotFileName;'],
  ['        if (template.suggestedFilename)\n          fileName = await this.resolveClientFilename(template.suggestedFilename);\n'
    + '        else\n          fileName = await this._context.outputFile(template, { origin: "llm" });\n',
  '        fileName = await this._context.outputFile(template, { origin: "llm" });\n'],
];

function patchSource(source) {
  let text = String(source);
  for (const [from, to] of EDITS) {
    const at = text.indexOf(from);
    if (at === -1 || text.indexOf(from, at + 1) !== -1) {
      throw new Error(`Playwright MCP no longer matches the worker's patch (${JSON.stringify(from.trim().slice(0, 120))}); `
        + 'update worker/patch-playwright-mcp.js for this Playwright MCP version.');
    }
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return text;
}

// The bundle the MCP package itself loads: its playwright-core's tools.
function bundlePath(mcpDir = MCP_DIR) {
  const pkg = require.resolve('playwright-core/package.json', { paths: [mcpDir] });
  return path.join(path.dirname(pkg), 'lib', 'coreBundle.js');
}

function main(mcpDir = process.argv[2] || MCP_DIR) {
  const file = bundlePath(mcpDir);
  fs.writeFileSync(file, patchSource(fs.readFileSync(file, 'utf8')));
  process.stdout.write('Playwright MCP patched: screenshots answer their image and save at device scale when'
    + ' SHOTS_SCREENSHOT_SCALE=device, wait for a settled page when SHOTS_SCREENSHOT_SETTLE=1, take close-ups;'
    + ` actions answer with the page snapshot: ${file}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { EDITS, CLOSEUP_HANDLER, SETTLE_HANDLER, patchSource, bundlePath };
