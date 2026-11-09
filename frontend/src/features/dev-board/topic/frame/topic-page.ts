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
