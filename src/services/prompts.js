'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');

let cached = null;

function getAppConventions() {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(CONVENTIONS_PATH, 'utf-8');
  } catch (err) {
    log.error('prompts', 'Failed to read app-conventions.md', { err: err.message });
    cached = '';
  }
  return cached;
}

module.exports = { getAppConventions };
