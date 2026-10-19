import type { Typist } from './store';

/**
 * "ada is typing…", "ada, sam are typing…". A typist whose username did not
 * come with the row is a stand-in, and the line then has its own wording
 * instead of taking that word as a name.
 */
export function typingLine(t: (id: string, values?: Record<string, unknown>) => string, typing: readonly Typist[]): string {
  if (!typing.length) return '';
  const [first, second] = typing;
  if (typing.length === 1) return first.unnamed ? t('messages:thread.typingOneUnknown') : t('messages:thread.typingOne', { name: first.name });
  if (first.unnamed && second.unnamed) return t('messages:thread.typingTwoUnknown');
  if (first.unnamed) return t('messages:thread.typingTwoFirstUnknown', { second: second.name });
  if (second.unnamed) return t('messages:thread.typingTwoSecondUnknown', { first: first.name });
  return t('messages:thread.typingTwo', { first: first.name, second: second.name });
}
