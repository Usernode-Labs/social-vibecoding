// The scaffolded app template compiles its own Tailwind stylesheet instead
// of loading the styling engine from a third-party CDN.
//
// Background: every generated app used to ship
// `<script src="https://cdn.tailwindcss.com">` — a ~400 KB in-browser
// compiler, fetched from an origin nobody here controls, on every page load
// of every app in the fleet. One blocked host and every app renders as
// unstyled text. New apps now link a precompiled `/tailwind.css` (~7 KB)
// built by a stage in their own Dockerfile.
//
// As with the platform shell itself, the compile runs during `docker build`,
// which the platform performs on a fresh clone for every production deploy
// and every staging preview. The CSS is therefore regenerated from that
// commit's markup every time and cannot go stale. These tests pin the pieces
// that make that true.
//
// Run with: node --test tests/template-tailwind.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');

function files() {
  return getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret');
}

function file(list, p) {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
}

test('the scaffold links a precompiled stylesheet, not a CDN engine', () => {
  const html = file(files(), 'public/index.html');
  assert.ok(html.includes('<link rel="stylesheet" href="/tailwind.css">'),
    'index.html should link the app-relative /tailwind.css');
  assert.ok(!/<script[^>]+src="https:\/\/cdn\.tailwindcss\.com/.test(html),
    'index.html must not load the Tailwind CDN engine');
  assert.ok(!/tailwind\.config\s*=/.test(html),
    'the inline tailwind.config belongs in tailwind.config.js on the precompiled path');
});

test('the scaffold loads no off-origin subresources at all', () => {
  // Strip HTML comments first: the scaffold documents the hosted-runtime
  // escape hatch by showing the tag, and a commented tag fetches nothing.
  const html = file(files(), 'public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^https?:\/\//.test(m[1]),
      `scaffold index.html loads an off-origin asset: ${m[1]}`);
  }
  // And the documented escape hatch really is inert.
  const live = file(files(), 'public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!live.includes('usernode-tailwind'),
    'the hosted-runtime tag must stay commented out — the scaffold uses the precompiled path');
});

test('the generated tailwind.config.js matches the scaffold markup', () => {
  const cfg = file(files(), 'tailwind.config.js');
  // darkMode must be class-based: the scaffold sets <html class="dark">, and
  // the default (media) would key dark: variants off the OS preference.
  assert.match(cfg, /darkMode:\s*'class'/, 'config should set darkMode to class');
  // Required by the native UI kit so hover: styles do not stick after taps.
  assert.match(cfg, /hoverOnlyWhenSupported:\s*true/, 'config should set the hoverOnlyWhenSupported future flag');
  // Content globs must cover the app's own markup, including class names
  // written inside JS strings in those files.
  assert.match(cfg, /\.\/public\/\*\*\/\*\.html/, 'config should scan the app public HTML');
  assert.match(cfg, /\.\/public\/\*\*\/\*\.js/, 'config should scan the app public JS');
  assert.match(cfg, /safelist:\s*\[\]/, 'config should carry an explicit (empty) safelist');
});

test('the input stylesheet ships all three layers and stays out of public/', () => {
  const list = files();
  const input = file(list, 'styles/tailwind-input.css');
  for (const layer of ['@tailwind base', '@tailwind components', '@tailwind utilities']) {
    assert.ok(input.includes(layer), `input stylesheet needs ${layer}`);
  }
  // Serving it would be meaningless (the directives are build-time only).
  assert.ok(!list.some((f) => f.path.startsWith('public/') && f.content.includes('@tailwind ')),
    'the @tailwind directives must not be served from public/');
  // No committed artifact: the image build is the only producer.
  assert.ok(!list.some((f) => f.path === 'public/tailwind.css'),
    'public/tailwind.css must be built by the image, never committed');
});

test('the Dockerfile compiles the stylesheet in a builder stage', () => {
  const dockerfile = file(files(), 'Dockerfile');
  assert.match(dockerfile, /FROM node:22-alpine AS css/, 'needs a named builder stage');
  assert.match(dockerfile, /npm install tailwindcss@3\.4\.17/,
    'the builder stage should install the pinned Tailwind version');
  assert.match(dockerfile, /-o public\/tailwind\.css/, 'the builder stage should compile to public/tailwind.css');
  assert.match(dockerfile, /COPY --from=css \/build\/public\/tailwind\.css \.\/public\/tailwind\.css/,
    'the runtime stage should copy the compiled stylesheet in');

  // The runtime image must stay production-only: tailwindcss lives in the
  // builder stage and never reaches the shipped container.
  assert.match(dockerfile, /RUN npm install --production/, 'the runtime stage still installs production deps only');
  const runtime = dockerfile.slice(dockerfile.indexOf('RUN npm install --production'));
  assert.ok(!runtime.includes('tailwindcss'), 'the runtime stage must not install tailwindcss');

  // Ordering matters: COPY . . would clobber the compiled file if it landed
  // after the --from=css copy.
  assert.ok(dockerfile.indexOf('COPY . .') < dockerfile.indexOf('COPY --from=css'),
    'the compiled stylesheet must be copied AFTER the source tree');

  // Signal handling contract from the platform conventions is unchanged.
  assert.ok(dockerfile.includes('CMD ["node", "server.js"]'), 'CMD stays exec-form');
});

test('the build context carries what the builder stage needs', () => {
  const list = files();
  const ignore = file(list, '.dockerignore');
  for (const needed of ['tailwind.config.js', 'styles/tailwind-input.css']) {
    assert.ok(list.some((f) => f.path === needed), `scaffold ships ${needed}`);
  }
  // A .dockerignore entry for either would make the build fail at COPY.
  for (const line of ignore.split('\n').map((l) => l.trim()).filter(Boolean)) {
    assert.ok(!['styles', 'styles/', 'tailwind.config.js'].includes(line),
      `.dockerignore excludes ${line}, which the builder stage needs`);
  }
});

test('the scaffold keeps dependencies out of Git and Cloud Native Buildpacks input', () => {
  const list = files();
  assert.match(file(list, '.gitignore'), /^node_modules\/$/m,
    'generated apps must not commit dependency trees');
  const project = file(list, 'project.toml');
  assert.match(project, /schema-version = "0\.2"/);
  assert.match(project, /exclude = \[[\s\S]*"node_modules\/"[\s\S]*\]/,
    'kpack must exclude a dependency tree even if a repository accidentally tracks one');
});
