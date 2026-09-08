#!/usr/bin/env node
// Real built-shell captures with local, deterministic API fixtures. No live
// account, network writes, hand-written UI, or screenshot CSS overrides.
// Run npm run ensure:shell first. Playwright is an optional developer tool,
// like scripts/audit-react-ownership.mjs, not a repository dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve(process.env.CAPTURE_OUT || 'artifacts/mobile-density');
const phase = process.env.CAPTURE_PHASE || 'before';
const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use(express.static('public'));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const apps = [
  ['game-corner', 'Game Corner', '🕹️', 11],
  ['my-page', 'MyPage', '✨', 2],
  ['community-hub', 'Community Hub', '📊', 2],
  ['recipe-bot', 'RecipeBot', '🍲', 3],
  ['todo-list', 'Todo List', '📝', 2],
].map(([slug, name, icon_emoji, member_count], i) => ({
  id: i + 1, slug, name, icon_emoji, active_users: member_count, status: 'running',
  created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-08T12:00:00Z',
  creator_id: 2, visibility: 'public', is_favorite: false, is_member: false,
  description: 'A community-built app.', repo_url: 'https://github.com/example/example',
  open_prs: 1, open_issues: i === 0 ? 37 : 1,
}));
const session = {
  id: 161700, app_id: 2, user_id: 1, status: 'promoted', check_state: 'passing', yes_count: 0, votes_required: 1, session_title: 'add help assistant',
  branch_name: 'session/add-help-assistant', pr_number: 21, pr_title: 'add help assistant',
  agent_backend: 'codex_openrouter', agent_model: 'openai/gpt-5.3-codex',
  staging_url: `${origin}/preview-fixture`, created_at: '2026-09-08T12:00:00Z',
};
const messages = [{ id: 1, role: 'assistant', content: 'The change is ready for review.\n\nOpened PR #21: View pull request\n\nStaging redeployed: Open preview', created_at: '2026-09-08T12:00:00Z' }];
const requests = new Set();
const errors = [];
try {
  await fs.mkdir(output, { recursive: true });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 780 : 900 },
      deviceScaleFactor: 2, isMobile: width === 360, hasTouch: width === 360, colorScheme: 'light',
      serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/challenges-api/')) return route.continue();
      requests.add(`${route.request().method()} ${url.pathname}`);
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 1, username: 'reviewer', display_name: 'Reviewer', hasPlatformAccess: true } };
      else if (url.pathname === '/api/apps') body = { apps };
      else if (url.pathname.endsWith('/favorite') && route.request().method() === 'POST') {
        const target = apps.find(a => a.slug === url.pathname.split('/')[3]);
        assert.ok(target, 'only fixture apps may be modified');
        target.is_favorited = route.request().postDataJSON().favorited;
        body = { favorited: target.is_favorited };
      }
      else if (url.pathname === '/api/apps/my-page') body = { app: { ...apps[1], is_member: true, members: [], proposals: [], sessions: [session] } };
      else if (url.pathname === '/api/sessions/161700') body = { session, messages, drafts: [] };
      else if (url.pathname === '/api/sessions/161700/status') body = { session, messages, status: session.status, is_busy: false };
      else if (url.pathname === '/api/models') body = { models: [{ id: 'sonnet', label: 'Sonnet' }], default: 'sonnet' };
      else if (url.pathname.endsWith('/sessions')) body = { sessions: [session] };
      else if (url.pathname === '/api/me/active-sessions') body = { sessions: [] };
      else if (url.pathname === '/api/me/coding-agent') body = { agent_backend: 'codex_openrouter' };
      else if (url.pathname === '/api/budget') body = { daily_limit: 10, daily_used: 1, remaining: 9 };
      else if (url.pathname === '/api/home-layout') body = { layout: null };
      else if (url.pathname.includes('notifications')) body = { notifications: [], unread: 0 };
      else if (url.pathname.includes('terms/current')) body = { success: true, data: { accepted: true, requires_acceptance: false } };
      else body = { sessions: [], items: [], messages: [], apps: [], notifications: [], models: [], proposals: [], issues: [], members: [], success: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    await context.routeWebSocket('**/ws/**', () => {});
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?shot=mobile-density#apps`);
    await page.locator('#browse-list .browse-row').first().waitFor();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(output, `discover-${phase}-${width}.png`) });
    await page.goto(`${origin}/?shot=dev-chat-first-use#app/my-page/dev/sessions/161700`);
    await page.locator('#dc-session-header').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(output, `dev-chat-${phase}-${width}.png`) });
    if (phase === 'after' && width === 360) {
      const trigger = page.locator('.dc-session-details-trigger');
      assert.equal(await page.locator('#dc-venue-select').isVisible(), false);
      assert.equal(await page.locator('#dc-pr-header-link').isVisible(), false);
      assert.ok(await page.locator('#dc-mode-switch').isVisible(), 'Preview/Building remains available');
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Session details' });
      await dialog.waitFor();
      await dialog.getByText('add help assistant', { exact: true }).waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(output, 'dev-chat-details-after-360.png') });
      await dialog.getByRole('button', { name: 'Done' }).focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-venue-details-select', 'focus stays inside Details');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await trigger.evaluate(el => el === document.activeElement), 'focus returns to Details');
      await trigger.click();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await trigger.click();
      await dialog.getByRole('button', { name: 'PR #21', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('.dc-pr-card-highlight').waitFor();
      await trigger.click();
      await page.locator('#dc-venue-details-select').click();
      await page.getByText('Where do you want to work on this?', { exact: true }).waitFor();
      assert.equal(await page.locator('.un-modal').count(), 0, 'outgoing Details is gone before chooser opens');
      await page.keyboard.press('Escape');
      await page.getByText('Where do you want to work on this?', { exact: true }).waitFor({ state: 'hidden' });
      await page.evaluate(() => { DevChat.isStreaming = true; DevChat._composerBusy = true; DevChat._repaintSessionHeader(); });
      await trigger.click();
      assert.ok(await page.locator('#dc-venue-details-select').isDisabled(), 'busy session cannot change provider');
      await page.locator('#dc-venue-details-select .dc-venue-busy').waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.evaluate(() => { DevChat.isStreaming = false; DevChat._composerBusy = false; DevChat._repaintSessionHeader(); });
      await trigger.click();
      await dialog.waitFor();
      await page.setViewportSize({ width: 800, height: 780 });
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await page.locator('#dc-venue-select').isVisible(), 'desktop regains inline controls');
      await page.setViewportSize({ width: 320, height: 780 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(() => {
        DevChat.currentSession.session_title = 'A much longer session title that still needs to remain readable';
        DevChat._repaintSessionHeader();
      });
      assert.ok((await page.locator('.dc-session-title').boundingBox()).height <= 41, 'long title is capped at two header lines');
      await trigger.click();
      await dialog.waitFor();
      await page.waitForTimeout(400);
      assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth), '320px Details fits');
      await page.screenshot({ path: path.join(output, 'dev-chat-details-dark-320.png') });
      await page.evaluate(() => { location.hash = '#apps'; });
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#browse-list .browse-row').first().waitFor();
      await page.waitForTimeout(900);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px Discover has no horizontal overflow');
      await page.screenshot({ path: path.join(output, 'discover-dark-320.png') });
    }
    if (phase === 'after' && width === 1280) {
      assert.ok(await page.locator('#dc-venue-select').isVisible());
      assert.ok(await page.locator('#dc-pr-header-link').isVisible());
      assert.equal(await page.locator('.dc-session-details-trigger').isVisible(), false);
    }
    // Run mutation checks AFTER both comparison captures, so the before and
    // after screenshots use the exact same navigation and untouched data.
    if (phase === 'after') {
      await page.goto(`${origin}/?shot=mobile-density#apps`);
      const row = page.locator('.browse-row[data-slug="game-corner"]');
      await row.waitFor();
      const name = row.locator('.browse-row-title');
      const add = row.locator('.browse-add-btn');
      const titleBox = await name.boundingBox(), addBox = await add.boundingBox();
      if (width < 640) assert.ok(titleBox.y + titleBox.height <= addBox.y + 1, 'title is above Add');
      await add.click();
      await page.waitForFunction(() => document.querySelector('.browse-row[data-slug="game-corner"] .browse-add-btn')?.dataset.added === 'true');
      assert.equal(new URL(page.url()).hash, '#apps', 'Add must not navigate into the row');
      await add.click();
      await page.waitForFunction(() => document.querySelector('.browse-row[data-slug="game-corner"] .browse-add-btn')?.dataset.added === 'false');
    }
    console.log(JSON.stringify({ phase, width, errors }));
    await context.close();
  }
  const fingerprints = {};
  for (const file of ['public/css/app.css', 'public/css/tailwind.css', 'public/shell/assets/shell.js']) {
    fingerprints[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  await fs.writeFile(path.join(output, `${phase}-metadata.json`), JSON.stringify({
    phase, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(import.meta.url)) }).trim(),
    browser: browser.version(), fixture: 'local synthetic API data; real built shell', fingerprints,
    viewports: [{ width: 360, height: 780, deviceScaleFactor: 2 }, { width: 1280, height: 900, deviceScaleFactor: 2 }],
    requests: [...requests], errors,
  }, null, 2));
  assert.deepEqual(errors, [], 'The built app must not throw while capturing');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
