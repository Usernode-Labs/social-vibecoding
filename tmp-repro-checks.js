/* Repro harness for the two flaky shot checks. Logs in as admin, then for N
 * iterations loads each check URL and polls its selector every 100ms for
 * MAX_MS, reporting when (or whether) it first matched. Not part of the
 * repo — deleted after the investigation. */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3400';
const N = parseInt(process.env.N || '6', 10);
const MAX_MS = parseInt(process.env.MAX_MS || '10000', 10);
const CPU_THROTTLE = parseFloat(process.env.CPU_THROTTLE || '1');

const CHECKS = [
  {
    name: 'feedback-queued dot',
    url: '/?shot=feedback-queued',
    selector: 'body.is-offline #feedback-queue-dot:not(.hidden)',
  },
  {
    name: 'card-menu 9000043 explore',
    url: '/?demo=1&shot=card-menu&card=proposal:9000043#app/usernode-2d5619/dev',
    selector: '[data-proposal-id="9000043"][title^="Open a dev chat with a message about this PR"], .dev-card-menu [data-menu-idx][title^="Open a dev chat with a message about this PR"]',
    extra: [
      ['card row', '[data-card-menu="proposal:9000043"]'],
      ['menu open', '.dev-card-menu'],
      ['dev body', '#dev-body'],
    ],
  },
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  // Session: login as admin via the API, cookie lands in the context.
  const resp = await context.request.post(`${BASE}/api/auth/login`, {
    data: { username: 'admin', password: 'adminpass123' },
  });
  if (!resp.ok()) {
    console.error('login failed', resp.status(), await resp.text());
    process.exit(1);
  }

  for (const check of CHECKS) {
    console.log(`\n=== ${check.name} — ${check.url}`);
    for (let i = 0; i < N; i++) {
      const page = await context.newPage();
      if (CPU_THROTTLE > 1) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
      }
      const consoleErrs = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 120)); });
      const t0 = Date.now();
      await page.goto(BASE + check.url, { waitUntil: 'domcontentloaded' });
      let matchedAt = null;
      const extraAt = new Map();
      while (Date.now() - t0 < MAX_MS) {
        if (!matchedAt && await page.$(check.selector)) { matchedAt = Date.now() - t0; }
        for (const [label, sel] of check.extra || []) {
          if (!extraAt.has(label) && await page.$(sel)) extraAt.set(label, Date.now() - t0);
        }
        if (matchedAt && (check.extra || []).every(([l]) => extraAt.has(l))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const extras = (check.extra || []).map(([l]) => `${l}=${extraAt.get(l) ?? 'NEVER'}`).join(' ');
      console.log(`  run ${i + 1}: matched=${matchedAt ?? 'NEVER'}ms ${extras}${consoleErrs.length ? ` errs=${JSON.stringify(consoleErrs.slice(0, 2))}` : ''}`);
      await page.close();
    }
  }
  await browser.close();
})();
