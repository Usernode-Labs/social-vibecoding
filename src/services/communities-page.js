'use strict';

// The signed-out page about private communities, `/communities`
// (frontend/src/features/guest/guest-communities.tsx), as a search engine
// reads it: the shell document with the page's own title, description and
// one address in its head, put there the way a public project's page gets
// its own (services/project-preview.js withPreview). Before this the address
// answered with the landing's head and `X-Robots-Tag: noindex`, so it could
// not be found (request #7166, points 1 and 7).
//
//   COMMUNITIES_PATH          the page's address.
//   communitiesTags(origin)   its head tags; `origin` is the platform's
//                             CONFIGURED address or null (see below).
//   withCommunitiesHead(html, origin)  the shell document with them.
//   documentDay(mtimeMs)      the day a built document was made, for the
//                             sitemap's lastmod.

const { withPreview } = require('./project-preview');

const COMMUNITIES_PATH = '/communities';

// The page's own words: its headline and the two sentences under it
// (frontend/locales/en/auth.json `guest.groups.title` and `guest.groups.sub`,
// the second without its line tags). tests/project-preview.test.js keeps
// them equal to the catalog, so the head says what the page says.
const TITLE = 'An app for your group, made by your group';
const DESCRIPTION = 'Say what your group needs and Homeroom builds it. Only the people you invite can see it.';

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A plain origin (`https://host` or `https://host:port`), or null. */
function plainOrigin(origin) {
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(String(origin || '')) ? String(origin) : null;
}

/** The page's one address, or null without a configured origin. */
function communitiesUrl(origin) {
  const base = plainOrigin(origin);
  return base ? `${base}${COMMUNITIES_PATH}` : null;
}

/**
 * The head tags of the page about private communities. `origin` is the
 * platform's CONFIGURED address (app-identity-env.js platformOrigin) on
 * production, and null on a staging copy or with none configured: the
 * caller must never pass one read from the request's Host or
 * X-Forwarded-Host, or a forged Host could name another site as this
 * page's canonical. Without it the page still has its title and
 * description, and names no address.
 */
function communitiesTags(origin) {
  const url = communitiesUrl(origin);
  const tags = [
    `<meta name="description" content="${escapeAttr(DESCRIPTION)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${escapeAttr(TITLE)}">`,
    `<meta property="og:description" content="${escapeAttr(DESCRIPTION)}">`,
  ];
  if (url) {
    tags.push(
      `<meta property="og:url" content="${escapeAttr(url)}">`,
      `<link rel="canonical" href="${escapeAttr(url)}">`,
    );
  }
  return tags.join('\n');
}

/** The shell document as the page about private communities. */
function withCommunitiesHead(html, origin) {
  return withPreview(html, communitiesTags(origin), TITLE);
}

/**
 * The day (YYYY-MM-DD) a built document was made, from its file's
 * modification time, or null when that is not a real date (a build that
 * zeroes file times). The page's words ship in the build, so the day the
 * build was made is the day the page last changed.
 */
function documentDay(mtimeMs) {
  const t = Number(mtimeMs);
  if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

module.exports = {
  COMMUNITIES_PATH,
  TITLE,
  DESCRIPTION,
  communitiesUrl,
  communitiesTags,
  withCommunitiesHead,
  documentDay,
};
