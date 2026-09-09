// The shell's markup AS THE BROWSER RENDERS IT: the prerendered document plus
// every interior that mounts on first reveal.
//
// A test that asks "does the shell ship this control?" used to read
// public/index.html, because every screen's markup was in it. Since the
// settings panes and the six anonymous-shell screens mount on reveal
// (frontend/src/lib/mount-on-reveal.ts), the document alone answers a
// narrower question — what is parsed on every load — and this answers the
// one those tests were asking. The interiors are rendered through the same
// components, with their roots marked mounted (./lazy-interiors.js), so what
// is asserted here is exactly what a reveal puts in the document.
//
// Use `interiorHtmlFor(id)` from ./lazy-interiors.js instead when a test
// slices BETWEEN two screen roots: in this concatenation the prerendered
// roots come first, empty, and the interiors after them.

const fs = require('node:fs');
const path = require('node:path');

const { lazyInteriorsHtml } = require('./lazy-interiors');

let cached = null;

function shellMarkup() {
  if (cached === null) {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    cached = `${html}\n${lazyInteriorsHtml()}`;
  }
  return cached;
}

module.exports = { shellMarkup };
