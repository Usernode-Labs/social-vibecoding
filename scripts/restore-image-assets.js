#!/usr/bin/env node
// docker-compose.dev.yml bind-mounts ./public for live editing, which masks
// files the image generated below /app/public. Restore missing ignored outputs
// from the image's protected copy without overwriting newer local builds.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMAGE_ASSETS = process.env.USERNODE_IMAGE_ASSET_DIR || '/opt/usernode-shell-assets';
const FILES = [
  'index.html',
  'css/tailwind.css',
];
// Everything the React build emitted, discovered rather than listed: it is
// more than one file now (frontend/vite.config.ts emits lazy route chunks
// beside assets/shell.js, today the admin console's sections). A hard-coded
// name here silently left a new chunk unrestored under the dev bind mount.
const ASSET_DIR = 'shell/assets';
function emittedShellAssets() {
  try {
    return fs.readdirSync(path.join(IMAGE_ASSETS, ASSET_DIR))
      .map((name) => path.posix.join(ASSET_DIR, name));
  } catch {
    // No image copy at all is the pre-existing "image is missing" case; let
    // the loop below report it against the entry the shell cannot boot
    // without, rather than throwing a readdir error here.
    return [`${ASSET_DIR}/shell.js`];
  }
}

const publicDir = path.join(ROOT, 'public');
const owner = fs.statSync(publicDir);

function createParentDirectories(destination) {
  const missing = [];
  let current = path.dirname(destination);
  while (current !== publicDir && !fs.existsSync(current)) {
    missing.push(current);
    current = path.dirname(current);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const directory of missing) fs.chownSync(directory, owner.uid, owner.gid);
}

for (const relative of [...FILES, ...emittedShellAssets()]) {
  const source = path.join(IMAGE_ASSETS, relative);
  const destination = path.join(ROOT, 'public', relative);
  if (fs.existsSync(destination)) continue;
  if (!fs.existsSync(source)) {
    throw new Error(`[restore-image-assets] image is missing ${source}`);
  }
  createParentDirectories(destination);
  fs.copyFileSync(source, destination);
  fs.chownSync(destination, owner.uid, owner.gid);
  console.log(`[restore-image-assets] restored public/${relative}`);
}
