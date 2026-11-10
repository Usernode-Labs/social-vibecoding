/**
 * What an item's page (a request, a change) does the same way under one of
 * the frame's looks, whichever of the two it is.
 */
import { t as translate } from '../../../../lib/i18n/runtime';

/** The page's own way back: the chip the standard look draws over the sheet. */
export function topicBack(): void {
  document.querySelector<HTMLElement>('#gc-thread-back a')?.click();
}

/** Short facts on one line, joined as the language on screen joins them. */
export function dotLine(parts: readonly (string | null | undefined | false)[]): string {
  const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return said.length ? said.reduce((first, second) => translate('project:workRow.facts.pair', { first, second })) : '';
}

/**
 * Where a request stands on the kit's five stops (Plan, Build, Checks,
 * Vote, Live): asked, the plan is being made; a plan ready, the build
 * waits for a go; built, a change is under way; voted in, every stop is
 * done. Checks and Vote belong to the change, which says them itself.
 */
export function frameStop(stage: 'asked' | 'spec' | 'built' | 'voted'): { at: number; state: 'now' | 'wait' } {
  if (stage === 'spec') return { at: 1, state: 'wait' };
  if (stage === 'built') return { at: 1, state: 'now' };
  if (stage === 'voted') return { at: 5, state: 'now' };
  return { at: 0, state: 'now' };
}
