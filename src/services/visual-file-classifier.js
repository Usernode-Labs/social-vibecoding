'use strict';

// Shared by the staging capture and exact-revision evidence pipelines. A
// plain .js or .ts file can be server code; only presentational extensions
// or an actual frontend directory make the changed-file heuristic positive.
const path = require('path');

const FRONTEND_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
  '.vue', '.svelte', '.jsx', '.tsx', '.svg',
]);
const FRONTEND_DIR_SEGMENTS = new Set([
  'public', 'static', 'assets', 'client', 'frontend', 'web', 'ui',
  'www', 'view', 'views', 'template', 'templates', 'component',
  'components', 'page', 'pages', 'style', 'styles',
]);

function isFrontendFile(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const extension = path.extname(normalized).toLowerCase();
  if (FRONTEND_EXTENSIONS.has(extension)) return true;
  const segments = normalized.split('/').slice(0, -1);
  return segments.some((segment) => FRONTEND_DIR_SEGMENTS.has(segment.toLowerCase()));
}

function isUiAffecting(files) {
  return Array.isArray(files) && files.some(isFrontendFile);
}

module.exports = { isFrontendFile, isUiAffecting };
