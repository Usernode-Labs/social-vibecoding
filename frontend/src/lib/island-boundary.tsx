/**
 * One island's blast radius.
 *
 * ── Why this has to exist ─────────────────────────────────────────────
 *
 * `main.tsx` hydrates `document.body`. That is the right root — the shell IS
 * the document — but it means React's error handling has a failure mode this
 * codebase cannot live with: when a render or commit throws and nothing
 * catches it, React unmounts the WHOLE ROOT. With `document.body` as the
 * root, "unmount the root" empties the page. Every screen, the header, the
 * drawer, the app frame: gone, with no listeners left on anything. What is
 * left on screen is `html`'s background, which in dark mode is `zinc-950` —
 * i.e. a black, unresponsive screen with the header missing, which is exactly
 * how the failure gets reported.
 *
 * So the whole tree is one throw away from disappearing, no matter which
 * island threw and no matter how small the mistake was. That is the hole
 * this closes: a boundary below the root turns "the app vanished" into "one
 * island is missing", and everything else keeps working.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────
 *
 * No retry, no reload, no toast. A boundary that re-renders the subtree that
 * just threw usually throws again on the next frame, and a page that reloads
 * itself on an error destroys the state a reader was in the middle of. The
 * fallback is nothing at all unless a caller passes one: the island is
 * absent, which is honest, visible, and recoverable by navigating.
 *
 * React reports a caught error through `console.error` on its own, so the
 * failure is not silent to anyone looking. `islandErrors` keeps the list on
 * `window.UsernodeReact.islandErrors` as well, because "which island went"
 * is the question a bug report has to answer and the console is gone by the
 * time anyone asks.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface IslandError {
  /** The `name` its <Island> was given — the component, as the Shell calls it. */
  island: string;
  message: string;
  stack?: string;
}

/** Every island that has failed this page load, oldest first. */
export const islandErrors: IslandError[] = [];

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.islandErrors = islandErrors;
}

interface IslandProps {
  /** Identifies the island in `islandErrors`. Use the component's own name. */
  name: string;
  children: ReactNode;
  /** Rendered in the island's place after a throw. Defaults to nothing. */
  fallback?: ReactNode;
}

interface IslandState {
  failed: boolean;
}

/**
 * Renders `children` transparently — no wrapper element, so the markup and
 * the hydration match are exactly what they were without it.
 */
export class Island extends Component<IslandProps, IslandState> {
  state: IslandState = { failed: false };

  static getDerivedStateFromError(): IslandState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    islandErrors.push({
      island: this.props.name,
      message: (error && error.message) || String(error),
      stack: (info && info.componentStack) || undefined,
    });
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
