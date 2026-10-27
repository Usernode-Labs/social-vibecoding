'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getTemplateFiles } = require('../src/services/template');
const dir = path.resolve(process.argv[2]);
if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('Choose an empty starter output directory');
fs.mkdirSync(dir, { recursive: true });
for (const file of getTemplateFiles('Security fixture', 'security-fixture', 'postgres://unused')) {
  const target = path.join(dir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
}
