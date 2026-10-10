#!/usr/bin/env node
'use strict';
// #4087: the shots browser must draw the shell's text in Inter at its real
// weights. fc-match proves only what fontconfig answers; Chromium resolves
// system-ui and generic families its own way, so this asks the browser
// itself which platform font it used (CDP CSS.getPlatformFontsForNode).
// Runs at image build time from worker/Dockerfile; exits non-zero otherwise.

const MCP_DIR = '/usr/local/lib/node_modules/@playwright/mcp';

// Tailwind 3.4's default font-sans: what the shell's preflight gives <html>.
const SHELL_STACK = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", '
  + '"Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
// The weights the shell draws with, and the Inter face each must land on.
const EXPECTED = { 400: 'Inter-Regular', 650: 'Inter-Bold', 700: 'Inter-Bold', 800: 'Inter-ExtraBold' };

async function platformFonts({ stack = SHELL_STACK, chromium } = {}) {
  const browser = await chromium.launch({
    channel: 'chromium', headless: true, chromiumSandbox: false,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    const rows = Object.keys(EXPECTED)
      .map((w) => `<p id="w${w}" style="font-weight:${w}">Homeroom ships 800 headings</p>`).join('');
    await page.setContent(`<html style='font-family:${stack}'><body>${rows}</body></html>`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const used = {};
    for (const weight of Object.keys(EXPECTED)) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#w${weight}` });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      used[weight] = fonts.map((f) => `${f.familyName}|${f.postScriptName}`);
    }
    return used;
  } finally {
    await browser.close();
  }
}

// The shell's whole stack reaches Inter through the named aliases
// (ui-sans-serif comes first). A page that names system-ui alone reaches it
// only through fontconfig's sans-serif preference: Chromium asks for its
// system font by that generic, not by the name "system-ui".
const STACKS = [SHELL_STACK, 'system-ui'];

function wrongFaces(used) {
  return Object.entries(EXPECTED).filter(([w, face]) => {
    const fonts = used[w] || [];
    return fonts.length !== 1 || !/^Inter\b/.test(fonts[0]) || !fonts[0].endsWith(`|${face}`);
  }).map(([w, face]) => `${w} wanted ${face}, got ${(used[w] || []).join(' + ') || 'nothing'}`);
}

async function main() {
  const { chromium } = require(require.resolve('playwright', { paths: [MCP_DIR] }));
  const stacks = process.argv[2] ? [process.argv[2]] : STACKS;
  let failed = false;
  for (const stack of stacks) {
    const used = await platformFonts({ stack, chromium });
    const wrong = wrongFaces(used);
    console.log(`shots browser fonts for ${stack}: ${JSON.stringify(used)}`);
    if (wrong.length) {
      failed = true;
      console.error(`shots browser does not draw ${stack} in Inter: ${wrong.join('; ')}`);
    }
  }
  if (failed) process.exit(1);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { SHELL_STACK, STACKS, EXPECTED, platformFonts, wrongFaces };
