'use strict';

const crypto = require('crypto');

const APP_SLUG_CONSTRAINT = 'apps_slug_key';
const DEFAULT_MAX_ATTEMPTS = 5;

class AppSlugAllocationError extends Error {
  constructor(attempts, cause) {
    super(`Could not reserve a unique app slug after ${attempts} attempts`);
    this.name = 'AppSlugAllocationError';
    this.code = 'APP_SLUG_UNAVAILABLE';
    this.attempts = attempts;
    this.cause = cause;
  }
}

// Keep the existing create/fork normalization contract. Display names remain
// untouched; this ASCII base is only the technical URL/repo/container key.
function appSlugBase(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateAppSlug(base, randomBytes = crypto.randomBytes) {
  return `${base}-${randomBytes(3).toString('hex')}`;
}

function isAppSlugCollision(err) {
  return !!err
    && err.code === '23505'
    && err.constraint === APP_SLUG_CONSTRAINT;
}

// PostgreSQL's UNIQUE(apps.slug) constraint is the race arbiter. Callers pass
// only the INSERT statement as insert, so a retry cannot repeat quota checks,
// repository verification, events, or async deploy side effects.
async function insertWithUniqueAppSlug(base, insert, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!base) throw new TypeError('insertWithUniqueAppSlug: base is required');
  if (typeof insert !== 'function') {
    throw new TypeError('insertWithUniqueAppSlug: insert must be a function');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('insertWithUniqueAppSlug: maxAttempts must be a positive integer');
  }

  let lastCollision = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slug = generateAppSlug(base, randomBytes);
    try {
      const value = await insert(slug);
      return { slug, value, attempts: attempt };
    } catch (err) {
      if (!isAppSlugCollision(err)) throw err;
      lastCollision = err;
    }
  }

  throw new AppSlugAllocationError(maxAttempts, lastCollision);
}

module.exports = {
  APP_SLUG_CONSTRAINT,
  DEFAULT_MAX_ATTEMPTS,
  AppSlugAllocationError,
  appSlugBase,
  generateAppSlug,
  isAppSlugCollision,
  insertWithUniqueAppSlug,
};
