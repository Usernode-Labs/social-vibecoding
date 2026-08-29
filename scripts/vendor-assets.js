#!/usr/bin/env node
// Vendors every third-party browser asset the platform serves:
//
//   1. The shell's three libraries (marked, DOMPurify, qrcodejs), copied out
//      of node_modules into public/vendor/.
//   2. The pinned Tailwind browser runtime, FETCHED from its version-pinned
//      upstream URL into public/usernode-tailwind/v1/tailwind.js — the copy
//      child apps load instead of cdn.tailwindcss.com.
//
//   npm run vendor:assets
//
// (1) used to be <script src="https://cdn.jsdelivr.net/…"> tags in
// public/index.html. Serving them from our own origin removes the last
// cross-origin asset requests in the shell, which is what lets the service
// worker precache everything the app needs to render (and keeps QR codes and
// chat markdown working on networks that block jsdelivr).
//
// (2) is the fleet-wide equivalent: every app on the platform loads its
// styling engine from cdn.tailwindcss.com today, so one blocked host breaks
// every app at once. We serve the identical bytes from our own origin,
// modelled on /usernode-bridge/v1/ and /usernode-native/v1/.
//
// Filenames carry the version so a bump is a visible rename in review, and
// so a stale copy can never masquerade as the pinned one. The npm packages
// stay devDependencies: they are build-time inputs, so `npm ci --production`
// never ships a second copy into the runtime image.
//
// Same-origin script tags can't use Subresource Integrity meaningfully, so
// the sha384 digests that used to live in the `integrity` attributes are
// recorded in public/vendor/README.md instead — provenance you can re-verify
// against the upstream at any time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'vendor');

// package → { dist file inside the package, vendored filename, what it's for }
const ASSETS = [
  {
    pkg: 'marked',
    version: '15.0.12',
    from: 'marked.min.js',
    to: 'marked-15.0.12.min.js',
    purpose: 'Markdown → HTML for renderMarkdown() in public/js/dev-chat.js (also used by group-chat.js and app-view.js).',
  },
  {
    pkg: 'dompurify',
    version: '3.4.4',
    from: path.join('dist', 'purify.min.js'),
    to: 'purify-3.4.4.min.js',
    purpose: 'Sanitizes that rendered markdown before it reaches innerHTML. Never bypass it.',
  },
  {
    pkg: 'qrcodejs',
    version: '1.0.0',
    from: 'qrcode.min.js',
    to: 'qrcode-1.0.0.min.js',
    purpose: 'Wallet address QR codes (frontend/src/features/header/wallet-sheet.js, public/js/settings.js). npm mirror of davidshimjs/qrcodejs, which the old /gh/ CDN URL served UNPINNED.',
  },
];

