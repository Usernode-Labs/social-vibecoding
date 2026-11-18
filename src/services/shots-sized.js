'use strict';

// #6825: a still's two smaller copies and its blurred preview, made once
// when the still is saved and kept beside it (shot_run_files.thumb_*,
// screen_* and placeholder).
//
// Every slot that draws a before/after picture used to load the whole screen
// shot: a 1170x2532 PNG of 585 KB in a card's 84x182 slot, 3 MB in a
// side panel. A slot now takes the smallest copy that is sharp for it,
// through srcset (frontend/src/lib/shot-img.ts, public/js/app-view.js), and
// draws the preview at once while the file arrives.
//
// The originals are PNG; the copies are WebP, many times smaller at the same
// size. `sharp` ships prebuilt linuxmusl binaries for the node:22-alpine
// images, so the image build needs no extra tools.

const crypto = require('node:crypto');
const log = require('./logger');

// A card and the change header strip are the smallest slots; 600 px on the
// long side covers them at 3x.
const THUMB_EDGE = 600;
// The largest slot is about 400 CSS px wide (the side panel, a change's main
// picture), so 1200 px covers it at 3x.
const SCREEN_EDGE = 1200;
const COPY_QUALITY = 75;
// The preview: about 20 px wide, at most 1 KB, sent inside the shots view.
const PLACEHOLDER_WIDTH = 20;
const PLACEHOLDER_QUALITY = 30;
const MAX_PLACEHOLDER = 1400;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// One copy at most `edge` on its long side, never enlarged. Null when the
// source is already that small: the still's own file is the smaller one.
async function webpAt(sharp, buffer, edge) {
  const meta = await sharp(buffer).metadata();
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (!width || !height || Math.max(width, height) <= edge) return null;
  const { data, info } = await sharp(buffer)
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: COPY_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: data.length, sha256: sha256(data) };
}

// The preview a slot draws before its picture decodes: a 20 px wide WebP, as
// a data URI. Null if it would not be one worth sending.
async function placeholderFor(sharp, buffer) {
  const { data } = await sharp(buffer)
    .resize({ width: PLACEHOLDER_WIDTH, withoutEnlargement: true })
    .webp({ quality: PLACEHOLDER_QUALITY })
    .toBuffer({ resolveWithObject: true });
  const uri = `data:image/webp;base64,${data.toString('base64')}`;
  return uri.length <= MAX_PLACEHOLDER ? uri : null;
}

// `{ thumb, screen, placeholder }` for one still's PNG. Each copy is
// `{ data, width, height, bytes, sha256 }` or null. A copy no smaller than
// its source is left out, and a library failure returns all nulls: the still
// is saved and loads as it always did.
async function sizedCopies(buffer) {
  const empty = { thumb: null, screen: null, placeholder: null };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return empty;
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    log.warn('shots', 'Sized copies unavailable', { err: err.message });
    return empty;
  }
  try {
    const thumb = await webpAt(sharp, buffer, THUMB_EDGE);
    const screen = await webpAt(sharp, buffer, SCREEN_EDGE);
    const placeholder = await placeholderFor(sharp, buffer);
    const smaller = (copy, source) => (copy && copy.bytes < source.length ? copy : null);
    return {
      thumb: smaller(thumb, buffer),
      screen: smaller(screen, buffer),
      placeholder,
    };
  } catch (err) {
    log.warn('shots', 'Sized copies could not be made', { err: err.message });
    return empty;
  }
}

module.exports = {
  THUMB_EDGE, SCREEN_EDGE, MAX_PLACEHOLDER, sizedCopies,
};
