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

/** The status pill's kind on the kit's card: green once live, amber while on others, blue while it asks for you. */
export function pillKind(status: { key: string; tone: string }, votes: { tone: string }): 'ok' | 'wait' | 'act' | '' {
  if (status.key === 'live' || status.tone === 'ok') return 'ok';
  if (votes.tone === 'ask') return 'act';
  if (status.tone === 'progress' || /vote|review|waiting/.test(status.key)) return 'wait';
  return '';
}

/**
 * The kind of the pill a request's page wears once a change is built for it
 * (../thread-model.ts requestPill, the pill the standard bar shows beside
 * the request's number): blue while a vote asks for you, amber while it is
 * being built or going live, green once live.
 */
export function threadPillKind(pill: { key: string; tone: string }): 'ok' | 'wait' | 'act' | '' {
  if (pill.tone === 'ok') return 'ok';
  if (pill.key === 'vote' || pill.key === 'choosing' || pill.key === 'close') return 'act';
  if (pill.tone === 'progress') return 'wait';
  return '';
}

/**
 * The first sentence of a line, which the kit's status card says in bold:
 * up to its first full stop when more follows it, the whole line when it is
 * one sentence (or ends in no mark this knows).
 */
export function firstSentence(text: string | null | undefined): string {
  const said = String(text || '');
  const cut = /^(.+?[.!?\u3002\uff01\uff1f])(?=\s)/u.exec(said);
  return cut ? cut[1] : said;
}
