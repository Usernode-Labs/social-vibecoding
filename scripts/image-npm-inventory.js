'use strict';
const fs = require('node:fs');
const path = require('node:path');
const packages = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const location = path.join(dir, name);
    if (name.startsWith('@')) { walk(location); continue; }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
      packages.push({ path: location, name: pkg.name, version: pkg.version });
      walk(path.join(location, 'node_modules'));
    } catch { /* non-package directories */ }
  }
}
walk('/usr/local/lib/node_modules');
walk('/app/node_modules');
console.log(JSON.stringify(packages, null, 2));
