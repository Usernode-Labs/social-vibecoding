#!/usr/bin/env node
// Writes a project exactly as Homeroom makes it from a starter, using the
// platform's own generator (src/services/template.js, read only).
//   node generate-project.js <platform-root> <starter> <app name> <out dir>
'use strict';
const fs = require('fs');
const path = require('path');

const [root, starter, name, out] = process.argv.slice(2);
if (!root || !starter || !name || !out) {
  console.error('usage: generate-project.js <platform-root> <starter> <app name> <out dir>');
  process.exit(2);
}
// The generator reads the platform's domain at load time; any value will do.
process.env.USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'apps.example.invalid';
const template = require(path.join(path.resolve(root), 'src/services/template.js'));
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const files = template.getTemplateFiles(name, slug, 'postgres://unused', null, { template: starter });
for (const f of files) {
  const dest = path.join(out, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.content, f.encoding === 'base64' ? 'base64' : undefined);
  if (f.mode) fs.chmodSync(dest, f.mode);
}
console.log(`${files.length} files written to ${out}`);
