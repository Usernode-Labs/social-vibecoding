'use strict';

// Build from the Dockerfile's copied inputs, not the whole checkout. A normal
// local build hid the missing Kubernetes preflight scripts in proposal #6284.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const copy = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: file => !['node_modules', '.ssr', 'catalogs.generated.json'].includes(path.basename(file)),
  });
};

function shellInputs(dockerfile, destination) {
  const start = dockerfile.indexOf('FROM node:22-alpine AS shell');
  const end = dockerfile.indexOf('\nFROM ', start + 1);
  const stage = dockerfile.slice(start, end);
  const beforeBuild = stage.slice(0, stage.indexOf('node frontend/scripts/build-shell.mjs'));
  let directory = '/';
  for (const line of beforeBuild.split('\n')) {
    if (line.startsWith('WORKDIR ')) directory = line.slice(8).trim();
    if (!line.startsWith('COPY ')) continue;
    const parts = line.slice(5).trim().split(/\s+/);
    assert.ok(parts.every(part => !part.startsWith('--')), 'model new COPY options explicitly');
    const target = parts.pop();
    const targetPath = path.posix.resolve(directory, target);
    assert.ok(targetPath.startsWith('/build/'));
    for (const source of parts) {
      const input = path.join(ROOT, source);
      const folder = fs.statSync(input).isDirectory();
      const output = path.join(destination, targetPath.slice('/build/'.length),
        !folder && (parts.length > 1 || target.endsWith('/')) ? path.basename(source) : '');
      copy(input, output);
    }
  }
  fs.symlinkSync(path.join(ROOT, 'frontend/node_modules'), path.join(destination, 'frontend/node_modules'), 'dir');
  return stage;
}

for (const filename of ['Dockerfile', 'Dockerfile.kubernetes']) {
  test(`${filename}: language preflight and real shell build work with only image inputs`, { timeout: 120000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'language-image-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = fs.readFileSync(path.join(ROOT, filename), 'utf8');
    const stage = shellInputs(source, directory);
    execFileSync(process.execPath, ['frontend/scripts/build-shell.mjs'], {
      cwd: directory, env: { ...process.env, GIT_SHA: 'dev' }, timeout: 90000, stdio: 'pipe',
    });
    assert.ok(fs.existsSync(path.join(directory, 'public/index.html')));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'frontend/src/lib/i18n/catalogs.generated.json')));
    assert.equal(Object.keys(manifest.languages).length, 20);
    for (const packs of Object.values(manifest.manifest)) {
      for (const pack of Object.values(packs)) assert.ok(fs.existsSync(path.join(directory, 'public', pack.url)));
    }

    if (filename !== 'Dockerfile.kubernetes') return;
    // Execute the real catalog packaging instruction, then load the runtime
    // middleware from an isolated image-shaped directory without the repo.
    const packaging = stage.match(/^RUN mkdir -p server-locales[^]*?(?=\n\n)/m);
    assert.ok(packaging, 'the server catalogs must be packaged before the runtime COPY');
    execFileSync('sh', ['-c', packaging[0].slice(4)], { cwd: directory });
    const runtimeCopy = source.match(/^COPY --chown=node:node --from=shell (\/build\/server-locales) (\.\/frontend\/locales)$/m);
    assert.ok(runtimeCopy, 'the runtime must receive the packaged server catalogs');
    const runtime = path.join(directory, 'runtime');
    copy(path.join(directory, runtimeCopy[1].slice('/build/'.length)), path.join(runtime, runtimeCopy[2]));
    const modulePath = path.join(runtime, 'src/middleware/language-errors.js');
    copy(path.join(ROOT, 'src/middleware/language-errors.js'), modulePath);
    const { languageErrors } = createRequire(modulePath)(modulePath);
    const english = JSON.parse(fs.readFileSync(path.join(runtime, 'frontend/locales/en/server.json')));
    for (const language of Object.keys(manifest.languages).filter(value => value !== 'en')) {
      const entries = JSON.parse(fs.readFileSync(path.join(runtime, `frontend/locales/${language}/server.json`)));
      const key = Object.keys(english).find(id => !english[id].includes('{{') && entries[id]?.text !== english[id]);
      assert.ok(key, `${language} has translated server messages`);
      let sent;
      const res = { statusCode: 400, json(body) { sent = body; }, setHeader() {}, vary() {} };
      languageErrors({ path: '/api/example', headers: { cookie: `homeroom_language=${language}` } }, res, () => {});
      res.json({ error: english[key] });
      assert.equal(sent.error, entries[key].text, `${language} runtime catalog is available`);
      assert.deepEqual(fs.readdirSync(path.join(runtime, `frontend/locales/${language}`)), ['server.json']);
    }
  });
}
