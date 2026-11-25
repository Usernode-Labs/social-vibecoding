'use strict';

// Generated profile pictures (#7135).
//
// A person who has not uploaded a photo still needs a picture. The old
// fallback was one shared drawing, so every such profile looked alike and
// read as though the person had picked it. This draws one picture per
// account instead, from shapes and colour blocks: the same token always
// yields the same bytes, nothing new is stored, and two accounts practically
// never collide.
//
// The token is the first 20 hex characters of sha256('homeroom-avatar:v1:' +
// userId). Keying on the user id (not the username) means a rename keeps the
// picture, and account ids already reach clients in conversation payloads,
// so the token discloses nothing new.
//
// The drawing is a pure function of the token. It emits only svg, rect,
// circle and path, with every number formatted from the token's own hash:
// no text and no user input ever reaches the document, so it is safe to
// serve with the same year-long immutable cache as an uploaded photo.

const crypto = require('crypto');

const TOKEN_RE = /^[a-f0-9]{20}$/;
const TOKEN_PREFIX = 'homeroom-avatar:v1:';
const DRAW_PREFIX = 'homeroom-avatar-draw:v1:';
const SIZE = 64;

// Twelve mid-tone hues. Each background is opaque and mid-luminance, so the
// picture reads the same on a light and a dark page; `tint` and `shade` are
// its own lighter and darker steps. A neighbouring hue colours the third
// shape, so it belongs to the picture without matching the background.
const PALETTE = Object.freeze([
  Object.freeze({ bg: '#3f7d6e', tint: '#8fd1b9', shade: '#1f4a40' }), // teal
  Object.freeze({ bg: '#5b5fc7', tint: '#b9bdf5', shade: '#3a3d8a' }), // indigo
  Object.freeze({ bg: '#b4573f', tint: '#f2c9a0', shade: '#6b2a1c' }), // terracotta
  Object.freeze({ bg: '#7b4a8f', tint: '#d9b8e8', shade: '#4a2a58' }), // plum
  Object.freeze({ bg: '#a8792a', tint: '#e8c46a', shade: '#5d4316' }), // ochre
  Object.freeze({ bg: '#3f6b8f', tint: '#a9cbe3', shade: '#243f55' }), // slate
  Object.freeze({ bg: '#5b7a3a', tint: '#bcd68f', shade: '#33461f' }), // moss
  Object.freeze({ bg: '#a8465f', tint: '#f0b8c4', shade: '#632636' }), // rose
  Object.freeze({ bg: '#2b7f8c', tint: '#9fd9e0', shade: '#184c55' }), // cyan
  Object.freeze({ bg: '#b06a24', tint: '#f0c48a', shade: '#663c12' }), // amber
  Object.freeze({ bg: '#6a5aa8', tint: '#c7bdf0', shade: '#413570' }), // violet
  Object.freeze({ bg: '#8a5a3a', tint: '#e0b89a', shade: '#4f3120' }), // brown
]);

// The token as it appears in the address: /avatars/g/<token>.svg
function generatedAvatarToken(userId) {
  return crypto.createHash('sha256')
    .update(`${TOKEN_PREFIX}${userId}`)
    .digest('hex')
    .slice(0, 20);
}

function isGeneratedAvatarToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

// Which of the four corners the big shape bleeds from. Fixed composition,
// chosen per account, so every picture is anchored the same way rather than
// drifting into four unrelated blobs.
const CORNERS = Object.freeze([[0, 0], [1, 0], [0, 1], [1, 1]]);

function renderGeneratedAvatar(token) {
  if (!isGeneratedAvatarToken(token)) return null;
  const bytes = crypto.createHash('sha256').update(`${DRAW_PREFIX}${token}`).digest();
  const at = (i) => bytes[i];
  const bgIndex = at(0) % PALETTE.length;
  const bg = PALETTE[bgIndex];
  const nearer = PALETTE[(bgIndex + 1 + (at(1) % 5)) % PALETTE.length];

  // The big circle: a light disc bleeding out of one corner.
  const circleCorner = CORNERS[at(2) % CORNERS.length];
  const cx = (circleCorner[0] ? SIZE - 10 : 10) + (at(3) % 9) - 4;
  const cy = (circleCorner[1] ? SIZE - 10 : 10) + (at(4) % 9) - 4;
  const cr = 18 + (at(5) % 15);

  // The block: a darker rounded square from another corner, slightly turned.
  const squareCorner = CORNERS[(at(2) + 1 + (at(6) % 3)) % CORNERS.length];
  const sw = 24 + (at(7) % 13);
  const sh = 20 + (at(8) % 13);
  const sx = squareCorner[0] ? SIZE - 10 - (at(9) % 8) : -10 + (at(9) % 8);
  const sy = squareCorner[1] ? SIZE - 10 - (at(10) % 8) : -10 + (at(10) % 8);
  const srx = 5 + (at(11) % 6);
  const sr = (at(12) % 51) - 25;

  // The half-disc: a small mark in the neighbouring hue, near the middle.
  const hx = 18 + (at(13) % 28);
  const hy = 18 + (at(14) % 28);
  const hr = 9 + (at(15) % 7);
  const hrot = (at(16) * 360 / 256) | 0;

  // Every value above is an integer, so the markup is byte-identical for the
  // same token. The background is opaque: the picture is the same picture on
  // a light or a dark page, and the round frame just clips it.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" fill="${bg.bg}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${cr}" fill="${bg.tint}"/>`,
    `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${srx}" fill="${bg.shade}" transform="rotate(${sr} ${sx + sw / 2} ${sy + sh / 2})"/>`,
    `<path d="M${-hr} 0 A ${hr} ${hr} 0 0 1 ${hr} 0 Z" fill="${nearer.bg}" transform="translate(${hx} ${hy}) rotate(${hrot})"/>`,
    '</svg>',
  ].join('');
}

module.exports = {
  generatedAvatarToken,
  isGeneratedAvatarToken,
  renderGeneratedAvatar,
  PALETTE,
};
