/* Temporary debug: watch the Explore face-button title over time and dump
 * /api/budget, to confirm the availability-rewrite race. Deleted after the
 * investigation. */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3400';
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const resp = await context.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'adminpass123' } });
  if (!resp.ok()) { console.error('login failed', resp.status()); process.exit(1); }
  const budget = await context.request.get(`${BASE}/api/budget`);
  console.log('/api/budget →', budget.status(), (await budget.text()).slice(0, 300));

  const page = await context.newPage();
  await page.goto(BASE + '/?demo=1&shot=card-menu&card=proposal:9000043#app/usernode-2d5619/dev', { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 6000) {
    const state = await page.evaluate(() => {
      const b = document.querySelector('.gc-explore-chat-btn[data-proposal-id="9000043"]');
      return b ? { title: b.title, disabled: b.disabled } : null;
    });
    const sig = JSON.stringify(state);
    if (sig !== last) {
      console.log(`t=${Date.now() - t0}ms`, sig);
      last = sig;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await browser.close();
})();
