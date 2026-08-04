'use strict';

const MAX_API_TARGET_BYTES = 2048;
const API_BASE = 'https://cli-api.invalid';
const DENIED_PREFIXES = Object.freeze([
  '/api/admin',
  '/api/app-llm',
  '/api/app-platform',
  '/api/app-storage',
  '/api/auth',
  '/api/cli',
  '/api/debug',
  '/api/iframe-token',
  '/api/internal',
  '/api/me/cli-tokens',
  '/api/node-status',
  '/api/v4',
]);
const DENIED_SEGMENTS = Object.freeze([
  'api-key',
  'llm-grant',
  'llm-grants',
  'password',
  'secret-declaration-pr',
  'secrets',
  'wallet-change-password',
  'wallet-link',
]);
const SECRET_DECLARATION_BRANCH_PREFIX = 'secret-declare/';

function hasPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function canonicalApiTarget(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || !value.startsWith('/')
      || value.startsWith('//')
      || Buffer.byteLength(value, 'utf8') > MAX_API_TARGET_BYTES
      || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value, API_BASE);
  } catch {
    return null;
  }
  if (url.origin !== API_BASE
      || url.hash
      || !url.pathname.startsWith('/api/')
      || url.pathname.includes('%')) {
    return null;
  }
  const lowerPathname = url.pathname.toLowerCase();
  const segments = lowerPathname.split('/');
  if (DENIED_PREFIXES.some((prefix) => hasPrefix(lowerPathname, prefix))
      || segments.some((segment) => DENIED_SEGMENTS.includes(segment))) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

function isCliApiPath(pathname) {
  return canonicalApiTarget(pathname) === pathname;
}

// Secret-declaration proposals use otherwise-generic session endpoints for
// voting, force-merging, withdrawal, and restoration. Those endpoints cannot
// be denied by pathname without also disabling ordinary PR workflows, so the
// route handlers use this immutable platform branch marker after loading the
// session. Browser requests are deliberately unaffected.
function isCliCredentialManagementSession(req, session) {
  return !!req?.cliAuthenticated
    && typeof session?.branch_name === 'string'
    && session.branch_name.startsWith(SECRET_DECLARATION_BRANCH_PREFIX);
}

module.exports = {
  MAX_API_TARGET_BYTES,
  DENIED_PREFIXES,
  DENIED_SEGMENTS,
  SECRET_DECLARATION_BRANCH_PREFIX,
  canonicalApiTarget,
  isCliApiPath,
  isCliCredentialManagementSession,
};
