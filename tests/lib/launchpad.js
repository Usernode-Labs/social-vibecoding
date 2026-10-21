const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../../frontend/src/features/dev-chat/launchpad.js');
const { englishPlatformI18n } = require('./platform-i18n');
// The resume banner reads its words through the language runtime's global.
const sandbox = { module: { exports: {} }, PlatformI18n: englishPlatformI18n() };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
module.exports = sandbox.module.exports;
