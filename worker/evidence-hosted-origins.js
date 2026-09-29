'use strict';

// One policy for the planner browser and deterministic replay. An app tile is
// not proof of a runtime: admit only public running apps with a deployed
// revision, or a genuine local container in local development. The paired
// catalog also gives the planner candidate slugs without trusting page text
// or implying that a candidate's runtime will load cleanly.
const fs = require('node:fs');
const { isHostedAppFixture } = require('./evidence-hosted-app-contract');

const MAX_CATALOG_APPS = 1000;
const MAX_HOSTED_ORIGINS = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function trustedHostedAppOrigins(apps, platformOrigin, evidenceRunId = null) {
  const origins = new Map();
  for (const app of Array.isArray(apps) ? apps.slice(0, MAX_CATALOG_APPS) : []) {
    if (app?.status !== 'running' || app?.view_visibility !== 'public'
        || app?.self_hosted === true || !APP_SLUG_RE.test(String(app?.slug || ''))) continue;
    let url;
    try { url = new URL(app.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || url.origin === platformOrigin) continue;
    const versionedRuntime = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(String(app.repo_url || ''))
      && /^[0-9a-f]{40}$/.test(String(app.main_sha || ''));
    const localRuntime = url.protocol === 'http:' && url.hostname === 'localhost'
      && String(app.container_id || '') === `usernode-app-${app.slug}`;
    // The third lane is a real, short-lived app deployment owned by this
    // exact evidence run. Its run-bound marker and reserved id are installed
    // only in the two disposable databases; unlike a user app, it has no
    // GitHub revision because the immutable capture image supplies it.
    const evidenceFixture = isHostedAppFixture(app, evidenceRunId);
    if (!versionedRuntime && !localRuntime && !evidenceFixture) continue;
    origins.set(url.origin, app.slug);
  }
  return origins;
}

async function loadTrustedHostedAppOrigins(context, platformOrigin, report = null,
  evidenceRunId = null) {
  let response;
  let outcome = 'request_error';
  let status = null;
  let catalog = new Map();
  let catalogCount = null;
  let evidenceFixtureAvailable = false;
  try {
    response = await context.request.get(`${platformOrigin}/api/apps`, {
      failOnStatusCode: false, maxRedirects: 0, timeout: 10_000,
    });
    status = response.status();
    if (status !== 200) outcome = 'http_error';
    else {
      const body = await response.json();
      if (Array.isArray(body?.apps)) {
        catalogCount = Math.min(body.apps.length, MAX_CATALOG_APPS);
        catalog = trustedHostedAppOrigins(body.apps, platformOrigin, evidenceRunId);
        evidenceFixtureAvailable = body.apps
          .slice(0, MAX_CATALOG_APPS)
          .some((app) => {
            if (!isHostedAppFixture(app, evidenceRunId)) return false;
            try { return catalog.get(new URL(app.url).origin) === app.slug; }
            catch { return false; }
          });
        outcome = 'ok';
      } else outcome = 'invalid_catalog';
    }
  } catch { outcome = status === 200 ? 'invalid_catalog' : 'request_error'; }
  finally {
    await response?.dispose?.().catch(() => {});
    try {
      report?.({
        outcome, httpStatus: status, catalogCount, count: catalog.size,
        evidenceFixtureAvailable,
      });
    } catch {}
  }
  return catalog;
}

function parseHostedAppCatalog(file, baseOrigin, headOrigin) {
  if (!file) throw new Error('Evidence hosted-app catalog path is missing.');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error('Evidence hosted-app catalog file is invalid.');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'apps,baseOrigin,headOrigin,version'
      || value.version !== 2 || value.baseOrigin !== baseOrigin || value.headOrigin !== headOrigin
      || !Array.isArray(value.apps) || value.apps.length > MAX_HOSTED_ORIGINS) {
    throw new Error('Evidence hosted-app catalog does not match this replay pair.');
  }
  const origins = new Set();
  const slugs = new Set();
  for (const app of value.apps) {
    if (!app || Object.keys(app).sort().join(',') !== 'origin,slug'
        || !APP_SLUG_RE.test(String(app.slug || '')) || slugs.has(app.slug)) {
      throw new Error('Evidence hosted-app catalog entry is invalid.');
    }
    const origin = app.origin;
    let url;
    try { url = new URL(origin); } catch { throw new Error('Evidence hosted-app origin is invalid.'); }
    if (typeof origin !== 'string' || !['http:', 'https:'].includes(url.protocol)
        || url.origin !== origin || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash || origin === baseOrigin || origin === headOrigin
        || origins.has(origin)) {
      throw new Error('Evidence hosted-app origin is invalid.');
    }
    origins.add(origin);
    slugs.add(app.slug);
  }
  return value.apps;
}

function parseHostedOriginsFile(file, baseOrigin, headOrigin) {
  return parseHostedAppCatalog(file, baseOrigin, headOrigin).map((app) => app.origin);
}

function hostedAppSlugs(file, baseOrigin, headOrigin) {
  return parseHostedAppCatalog(file, baseOrigin, headOrigin).map((app) => app.slug);
}

function browserAllowedOrigins(baseOrigin, headOrigin, file) {
  if (!baseOrigin || !headOrigin || baseOrigin === headOrigin) {
    throw new Error('Evidence browser requires distinct paired origins.');
  }
  return [baseOrigin, headOrigin, ...parseHostedOriginsFile(file, baseOrigin, headOrigin)];
}

if (require.main === module) {
  try {
    process.stdout.write(browserAllowedOrigins(process.argv[2], process.argv[3], process.argv[4]).join(';'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  trustedHostedAppOrigins,
  loadTrustedHostedAppOrigins,
  parseHostedAppCatalog,
  parseHostedOriginsFile,
  hostedAppSlugs,
  browserAllowedOrigins,
};
