// Build-time entry for the SSG pass (see frontend/scripts/build-shell.mjs).
//
// Renders the shell tree to static markup, which the build then substitutes
// into the <body> of the committed public/index.html artifact. Prerendering
// (rather than mounting client-side) is what keeps the served document
// structurally identical to the hand-written one it replaces: the markup is
// in the HTML the browser parses, so the legacy scripts, the screenshot
// capture and a JS-less first paint all see exactly what they saw before.
import { renderToStaticMarkup } from 'react-dom/server';

import { Shell } from './Shell';

export function renderShell(): string {
  return renderToStaticMarkup(<Shell />);
}
