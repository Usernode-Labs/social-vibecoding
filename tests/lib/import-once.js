'use strict';

// `import()` an ES module from a CommonJS test, memoised by path.
//
// Two of the bundle's modules are plain `.js` that other bundle modules
// import — features/header/ai-credit.js is the first a test needed to drive
// directly. They cannot be `vm.runInContext`ed (a top-level `import` is a
// syntax error in a script), and re-importing on every case would hand each
// one a fresh module registry and therefore a different store object from
// the one the component under test reads.
const cache = new Map();

module.exports = function importOnce(absPath) {
  if (!cache.has(absPath)) cache.set(absPath, import(`file://${absPath}`));
  return cache.get(absPath);
};
