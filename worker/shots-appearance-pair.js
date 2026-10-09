'use strict';

// Only final photo filenames opt in. Ordinary inspection screenshots and
// recordings keep the pinned MCP's normal behavior and tool response.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const boundary = require('./shots-boundary');
const pairedName = (name) => /^pair-[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/.test(name || '');
const manifestPath = (dir, name) => path.join(dir, '.appearance-pairs', `${name}.json`);
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function readPair(dir, name, proofs = null) {
  if (!pairedName(name)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath(dir, name), 'utf8'));
    if (proofs && (!proofs.light || !proofs.dark || proofs.light.origin !== value.origin || proofs.dark.origin !== value.origin)) return null;
    const light = proofs?.light?.sha256 || hash(fs.readFileSync(path.join(dir, name)));
    const dark = proofs?.dark?.sha256 || hash(fs.readFileSync(path.join(dir, 'dark', name)));
    return value.light === light && value.dark === dark ? value : null;
  } catch { return null; }
}

async function photoPair({ page, directory, filename, capture, origins }) {
  if (!pairedName(filename)) return capture(filename, false);
  const origin = boundary.webOrigin(page.url());
  if (!origins.includes(origin)) throw new Error('Photo pairs must be taken on the supplied before/after addresses.');
  const manifest = manifestPath(directory, filename);
  fs.rmSync(manifest, { force: true });
  const startUrl = page.url();
  const original = await page.evaluate(() => {
    const shell = typeof window.Theme?.set === 'function';
    let preference = null; let storage = false;
    if (shell) try { preference = localStorage.getItem('theme'); storage = true; } catch {}
    const shellMode = shell && typeof window.Theme.get === 'function' ? window.Theme.get() : null;
    if (shellMode !== null) {
      const key = Symbol.for('homeroom.shots.originalThemeGet');
      if (window.Theme[key]) throw new Error('A photo theme override is already active.');
      window.Theme[key] = window.Theme.get;
    }
    return { preference, storage, shell, shellMode,
      darkClass: document.documentElement.classList.contains('dark'),
      metaColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      osMode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' };
  });
  const apply = async (colorScheme) => {
    if (page.url() !== startUrl) throw new Error('Page left its screenshot state while capturing appearances.');
    await page.emulateMedia({ colorScheme });
    if (page.url() !== startUrl) throw new Error('Page left its screenshot state while capturing appearances.');
    await page.evaluate((mode) => {
      if (typeof window.Theme?.set === 'function') {
        if (window.Theme[Symbol.for('homeroom.shots.originalThemeGet')]) window.Theme.get = () => mode;
        window.Theme.set(mode);
        // The historical shell closes over ?shot=light/dark when loaded.
        // Keep that deep link and its UI state intact while overriding its
        // visual appearance and public reader for this photo only.
        if (typeof window.Theme?.apply === 'function' && typeof window.Theme?.get === 'function') {
          document.documentElement.classList.toggle('dark', mode === 'dark');
          const meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute('content', mode === 'dark' ? '#0b0d1b' : '#f4f2e4');
        }
      }
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, colorScheme);
    if (page.url() !== startUrl) throw new Error('Page left its screenshot state while capturing appearances.');
  };
  let stamps;
  try {
    // The ordinary workflow is already light. Capture it directly rather
    // than repainting or notifying theme listeners a second time.
    const alreadyLight = original.osMode === 'light' && !original.darkClass
      && (!original.shell || original.shellMode === 'light' || original.shellMode === 'system');
    if (!alreadyLight) await apply('light');
    if (page.url() !== startUrl) throw new Error('Page left its screenshot state while capturing appearances.');
    await capture(filename, false);
    await apply('dark');
    await capture(`dark/${filename}`, true);
    if (page.url() !== startUrl) throw new Error('Page left its screenshot origin while capturing appearances.');
    stamps = {
      light: boundary.stampScreenshot(directory, path.join(directory, filename), page.url()),
      dark: boundary.stampScreenshot(path.join(directory, 'dark'), path.join(directory, 'dark', filename), page.url()),
    };
  } finally {
    // Return OS emulation to its original resolved preference, then
    // restore the app preference, even when the second screenshot fails.
    await page.emulateMedia({ colorScheme: original.osMode });
    if (boundary.webOrigin(page.url()) === origin) await page.evaluate((saved) => {
      if (saved.shell) {
        const key = Symbol.for('homeroom.shots.originalThemeGet');
        if (window.Theme[key]) { window.Theme.get = window.Theme[key]; delete window.Theme[key]; }
        window.Theme.set(saved.shellMode);
      }
      if (saved.storage) {
        if (saved.preference === null) localStorage.removeItem('theme');
        else localStorage.setItem('theme', saved.preference);
      }
      if (saved.shell && typeof window.Theme.apply === 'function') window.Theme.apply();
      document.documentElement.classList.toggle('dark', saved.darkClass);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        if (saved.metaColor === null) meta.removeAttribute('content');
        else meta.setAttribute('content', saved.metaColor);
      }
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, original);
  }
  fs.mkdirSync(path.dirname(manifest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifest, JSON.stringify({ origin,
    light: stamps.light.sha256, dark: stamps.dark.sha256,
  }), { mode: 0o600 });
}

function install(mcpPackage = '/usr/local/lib/node_modules/@playwright/mcp/package.json') {
  const { createRequire } = require('node:module');
  const localRequire = createRequire(mcpPackage);
  if (localRequire(mcpPackage).version !== '0.0.41') throw new Error('Photo pairing must be reviewed when the pinned browser MCP changes.');
  const root = path.dirname(localRequire.resolve('playwright/package.json'));
  const screenshot = require(path.join(root, 'lib/mcp/browser/tools/screenshot.js')).default[0];
  const upstream = screenshot.handle;
  screenshot.handle = async (context, params, response) => {
    if (!pairedName(params.filename) || (params.type && params.type !== 'png')) return upstream(context, params, response);
    const tab = await context.ensureTab();
    if (tab.modalStates().length) return upstream(context, params, response);
    const directory = path.dirname(await context.outputFile(params.filename, { origin: 'llm', reason: 'Saving screenshot' }));
    await photoPair({ page: tab.page, directory, filename: params.filename,
      origins: JSON.parse(process.env.SHOTS_ALLOWED_ORIGINS || '[]'),
      capture: (filename, dark) => upstream(context, { ...params, filename }, dark ? {
        addCode() {}, addResult() {}, addImage() {}, addError(error) { throw new Error(error); },
      } : response),
    });
    response.addResult('Light and dark photos saved together. save_shot with this filename publishes both automatically.');
  };
  // Serialize all tools around a pair, not just screenshots: another tool
  // must not navigate, click or capture while the temporary theme is active.
  const Backend = require(path.join(root, 'lib/mcp/browser/browserServerBackend.js')).BrowserServerBackend;
  const call = Backend.prototype.callTool;
  const queues = new WeakMap();
  Backend.prototype.callTool = function (...args) {
    const next = (queues.get(this) || Promise.resolve()).then(() => call.apply(this, args));
    queues.set(this, next.catch(() => {}));
    return next;
  };
}

if (process.env.SHOTS_PAIR_PHOTOS === '1') install(process.env.SHOTS_PLAYWRIGHT_MCP_PACKAGE);
module.exports = { pairedName, readPair, photoPair, install };
