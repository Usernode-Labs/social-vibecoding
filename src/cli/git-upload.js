'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_COMMIT_MESSAGE_BYTES,
  ALLOWED_FILE_MODES,
  validateUploadPath,
} = require('../services/proposal-commit-upload');
const SHA_RE = /^[0-9a-f]{40}$/;

function runGit(repo, args, maxBuffer = 1024 * 1024) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: null,
    maxBuffer,
    shell: false,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') throw new Error('git is required to upload a proposal commit');
  if (result.error) throw new Error('The local Git commit is too large or could not be read');
  if (result.signal || result.status !== 0) {
    throw new Error(`Git could not inspect the local commit (${args[0]})`);
  }
  return result.stdout || Buffer.alloc(0);
}

function utf8(buffer, label) {
  const value = buffer.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(buffer)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return value;
}

function trimLine(buffer, label) {
  return utf8(buffer, label).replace(/[\r\n]+$/, '');
}

function splitNul(buffer) {
  const values = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) continue;
    values.push(buffer.subarray(start, i));
    start = i + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values.filter((value) => value.length);
}

function readTreeEntry(repo, commitSha, filePath) {
  // A committed filename may itself start with Git pathspec syntax such as
  // `:(literal)`. Force literal matching so inspecting that path cannot
  // accidentally select a different entry or turn a changed file into a
  // false deletion.
  const entryBuffer = runGit(repo, [
    '--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commitSha, '--', filePath,
  ], 8 * 1024);
  if (!entryBuffer.length) return null;
  const entries = splitNul(entryBuffer);
  if (entries.length !== 1) throw new Error('Git returned an ambiguous tree entry');
  const entry = utf8(entries[0], 'Git tree entry');
  const tab = entry.indexOf('\t');
  const header = tab >= 0 ? entry.slice(0, tab).split(' ') : [];
  const returnedPath = tab >= 0 ? entry.slice(tab + 1) : '';
  if (header.length !== 3 || returnedPath !== filePath || !SHA_RE.test(header[2])) {
    throw new Error('Git returned an invalid tree entry');
  }
  return { mode: header[0], type: header[1], sha: header[2] };
}

function collectCommitUpload(repoPath, requestedSha) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath) || /\u0000/.test(repoPath)) {
    throw new Error('proposal push requires an absolute --repo path');
  }
  if (typeof requestedSha !== 'string' || !SHA_RE.test(requestedSha.toLowerCase())) {
    throw new Error('proposal push requires a full 40-character --commit SHA');
  }
  const repo = fs.realpathSync(repoPath);
  const topLevel = fs.realpathSync(trimLine(
    runGit(repo, ['rev-parse', '--show-toplevel']),
    'Git repository path'
  ));
  const localCommitSha = trimLine(
    runGit(topLevel, ['rev-parse', '--verify', `${requestedSha}^{commit}`]),
    'Git commit SHA'
  ).toLowerCase();
  if (localCommitSha !== requestedSha.toLowerCase()) {
    throw new Error('The requested local commit did not resolve exactly');
  }

  const parentLine = trimLine(
    runGit(topLevel, ['rev-list', '--parents', '-n', '1', localCommitSha]),
    'Git commit parents'
  ).split(' ');
  if (parentLine.length !== 2 || parentLine[0] !== localCommitSha || !SHA_RE.test(parentLine[1])) {
    throw new Error('Proposal uploads require a non-merge commit with exactly one parent');
  }
  const parentSha = parentLine[1].toLowerCase();
  const parentTreeSha = trimLine(
    runGit(topLevel, ['rev-parse', `${parentSha}^{tree}`]),
    'Git parent tree SHA'
  ).toLowerCase();
  if (!SHA_RE.test(parentTreeSha)) throw new Error('Git returned an invalid parent tree SHA');
  const treeSha = trimLine(
    runGit(topLevel, ['rev-parse', `${localCommitSha}^{tree}`]),
    'Git tree SHA'
  ).toLowerCase();
  if (!SHA_RE.test(treeSha)) throw new Error('Git returned an invalid tree SHA');

  let message = utf8(
    runGit(topLevel, ['show', '-s', '--format=%B', localCommitSha], MAX_COMMIT_MESSAGE_BYTES + 1024),
    'Git commit message'
  ).replace(/[\r\n]+$/, '');
  if (!message) message = 'Local proposal update';
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES || /\u0000/.test(message)) {
    throw new Error(`The local commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes`);
  }
  const dates = splitNul(runGit(topLevel, [
    'show', '-s', '--format=%aI%x00%cI', localCommitSha,
  ])).map((value) => trimLine(value, 'Git commit date'));
  if (dates.length !== 2 || dates.some((value) => !Number.isFinite(Date.parse(value)))) {
    throw new Error('Git returned invalid commit timestamps');
  }

  const changedPathBuffers = splitNul(runGit(topLevel, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    parentSha, localCommitSha,
  ], 256 * 1024));
  if (!changedPathBuffers.length) throw new Error('The local commit has no file changes');
  if (changedPathBuffers.length > MAX_UPLOAD_FILES) {
    throw new Error(`The local commit changes more than ${MAX_UPLOAD_FILES} files`);
  }

  let totalBytes = 0;
  const seen = new Set();
  const files = changedPathBuffers.map((pathBuffer) => {
    const filePath = validateUploadPath(utf8(pathBuffer, 'Git file path'));
    if (seen.has(filePath)) throw new Error('The local commit contains a duplicate file path');
    seen.add(filePath);
    const entry = readTreeEntry(topLevel, localCommitSha, filePath);
    if (!entry) return { path: filePath, delete: true };
    if (entry.type === 'tree') {
      // `diff-tree -r` reports both the removed blob and the added children
      // when a file becomes a directory. The final commit has a tree at the
      // removed blob's path, so confirm the parent really held a supported
      // blob and preserve its deletion alongside the child additions.
      const parentEntry = readTreeEntry(topLevel, parentSha, filePath);
      if (parentEntry?.type === 'blob' && ALLOWED_FILE_MODES.has(parentEntry.mode)) {
        return { path: filePath, delete: true };
      }
      throw new Error('The local commit contains an unsupported Git tree entry');
    }
    if (entry.type !== 'blob' || !ALLOWED_FILE_MODES.has(entry.mode)) {
      throw new Error('The local commit contains an unsupported Git tree entry');
    }
    const content = runGit(
      topLevel,
      ['cat-file', 'blob', entry.sha],
      MAX_UPLOAD_FILE_BYTES + 64 * 1024
    );
    if (content.length > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`A changed file exceeds ${MAX_UPLOAD_FILE_BYTES} bytes`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error(`Changed files exceed ${MAX_UPLOAD_TOTAL_BYTES} total bytes`);
    }
    return {
      path: filePath,
      mode: entry.mode,
      contentBase64: content.toString('base64'),
    };
  });

  return {
    repo: topLevel,
    payload: {
      schemaVersion: 1,
      localCommitSha,
      parentSha,
      parentTreeSha,
      treeSha,
      message,
      authoredAt: dates[0],
      committedAt: dates[1],
      files,
    },
  };
}

module.exports = {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_COMMIT_MESSAGE_BYTES,
  ALLOWED_FILE_MODES,
  validateUploadPath,
  collectCommitUpload,
};
