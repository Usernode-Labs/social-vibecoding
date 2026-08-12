/* Temporary debug harness for the card-menu check — logs API calls, console
 * errors, and what the dev board actually rendered. Not part of the repo;
 * deleted after the investigation. */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3400';
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const resp = await context.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'adminpass123' } });
  if (!resp.ok()) { console.error('login failed', resp.status()); process.exit(1); }
  const page = await context.newPage();
  const apiLog = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/') && (u.includes('proposal') || u.includes('dev') || u.includes('vote'))) {
      apiLog.push(`${r.status()} ${u.replace(BASE, '')}`);
    }
  });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.goto(BASE + '/?demo=1&shot=card-menu&card=proposal:9000043#app/usernode-2d5619/dev', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  console.log('API calls:', JSON.stringify(apiLog, null, 1));
  console.log('console errors:', JSON.stringify(errs, null, 1));
  const info = await page.evaluate(() => {
    const body = document.querySelector('#dev-body');
    const cards = [...document.querySelectorAll('[data-card-menu]')].map(e => e.getAttribute('data-card-menu'));
    return {
      devBodyExists: !!body,
      devBodyTextStart: body ? body.textContent.trim().slice(0, 300) : null,
      cardMenuAttrs: cards.slice(0, 20),
      cardCount: cards.length,
      hash: location.hash,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
