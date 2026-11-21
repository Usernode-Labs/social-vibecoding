/**
 * Artifacts (docs/plans/artifacts.md): what a private thread's artifact is
 * decides two things its pane and cards show. A design is a screen of a
 * project, drawn with its stylesheets, and can be requested as a plan. A
 * plain page is self-contained and stays in its thread: no Request it, no
 * New project, and never called a design. Pure, so the pane
 * (./design-pane.tsx), the version card (./design-card.tsx) and the compare
 * card (./bot-cards/compare.tsx) say the same.
 */

import type { DesignThread } from './api';

// What a design may post from: a thread put away posts nothing (services/design-threads.js POSTABLE).
const POSTABLE = ['open', 'posted', 'filed'];

/**
 * Pure: whether a thread's artifact offers Request it (the pane's and the
 * compare card's): a design of a project, open or posted already (its plan's
 * next version). A design for a project not made yet has nowhere to post:
 * the bot's Make the project card is its way out (bot-make.tsx). A plain
 * page never: it stays in its thread, and the server refuses it too
 * (services/design-threads.js isDesign).
 */
export function requestable(design: Pick<DesignThread, 'kind' | 'app' | 'state'> | null | undefined): boolean {
  return !!design && design.kind === 'design' && !!design.app && POSTABLE.includes(design.state);
}

/**
 * Pure: the ids of the pane's own words, by what the thread holds: a
 * design, a plain page, or, before it is read, not yet known (words that
 * fit either). A page is never called a design.
 */
export function paneWordIds(kind: DesignThread['kind'] | null | undefined): { label: string; loading: string; failed: string; frame: string } {
  if (kind === 'design') {
    return {
      label: 'messages:design.pane.label', loading: 'messages:design.pane.loading',
      failed: 'messages:design.pane.failed', frame: 'messages:design.pane.frameTitle',
    };
  }
  if (kind === 'page') {
    return {
      label: 'messages:design.pane.labelPage', loading: 'messages:design.pane.opening',
      failed: 'messages:design.pane.failedPage', frame: 'messages:design.pane.frameTitlePage',
    };
  }
  return {
    label: 'messages:design.pane.labelOpening', loading: 'messages:design.pane.opening',
    failed: 'messages:design.pane.openFailed', frame: 'messages:design.pane.frameTitle',
  };
}
