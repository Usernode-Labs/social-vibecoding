#!/usr/bin/env node
// Vendors every third-party browser asset the platform serves:
//
//   1. The shell's three libraries (marked, DOMPurify, qrcodejs), copied out
//      of node_modules into public/vendor/.
//   2. The pinned Tailwind browser runtime, FETCHED from its version-pinned
//      upstream URL into public/usernode-tailwind/v1/tailwind.js — the copy
//      child apps load instead of cdn.tailwindcss.com.
//   3. The shell's UI face, Geist, also fetched from a pinned URL into
//      public/vendor/ — with its OFL licence text beside it.
//   4. The OpenMoji subset the illustrated icon tier draws from, into
//      public/vendor/openmoji/ — CC BY-SA 4.0, shipped unmodified.
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
    section: 'tailwind',
    version: '3.4.17',
    // Verified against the pinned URL. cdn.tailwindcss.com (unpinned) 302s
    // here, so these are the exact bytes every app already runs today.
    sha384: 'igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K',
    purpose: 'The in-browser Tailwind engine child apps load instead of cdn.tailwindcss.com. Reads the inline `tailwind.config` set beside it, exactly as the CDN copy does, so an app swapping to it is behaviour-identical.',
  },
  // Geist, the product's UI face (BRAND KIT 2026's supporting typeface).
  //
  // FETCHED rather than copied out of node_modules, even though `geist` IS on
  // npm, because that package is built for Next.js: it peer-depends on next
  // and react, so adding it as a devDependency pulls 51 packages — next,
  // react-dom, sharp and every @next/swc-* platform binary — into the lockfile
  // to obtain one 68 KB font file. jsdelivr serves the package's own contents
  // at a pinned version, and the two digests below were verified byte-for-byte
  // against the npm tarball (geist-1.7.2.tgz, itself checked against its
  // registry `integrity`), so these are the same bytes npm would have given us.
  {
    url: 'https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-sans/Geist-Variable.woff2',
    to: path.join(OUT_DIR, 'geist-sans-1.7.2-variable.woff2'),
    rel: 'public/vendor/geist-sans-1.7.2-variable.woff2',
    served: '/vendor/geist-sans-1.7.2-variable.woff2',
    name: 'Geist Sans (variable)',
    section: 'font',
    version: '1.7.2',
    sha384: 'A5ySEfg9NyEbLKjQhPQfEHVPKSFpeOQZ+rQiDggpNR4NUm2QTPnqukMat4Sh5JvE',
    purpose: 'The shell UI face, loaded by the @font-face at the top of public/css/app.css and set as fontFamily.sans in tailwind.config.js. The VARIABLE cut: 68 KB covers the whole 100-900 axis, against ~184 KB across four requests for the static weights the shell uses.',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/geist@1.7.2/LICENSE.txt',
    to: path.join(OUT_DIR, 'geist-1.7.2-LICENSE.txt'),
    rel: 'public/vendor/geist-1.7.2-LICENSE.txt',
    served: null,
    name: 'Geist licence (SIL OFL 1.1)',
    section: 'font',
    version: '1.7.2',
    sha384: 'jbtnSfDUTF5u+Kb3hsY4G3xZ++q0k162obR2ANXqKmAdeV4wqE4Nwi1uk90LnN8u',
    // The OFL requires the licence to travel with the font, so this is a
    // distribution obligation rather than an asset the browser ever requests —
    // the one file in public/vendor/ that is not served to anyone. It must not
    // be deleted as "unused".
    purpose: 'SIL Open Font License 1.1 for the Geist font above. Shipped beside it because the OFL requires it to be distributed with the font; never requested by the browser.',
  },
];


