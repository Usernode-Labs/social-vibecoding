// #4387: the FIRST LOOK, rendered in a first version's build worker. The
// platform (services/first-version-screens.js renderFirstLook) sends this
// script with one line in front of it, `const FIRST_LOOK = {…};`: a whole
// HTML document built from the main screen its spec drew (the model's mock,
// wrapped with the native kit's stylesheet), and the phone's size. It is
// drawn in the worker's own Chromium and comes back as a PNG, base64, on one
// marker line. The platform stores the image; nobody is ever sent the HTML.
//
// The mock is model-written, so it is drawn with nothing on: scripts off,
// every request but the document itself refused (no network, no file reads),
// and the document's own CSP says the same. A mock that will not draw is
// a missing first look, never a failed build: this always exits 0.

/* global FIRST_LOOK */

const MARKER = '__USERNODE_FIRST_LOOK__';
const RENDER_TIMEOUT_MS = 30000;

function emit(out) {
  process.stdout.write(`${MARKER} ${JSON.stringify(out)}\n`);
}

function loadPlaywright() {
  const candidates = [process.env.BENCH_PLAYWRIGHT, 'playwright', '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

async function main() {
  const input = typeof FIRST_LOOK === 'object' && FIRST_LOOK ? FIRST_LOOK : {};
  const html = typeof input.html === 'string' ? input.html : '';
  const width = Number(input.width) || 390;
  const height = Number(input.height) || 844;
  if (!html) return emit({ ok: false, error: 'no screen to draw' });
  const playwright = loadPlaywright();
  if (!playwright) return emit({ ok: false, error: 'playwright is not available in this worker' });
  let browser = null;
  try {
    browser = await playwright.chromium.launch({
      channel: 'chromium', headless: true,
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, javaScriptEnabled: false,
      colorScheme: 'light', serviceWorkers: 'block', offline: true,
    });
    // Only inline data may load; everything else the mock names is refused.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith('data:') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, timeout: RENDER_TIMEOUT_MS });
    emit({ ok: true, png: png.toString('base64') });
  } catch (err) {
    emit({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return undefined;
}

main().catch((err) => emit({ ok: false, error: String((err && err.message) || err).slice(0, 300) }))
  .finally(() => process.exit(0));
