// Build-time entry for the SSG pass (see frontend/scripts/build-shell.mjs).
//
// Renders the shell tree to static markup, which the build then substitutes
// into the <body> of the generated public/index.html artifact. Prerendering
// (rather than mounting client-side) is what keeps the served document
// structurally identical to the hand-written one it replaces: the markup is
// in the HTML the browser parses, so the legacy scripts, the screenshot
// capture and a JS-less first paint all see exactly what they saw before.
import { renderToStaticMarkup, renderToString } from 'react-dom/server';

import { Shell } from './Shell';

export function renderShell(): string {
  return renderToStaticMarkup(<Shell />);
}

// The hydration-safety probe the build runs against the same tree.
//
// renderToStaticMarkup deliberately omits the `<!-- -->` text separators React
// writes between two ADJACENT TEXT CHILDREN — it is markup for a document
// nobody will hydrate. But this markup IS hydrated (main.tsx), and without the
// separator the browser parses one merged text node where the component
// renders two, which React reports as a mismatch: error #418, a console.error
// on every route, which fails the platform's proposal checks.
//
// renderToString emits those separators, so a `<!-- -->` in ITS output is an
// exact, heuristic-free locator for the offending component. build-shell.mjs
// diffs the two and refuses to write the artifact — see the note there.
export function renderShellWithSeparators(): string {
  return renderToString(<Shell />);
}
