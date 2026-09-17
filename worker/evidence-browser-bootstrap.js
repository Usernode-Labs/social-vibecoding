#!/usr/bin/env node
'use strict';

// Exchange short-lived app identity JWTs for ordinary browser storage state
// before the model process starts. The runner unsets the raw tokens
// immediately afterward; MCP receives only the cookie/local-storage state in
// a private file and the model has no filesystem or shell tool in evidence
// mode.

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');

async function main() {
  const origins = JSON.parse(process.env.EVIDENCE_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin);
  const outputDir = String(process.env.EVIDENCE_BROWSER_STATE_DIR || '');
  const proxy = String(process.env.EVIDENCE_PROXY_SERVER || '');
  const personas = {
    member: String(process.env.EVIDENCE_MEMBER_TOKEN || ''),
    read_only_admin: String(process.env.EVIDENCE_ADMIN_TOKEN || ''),
  };
  if (origins.length !== 2 || !outputDir || !proxy || Object.values(personas).some((value) => !value)) {
    throw new Error('Evidence browser bootstrap configuration is incomplete.');
  }
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    channel: 'chromium', headless: true, proxy: { server: proxy },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    for (const [persona, token] of Object.entries(personas)) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        for (const origin of origins) {
          const url = new URL('/', origin);
          url.searchParams.set('token', token);
          const page = await context.newPage();
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const final = new URL(page.url());
          if (final.origin !== origin) throw new Error(`Evidence auth for ${persona} left its allowed origin.`);
          await page.close();
        }
        const target = path.join(outputDir, `${persona}.json`);
        await context.storageState({ path: target });
        await fs.chmod(target, 0o600);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error).slice(0, 1000)}\n`);
  process.exit(1);
});