// The curated OpenMoji subset (CC BY-SA 4.0) for illustrated app icons and
// decorative empty states. The full set is 4,495 files / 43 MB — vendoring a
// curated slice keeps the payload sane, and frontend/src/lib/openmoji.js
// falls back to the platform's plain text-emoji rendering for anything not
// in the manifest, so a missing glyph is a soft degrade, never a broken tile.
//
// Listed as emoji literals (reviewable), resolved to OpenMoji's
// codepoint-sequence filenames at vendor time; the run fails loudly if any
// entry stops resolving against the pinned package. The set is versioned AS A
// UNIT: the version lives in the generated manifest + the README table, not
// in 200 individual filenames.
const OPENMOJI = {
  pkg: 'openmoji',
  version: '17.0.0',
  srcDir: path.join('color', 'svg'),
  outDir: 'openmoji',
  manifest: path.join(ROOT, 'frontend', 'src', 'lib', 'openmoji-manifest.json'),
  emojis: [
    // tech & dev
    '🚀', '🛠️', '🔧', '🔨', '⚙️', '🧰', '💻', '🖥️', '📱', '⌨️', '🖱️', '💾', '💿', '📀', '📼', '🔌', '🔋', '📡', '🤖', '👾', '🧠', '⚡', '✨', '🔮', '💡', '🔦', '🔭', '🔬', '🧪', '🧬', '📊', '📈', '📉', '🧮', '🕹️', '📟', '🖨️', '📺', '📻',
    // communication
    '💬', '🗨️', '📣', '📢', '📨', '📬', '✉️', '📮', '🔔', '📞', '☎️',
    // docs & productivity
    '📝', '✏️', '🖊️', '🖋️', '🖍️', '📋', '📁', '📂', '🗂️', '📆', '📅', '⏰', '⏱️', '⏳', '📌', '📍', '✂️', '📎', '📏', '📐', '🗃️', '🗑️', '🔒', '🔓', '🔑', '🗝️', '🔍', '🔎', '📖', '📚', '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📄', '🧾', '🏷️', '📦',
    // money & commerce
    '💰', '💵', '💸', '🪙', '💳', '🏦', '🛒', '🛍️', '💎', '⚖️',
    // games & sport
    '🎮', '🎲', '🎯', '🎰', '🧩', '♟️', '🃏', '🎳', '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏓', '🏸', '🏆', '🥇', '🏅', '🎖️',
    // media & art
    '🎨', '🖌️', '📷', '📸', '🎥', '🎬', '🎤', '🎧', '🎵', '🎶', '🎹', '🎸', '🥁', '🎺', '🎻', '🎭', '🖼️', '🎪',
    // food & drink
    '🍕', '🍔', '🍟', '🌮', '🌯', '🍜', '🍣', '🍩', '🍪', '🎂', '🍰', '🧁', '☕', '🍵', '🧋', '🍺', '🍷', '🥤', '🍎', '🍌', '🍉', '🍇', '🍓', '🥑', '🥕', '🌽', '🍞', '🥐', '🧀', '🍳',
    // nature & animals
    '🐱', '🐶', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦉', '🐴', '🦄', '🐝', '🦋', '🐌', '🐞', '🐢', '🐍', '🐙', '🦀', '🐠', '🐬', '🐳', '🦈', '🌱', '🌿', '🍀', '🌵', '🌴', '🌳', '🍄', '🌸', '🌼', '🌻', '🌹', '🌷', '💐', '🍁',
    // space & weather
    '☀️', '🌙', '⭐', '🌟', '💫', '🌈', '☁️', '❄️', '⛄', '🌊', '🔥', '💧', '🌍', '🌎', '🌏', '🪐', '🌌', '☄️',
    // transport & places
    '🚗', '🚕', '🚌', '🚲', '🛴', '🏍️', '✈️', '🚁', '🚢', '⛵', '🚂', '🏠', '🏡', '🏢', '🏰', '🗼', '🗽', '⛺', '🌋', '🏔️',
    // people & gesture
    '💪', '👀', '👁️', '👍', '✋', '🤝', '🙌', '👏', '🫶',
    // symbols & celebration
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💘', '💝', '☮️', '☯️', '✅', '❌', '❓', '❗', '♻️', '🎉', '🎊', '🎁', '🎈', '🪄', '🧿', '🔱', '📛',
    // the dev board's card-icon kinds (DEV_CARD_ICONS in public/js/app-view.js)
    '🗳️',
  ],
};

// OpenMoji names files by UPPERCASE hex codepoints joined with '-'. Single
// glyphs drop the FE0F variation selector ('2764.svg' for ❤️) while keycap
// and ZWJ sequences keep it ('0023-FE0F-20E3.svg'), so the resolver tries
// the full sequence first, then the FE0F-stripped one.
function openmojiCandidates(emoji) {
  const cps = [...emoji].map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const full = cps.join('-');
  const stripped = cps.filter((cp) => cp !== 'FE0F').join('-');
  return full === stripped ? [full] : [full, stripped];
}