// ── OpenMoji (the illustrated icon tier) ────────────────────────────────
//
// App icons are emoji CHARACTERS, and rendering them as text hands the most-
// looked-at surface in the product to the viewer's platform font: the same
// app is Apple emoji on macOS, Segoe on Windows, Noto on Android, and on
// brand nowhere. Serving the glyph fixes that.
//
// A SUBSET, not the set. The package ships 11,458 SVGs and an author can pick
// any emoji, so completeness is not achievable and is not the goal — the
// renderer falls back to the plain character for anything unvendored, which
// is exactly the previous behaviour. See frontend/src/lib/openmoji.ts.
//
// Digests are NOT pinned per file here, unlike every asset above. Three
// reasons that is the right call and not laziness: there are ~100 of them and
// a hand-maintained digest table that large rots; they are static artwork
// rather than executable code, so a substituted file cannot do anything a
// wrong picture cannot; and the version in the URL is pinned, which is what
// stops the set drifting under us. The count and the version ARE asserted.
const OPENMOJI_VERSION = '17.0.0';
const OPENMOJI_DIR = path.join(ROOT, 'public', 'vendor', 'openmoji');
// Kept in step with VENDORED in frontend/src/lib/openmoji.ts —
// tests/openmoji-subset.test.js fails if the two lists diverge.
const OPENMOJI_STEMS = [
  '1F9EA', '1FA90', '1F3D7', '1F524', '1F319', '1F9FE', '1F4CD',
  '1F680', '2728', '1F4A1', '1F4CA', '1F4C8', '1F4DD', '1F4C5', '1F4CB',
  '1F3AF', '1F3AE', '1F3B2', '1F3B5', '1F3A8', '1F4F7', '1F4F1', '1F4BB',
  '1F5A5', '2699', '1F527', '1F528', '1F9F0', '1F50D', '1F513',
  '1F512', '1F4E6', '1F6D2', '1F4B0', '1F4B3', '1F3E0', '1F3E2', '1F5FA',
  '1F30D', '1F326', '2600', '1F331', '1F333', '1F340', '1F41B',
  '1F436', '1F431', '1F418', '1F984', '1F995', '2764', '2B50', '1F31F',
  '26A1', '1F525', '1F3C6', '1F947', '1F393', '1F4DA', '1F4D6', '270F',
  '1F58A', '1F4CE', '1F517', '1F5D3', '23F0', '231A', '1F553',
  '1F4AC', '1F4E3', '1F514', '1F4EC', '2709', '1F310', '1F6F0',
  '1F52C', '1F52D', '1F9EC', '1F9E0', '1F916', '1F47E', '1F3AA', '1F3AD',
  '1F3B8', '1F3BA', '1F374', '2615', '1F355', '1F34E', '1F95A', '1F9C1',
  '1F6B2', '2708', '1F697', '1F686', '26F5', '1F3D5', '1F3D6',
  '26F0', '1F30A', '1F3C3', '1F9D8', '1F3CB', '26BD', '1F3C0',
];

