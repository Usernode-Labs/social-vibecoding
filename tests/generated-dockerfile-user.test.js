'use strict';

// Every Dockerfile the PLATFORM writes on an app's behalf must declare a
// numeric, non-zero USER (#2302).
//
// WHY THIS TEST EXISTS, rather than a line in the conventions:
//
// Kubernetes runs app and preview pods with `runAsNonRoot: true` and supplies
// no `runAsUser` (services/kubernetes.js, podSecurityContext). An image that
// names no user runs as the base image's default — root — and the kubelet
// refuses to start it:
//
//     CreateContainerConfigError:
//     container has runAsNonRoot and image will run as root
//
// The app template was corrected for this. Nothing pinned it, and an audit of
// the fleet then found 36 of 38 app repositories with no USER line at all,
// plus a second generator in routes/sessions.js still emitting the old shape
// long after the template stopped. A convention that only lives in prose is a
// convention that drifts one generator at a time, and each drifted app costs
// its own pull request and its own group vote to put back.
//
// So the rule is enforced over the SOURCE rather than over a list of known
// generators: any future `FROM node:` Dockerfile literal added anywhere under
// src/ is held to it the day it is written.
//
// NUMERIC is the part that is easy to get wrong. A symbolic `USER node` looks
// correct and is rejected the same way, because the kubelet resolves the user
// before the container starts and cannot read the image's /etc/passwd to check
// it. `USER 0` is root by another name. Both fail here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** Every .js file under src/, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Every Dockerfile-shaped template literal in one source file.
 *
 * A generated Dockerfile is a backtick literal starting at `FROM node:`, so
 * the body runs from there to the closing backtick. Good enough to be exact
 * here and deliberately not a parser: a literal this test cannot read is a
 * literal a reviewer cannot read either.
 */
function generatedDockerfiles(source) {
  const found = [];
  const marker = /FROM node:/g;
  let m;
  while ((m = marker.exec(source)) !== null) {
    const end = source.indexOf('`', m.index);
    found.push(source.slice(m.index, end === -1 ? source.length : end));
  }
  return found;
}

const NUMERIC_USER = /^USER[ \t]+([0-9]+)(?::[0-9]+)?[ \t]*$/m;
const ANY_USER = /^USER[ \t]+(\S+)/m;

test('every Dockerfile the platform generates declares a numeric non-root USER', () => {
  let checked = 0;
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    for (const body of generatedDockerfiles(fs.readFileSync(file, 'utf8'))) {
      checked += 1;
      const numeric = NUMERIC_USER.exec(body);
      const any = ANY_USER.exec(body);
      assert.ok(
        numeric,
        `${rel}: this generated Dockerfile declares ${any ? `USER ${any[1]}, which is not numeric` : 'no USER'}. `
        + 'Kubernetes runs app pods with runAsNonRoot and no runAsUser, so the image must name a numeric '
        + 'non-zero user itself — a symbolic USER is rejected too, because the kubelet cannot resolve it '
        + 'before the container starts. Add `USER 1000:1000` to the final stage.'
      );
      assert.notStrictEqual(
        numeric[1], '0',
        `${rel}: USER 0 is root under another name, which runAsNonRoot rejects.`
      );
      // Not "is there a --chown anywhere" — that passes while the line that
      // matters goes bare. The SOURCE TREE copy is the one that decides what
      // the app can write, so a recursive COPY with no --chown is the failure,
      // however many other copies are chowned.
      const bareCopy = /^COPY[ \t]+(?!--chown)[^\n]*\.[ \t]+\.[ \t]*$/m.exec(body);
      assert.ok(
        !bareCopy,
        `${rel}: \`${bareCopy && bareCopy[0]}\` copies the source tree without --chown, so it stays `
        + 'root-owned under a non-root USER. Anything the app writes then fails at RUNTIME, in front of '
        + 'somebody, instead of at build time. Use `COPY --chown=1000:1000 . .`.'
      );
    }
  }
  assert.ok(checked >= 2, `expected to find the platform's generated Dockerfiles, found ${checked}`);
});

// The template is the one every new app is born from, so it is asserted by
// name as well — a failure here should say "the app template", not "some
// literal under src/".
test('the app template ships the non-root runtime stage', () => {
  const { getTemplateFiles } = require('../src/services/template');
  const files = getTemplateFiles('Test App', 'test-app-abc123', 'postgres://localhost/test');
  const dockerfile = files.find((f) => f.path === 'Dockerfile');
  assert.ok(dockerfile, 'the app template must ship a Dockerfile');
  assert.match(dockerfile.content, /^USER 1000:1000$/m, 'the app template must declare a numeric non-root USER');
  assert.match(dockerfile.content, /COPY --chown=1000:1000 \. \./);
  // Exec form, so the process receives SIGTERM and the shutdown handler runs.
  assert.match(dockerfile.content, /^CMD \["node", "server\.js"\]$/m);
  // The USER switch must come AFTER the install, or npm cannot write.
  assert.ok(
    dockerfile.content.indexOf('USER 1000:1000') > dockerfile.content.lastIndexOf('RUN npm'),
    'USER must be declared after the last npm step, or the install runs unprivileged and fails'
  );
});
