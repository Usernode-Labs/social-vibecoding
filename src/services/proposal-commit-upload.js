'use strict';

const MAX_UPLOAD_FILES = 200;
const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 8 * 1024;
const ALLOWED_FILE_MODES = new Set(['100644', '100755', '120000']);

function validateUploadPath(value) {
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > 1024
      || value.startsWith('/')
      || value.endsWith('/')
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('The local commit contains an unsupported file path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || segment.toLowerCase() === '.git')) {
    throw new Error('The local commit contains an unsupported file path');
  }
  return value;
}

module.exports = {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_COMMIT_MESSAGE_BYTES,
  ALLOWED_FILE_MODES,
  validateUploadPath,
};