// Assets fetched from a version-pinned upstream URL rather than npm. The
// Tailwind browser runtime is not published to npm for v3 (the package ships
// only the CLI and directive stubs — no dist/ CSS, no browser bundle), so the
// pinned CDN URL is the canonical source. We hold the bytes in memory and
// verify the digest BEFORE writing, so a failed or truncated fetch can never
// leave a corrupt file on disk for the platform to serve to every app.
const REMOTE_ASSETS = [
  {
    url: 'https://cdn.tailwindcss.com/3.4.17',
    to: path.join(ROOT, 'public', 'usernode-tailwind', 'v1', 'tailwind.js'),
    rel: 'public/usernode-tailwind/v1/tailwind.js',
    served: '/usernode-tailwind/v1/tailwind.js',
    name: 'Tailwind browser runtime',
    version: '3.4.17',
    // Verified against the pinned URL. cdn.tailwindcss.com (unpinned) 302s
    // here, so these are the exact bytes every app already runs today.
    sha384: 'igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K',
    purpose: 'The in-browser Tailwind engine child apps load instead of cdn.tailwindcss.com. Reads the inline `tailwind.config` set beside it, exactly as the CDN copy does, so an app swapping to it is behaviour-identical.',
  },
];

function fail(message) {
  console.error(`[vendor-assets] ${message}`);
  process.exit(1);
}

// Resolve the installed package directory by path rather than through
// require.resolve: modern packages (dompurify among them) declare an
// `exports` map that deliberately does NOT expose ./package.json, so
// require.resolve('dompurify/package.json') throws even when it's installed.
function resolvePackageDir(pkg) {
  const dir = path.join(ROOT, 'node_modules', pkg);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    return fail(`${pkg} is not installed. Run \`npm install\` (dev dependencies included) first.`);
  }
  return dir;
}

