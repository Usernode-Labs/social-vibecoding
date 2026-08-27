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