async function fetchOpenmoji() {
  fs.mkdirSync(OPENMOJI_DIR, { recursive: true });
  let bytes = 0;
  const missing = [];
  for (const stem of OPENMOJI_STEMS) {
    const url = `https://cdn.jsdelivr.net/npm/openmoji@${OPENMOJI_VERSION}/color/svg/${stem}.svg`;
    let res;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (err) {
      return fail(`could not fetch ${url} (${err.message}). This step needs network access.`);
    }
    // A 404 is a BAD STEM, not a soft miss: the list is hand-maintained, and a
    // typo would otherwise ship a renderer pointing at a file that does not
    // exist. Collect them all so one run names every bad entry.
    if (res.status === 404) { missing.push(stem); continue; }
    if (!res.ok) fail(`${url} returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(OPENMOJI_DIR, `${stem}.svg`), buf);
    bytes += buf.length;
  }
  if (missing.length) {
    fail(`OpenMoji has no artwork for: ${missing.join(', ')}. `
      + 'Fix the stem in OPENMOJI_STEMS (and in frontend/src/lib/openmoji.ts) '
      + 'rather than deleting it silently — a stem in the manifest that is not '
      + 'on disk renders a broken image, which is worse than the text fallback.');
  }
  console.log(`[vendor-assets] OpenMoji ${OPENMOJI_VERSION} → public/vendor/openmoji/ `
    + `(${OPENMOJI_STEMS.length} icons, ${(bytes / 1024).toFixed(1)} KB)`);
  return { count: OPENMOJI_STEMS.length, bytes };
}

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

const remoteRows = [];
for (const asset of REMOTE_ASSETS) remoteRows.push(await fetchRemote(asset));

// The remote assets are two unrelated things — the Tailwind runtime the
// platform serves to child apps, and the shell's own UI font — so they get
// their own README sections rather than one table under prose that only
// describes Tailwind.
const openmoji = await fetchOpenmoji();

const tailwindRows = remoteRows.filter((r) => r.section === 'tailwind');
const fontRows = remoteRows.filter((r) => r.section === 'font');

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

## The UI face (Geist)

Fetched from a version-pinned URL rather than copied out of \`node_modules\`,
even though \`geist\` **is** on npm. That package is built for Next.js and
peer-depends on \`next\` and \`react\`, so adding it as a devDependency pulls
51 packages — \`next\`, \`react-dom\`, \`sharp\` and every \`@next/swc-*\`
platform binary — into the lockfile to obtain one 68 KB font file. jsdelivr
serves the package's own contents at a pinned version, and the digests below
were verified byte-for-byte against the npm tarball (\`geist-1.7.2.tgz\`,
itself checked against its registry \`integrity\`), so these are the same
bytes npm would have handed us.

The **variable** cut is deliberate: one file covers the whole 100–900 axis,
where the four static weights the shell actually uses would be ~184 KB across
four requests.

| Served at | Source URL | Version | sha384 (base64) | Size |
|---|---|---|---|---|
${fontRows.map((r) => `| ${r.served ? `\`${r.served}\`` : '_(not served)_'} | \`${r.url}\` | ${r.version} | \`${r.sha384}\` | ${(r.bytes / 1024).toFixed(1)} KB |`).join('\n')}

${fontRows.map((r) => `- **${r.rel}** — ${r.purpose}`).join('\n')}

The licence file is the one thing in this directory the browser never
requests. It ships because the SIL OFL requires the licence to be
distributed with the font — do not delete it as unused.

## The illustrated icon tier (OpenMoji)

\`public/vendor/openmoji/\` — \${openmoji.count} SVG icons, \${(openmoji.bytes / 1024).toFixed(1)} KB, from
\`openmoji@\${OPENMOJI_VERSION}\` at a version-pinned jsdelivr path.

**All emojis designed by [OpenMoji](https://openmoji.org/) — the open-source
emoji and icon project. License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).**

That credit line is a licence obligation, not a courtesy. Two things follow
from CC BY-SA that a future change must not quietly break:

1. The attribution has to remain somewhere a reader can find it.
2. Any icon we **modify** must itself be distributed under CC BY-SA 4.0. We
   ship them unmodified, which keeps the obligation to (1) alone — recolouring
   one to the brand palette would change that.

Share-alike binds derivatives of the ARTWORK, not the application that renders
it, so this does not affect the licence of the shell.

### Why a subset

The package ships 11,458 SVGs. Vendoring all of them would put ~12 MB of
artwork in the image to serve a handful of glyphs, and an app author can pick
any emoji, so no subset is ever complete. That is why the renderer
(\`frontend/src/lib/openmoji.ts\`) falls back to the plain text character for
anything unvendored: a miss is exactly the behaviour the shell had before,
never a broken image.

Icons are served rather than typed because \`apps.icon_emoji\` is a CHARACTER,
and a character is painted by the viewer's own platform font — the same app
was Apple emoji on macOS, Segoe on Windows and Noto on Android. The launcher
now looks the same everywhere.

Filenames are OpenMoji's own codepoint stems, and the one trap is that OpenMoji
**drops** U+FE0F (🏗️ is \`1F3D7.svg\`) while **keeping** ZWJ (👩‍💻 is
\`1F469-200D-1F4BB.svg\`). \`tests/openmoji-subset.test.js\` pins both halves,
and the vendor step fails loudly on a stem with no artwork.

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
${tailwindRows.map((r) => `| \`${r.served}\` | \`${r.url}\` | ${r.version} | \`${r.sha384}\` | ${(r.bytes / 1024).toFixed(1)} KB |`).join('\n')}

${tailwindRows.map((r) => `- **${r.rel}** — ${r.purpose}`).join('\n')}

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