// Download one pinned asset and verify it before it touches the disk.
// Every failure path here is fatal on purpose: a silently-skipped or
// half-written runtime would be served to the whole app fleet.
async function fetchRemote(asset) {
  let res;
  try {
    res = await fetch(asset.url, { redirect: 'follow' });
  } catch (err) {
    return fail(`could not fetch ${asset.url} (${err.message}). `
      + 'This step needs network access — re-run when online.');
  }
  if (!res.ok) fail(`${asset.url} returned HTTP ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  const sha384 = crypto.createHash('sha384').update(bytes).digest('base64');
  if (sha384 !== asset.sha384) {
    fail(`${asset.url} does not match its pinned digest.\n`
      + `  expected sha384-${asset.sha384}\n`
      + `  received sha384-${sha384} (${bytes.length} bytes)\n`
      + '  Upstream changed, the download truncated, or something is intercepting the request. '
      + 'Nothing was written. Do not update the digest without checking why it moved.');
  }

  fs.mkdirSync(path.dirname(asset.to), { recursive: true });
  fs.writeFileSync(asset.to, bytes);
  console.log(`[vendor-assets] ${asset.name} ${asset.version} → ${asset.rel} (${(bytes.length / 1024).toFixed(1)} KB)`);
  return { ...asset, sha384, bytes: bytes.length };
}

async function main() {
fs.mkdirSync(OUT_DIR, { recursive: true });

const rows = [];
for (const asset of ASSETS) {
  const dir = resolvePackageDir(asset.pkg);
  const installed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  // The vendored filename encodes a version; a mismatch means package.json
  // and this script disagree, and the copy would be mislabelled.
  if (installed !== asset.version) {
    fail(`${asset.pkg} is installed at ${installed} but this script vendors ${asset.version}. `
      + 'Update package.json and the ASSETS table (and the filename) together.');
  }
  const src = path.join(dir, asset.from);
  if (!fs.existsSync(src)) fail(`${asset.pkg}@${installed} has no ${asset.from} — check the package layout.`);

  const bytes = fs.readFileSync(src);
  fs.writeFileSync(path.join(OUT_DIR, asset.to), bytes);
  const sha384 = crypto.createHash('sha384').update(bytes).digest('base64');
  rows.push({ ...asset, installed, sha384, bytes: bytes.length });
  console.log(`[vendor-assets] ${asset.pkg}@${installed} → public/vendor/${asset.to} (${(bytes.length / 1024).toFixed(1)} KB)`);
}

// OpenMoji: resolve every curated emoji to its file in the pinned package,
// copy the slice, and write the lookup manifest the frontend helper imports.
// A literal that stops resolving fails the run with the full list, so the
// curated table and the pinned package can never silently drift apart.
const openmojiDir = resolvePackageDir(OPENMOJI.pkg);
{
  const installed = JSON.parse(fs.readFileSync(path.join(openmojiDir, 'package.json'), 'utf8')).version;
  if (installed !== OPENMOJI.version) {
    fail(`${OPENMOJI.pkg} is installed at ${installed} but this script vendors ${OPENMOJI.version}. `
      + 'Update package.json and the OPENMOJI table together.');
  }
}
const openmojiOut = path.join(OUT_DIR, OPENMOJI.outDir);
fs.rmSync(openmojiOut, { recursive: true, force: true });
fs.mkdirSync(openmojiOut, { recursive: true });
const openmojiNames = new Set();
const openmojiMissing = [];
for (const emoji of OPENMOJI.emojis) {
  const name = openmojiCandidates(emoji)
    .find((n) => fs.existsSync(path.join(openmojiDir, OPENMOJI.srcDir, `${n}.svg`)));
  if (!name) { openmojiMissing.push(emoji); continue; }
  openmojiNames.add(name);
}
if (openmojiMissing.length) {
  fail(`these curated emojis resolve to no file in ${OPENMOJI.pkg}@${OPENMOJI.version}: ${openmojiMissing.join(' ')}`);
}
const openmojiSorted = [...openmojiNames].sort();
const openmojiHash = crypto.createHash('sha384');
let openmojiBytes = 0;
for (const name of openmojiSorted) {
  const bytes = fs.readFileSync(path.join(openmojiDir, OPENMOJI.srcDir, `${name}.svg`));
  fs.writeFileSync(path.join(openmojiOut, `${name}.svg`), bytes);
  openmojiHash.update(name).update(bytes);
  openmojiBytes += bytes.length;
}
const openmojiDigest = openmojiHash.digest('base64');
fs.writeFileSync(
  OPENMOJI.manifest,
  `${JSON.stringify({ version: OPENMOJI.version, icons: openmojiSorted }, null, 1)}\n`,
);
console.log(`[vendor-assets] ${OPENMOJI.pkg}@${OPENMOJI.version} → public/vendor/openmoji/ `
  + `(${openmojiSorted.length} icons, ${(openmojiBytes / 1024).toFixed(1)} KB) + frontend/src/lib/openmoji-manifest.json`);

const remoteRows = [];
for (const asset of REMOTE_ASSETS) remoteRows.push(await fetchRemote(asset));

const readme = `# public/vendor — third-party browser libraries, self-hosted

GENERATED by \`npm run vendor:assets\` (scripts/vendor-assets.js). Do not
edit these files by hand: the next run overwrites them, and a hand-patched
copy no longer matches the digest recorded below.

The platform shell used to load all three from \`cdn.jsdelivr.net\`. Serving
them from our own origin means the shell makes **no cross-origin asset
requests at all**, so the service worker can precache everything needed to
render (public/sw.js \`SHELL_ASSETS\`), and QR codes and chat markdown keep
working on networks that block the CDN.

## Provenance

Each file is copied verbatim from the pinned devDependency in the repo root
\`package.json\`. Same-origin \`<script>\` tags can't use Subresource
Integrity, so the sha384 digests that used to live in the \`integrity\`
attributes are recorded here instead — re-verify any row against npm with:

    npm pack <package>@<version>   # then sha384 the dist file

The \`marked\` and \`dompurify\` digests below are **identical to the
\`integrity\` attributes the old jsdelivr tags carried**, i.e. these copies
are byte-for-byte what the CDN was serving. The \`qrcodejs\` digest matches
\`qrcodejs@1.0.0\` on npm — an improvement on the old tag, which pulled an
UNPINNED GitHub ref (\`/gh/davidshimjs/qrcodejs/qrcode.min.js\`) with no
integrity attribute at all.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
${rows.map((r) => `| \`${r.to}\` | \`${r.pkg}\` | ${r.installed} | \`${r.from.split(path.sep).join('/')}\` | \`${r.sha384}\` | ${(r.bytes / 1024).toFixed(1)} KB |`).join('\n')}

## What each one is for

${rows.map((r) => `- **${r.to}** — ${r.purpose}`).join('\n')}

## OpenMoji illustrated icons (subtle-y2k theme)

\`openmoji/\` holds a **curated slice** of the OpenMoji color set —
${openmojiSorted.length} SVGs copied verbatim from the pinned
\`openmoji@${OPENMOJI.version}\` package (\`color/svg/<sequence>.svg\`),
used for illustrated app-icon tiles and decorative empty states. The slice
is versioned **as a unit**: \`frontend/src/lib/openmoji-manifest.json\`
records the version plus every vendored sequence, and the lookup helper
falls back to plain text-emoji rendering for anything not listed, so the
curation is a soft boundary. Aggregate digest of the slice
(name+bytes, sorted): \`sha384-${openmojiDigest}\` (${(openmojiBytes / 1024).toFixed(1)} KB total).

**License: CC BY-SA 4.0.** Attribution — *All emojis designed by
[OpenMoji](https://openmoji.org) – the open-source emoji and icon project.
License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).*

## Centrally-hosted Tailwind runtime (served to child apps)

Not under \`public/vendor/\` — it lives at a versioned path modelled on
\`/usernode-bridge/v1/\` and \`/usernode-native/v1/\`, because it is
infrastructure this platform *serves to other apps* rather than an asset the
shell itself loads (the shell compiles its own stylesheet). Written by the
same \`npm run vendor:assets\` run.

Tailwind v3 publishes no browser bundle to npm, so the source is the
version-pinned CDN URL. The script holds the download in memory, checks the
sha384 below, and only then writes the file — a truncated or tampered fetch
fails the run instead of poisoning the copy the whole fleet loads.

| Served at | Source URL | Version | sha384 (base64) | Size |
|---|---|---|---|---|
${remoteRows.map((r) => `| \`${r.served}\` | \`${r.url}\` | ${r.version} | \`${r.sha384}\` | ${(r.bytes / 1024).toFixed(1)} KB |`).join('\n')}

${remoteRows.map((r) => `- **${r.rel}** — ${r.purpose}`).join('\n')}

Kept **byte-for-byte verbatim**, including the bundle's own
\`console.warn\` about not using the CDN in production. That warning is
expected and harmless (it is a warn, not an error, so it does not trip the
baseline no-console-errors proposal check, and apps already emit it today);
editing it out would break the digest guarantee that lets anyone re-verify
this file against upstream.

## Bumping a version

1. Change the pin in the root \`package.json\` **and** the matching entry in
   \`scripts/vendor-assets.js\` (version + filename), then \`npm install\`.
2. \`npm run vendor:assets\` — writes the new file and rewrites this README.
3. \`git rm\` the superseded file, and update the \`<script src>\` tags in
   \`public/index.html\` plus the \`SHELL_ASSETS\` list in \`public/sw.js\`.
   \`tests/pwa-shell-wiring.test.js\` and \`tests/tailwind-build.test.js\`
   fail if any of those fall out of sync, so the suite catches a half-done
   bump.
`;

fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme);
console.log('[vendor-assets] wrote public/vendor/README.md');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
