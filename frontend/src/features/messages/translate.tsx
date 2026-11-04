/**
 * #6081: read someone else's words in your own language, on a tap.
 *
 * One small hook, `useTranslate`, asks POST /api/translations for one or two
 * texts (a message, or a request's title and words) in the language the page
 * is read in. The answer is kept in this module for the session, so a
 * re-render or a reopened thread does not ask again; the server keeps it for
 * everyone else. `TranslateNote` is the line under the words: who wrote it in
 * what language, the way back to the original, or why it could not translate.
 *
 * Nothing is asked for until a person taps. Opening the page again shows the
 * original, as the spec says.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { getLanguage, languageName } from '../../lib/i18n/runtime';

export interface TranslateResult {
  state: 'translated' | 'same' | 'failed';
  text?: string;
  from?: string;
}

export type TranslateState = 'idle' | 'pending' | 'shown' | 'original' | 'same' | 'failed' | 'limit';

export interface TranslateView {
  /** What the words are doing right now. */
  state: TranslateState;
  /** The texts to draw: the translation while it is shown, the original otherwise. */
  texts: string[];
  /** The language the model read the source in, when it said. */
  from: string | null;
  ask: () => void;
  toggle: () => void;
}

const ANSWERS = new Map<string, TranslateResult[]>();

/** One answer key: the words and the language they were asked for. */
export function cacheKey(texts: readonly string[], language: string): string {
  return `${language}\u0000${texts.join('\u0000')}`;
}

/**
 * What a set of answers means for the line under the words, before the
 * reader's own Show original/Show translation is taken into account. A mixed
 * answer (a title already in the language, words translated) is shown: the
 * parts already in the language stay as written.
 */
export function viewOf(results: TranslateResult[] | null, texts: readonly string[]): {
  state: Exclude<TranslateState, 'pending' | 'original' | 'limit'>;
  texts: string[];
  from: string | null;
} {
  if (!results || !results.length) return { state: 'idle', texts: texts.slice(), from: null };
  const translated = results.filter((result) => result.state === 'translated' && typeof result.text === 'string');
  if (translated.length) {
    return {
      state: 'shown',
      texts: results.map((result, index) => (result.state === 'translated' && typeof result.text === 'string'
        ? result.text : texts[index])),
      from: translated.find((result) => result.from)?.from || null,
    };
  }
  if (results.every((result) => result.state === 'same')) return { state: 'same', texts: texts.slice(), from: null };
  return { state: 'failed', texts: texts.slice(), from: null };
}

/** The source language's name in the reader's language, or null when unknown. */
export function sourceName(tag: string | null): string | null {
  if (!tag) return null;
  try { return new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(tag) || null; } catch { return null; }
}

export function useTranslate(texts: readonly string[], { enabled = true }: { enabled?: boolean } = {}): TranslateView {
  // A new array of the same words is the same text; an edit is a new key.
  const joined = texts.join('\u0000');
  const [results, setResults] = useState<TranslateResult[] | null>(null);
  const [pending, setPending] = useState(false);
  const [limited, setLimited] = useState(false);
  const [original, setOriginal] = useState(false);
  const fetching = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // An edited message or request is a new text, so it starts over.
  useEffect(() => {
    setResults(null);
    setPending(false);
    setLimited(false);
    setOriginal(false);
  }, [joined]);

  const ask = useCallback(() => {
    if (!enabled || pending || fetching.current) return;
    const language = getLanguage();
    const key = cacheKey(texts, language);
    const known = ANSWERS.get(key);
    if (known) { setResults(known); setOriginal(false); return; }
    fetching.current = true;
    setPending(true);
    setLimited(false);
    void (async () => {
      try {
        const response = await fetch('/api/translations', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts, language }),
        });
        if (response.status === 429) {
          if (alive.current) { setLimited(true); setPending(false); }
          return;
        }
        if (!response.ok) {
          if (alive.current) { setResults(texts.map(() => ({ state: 'failed' as const }))); setPending(false); }
          return;
        }
        const data = await response.json();
        const answers = Array.isArray(data?.results) && data.results.length === texts.length
          ? data.results as TranslateResult[]
          : texts.map(() => ({ state: 'failed' as const }));
        ANSWERS.set(key, answers);
        if (alive.current) { setResults(answers); setPending(false); }
      } catch {
        if (alive.current) { setResults(texts.map(() => ({ state: 'failed' as const }))); setPending(false); }
      } finally {
        fetching.current = false;
      }
    })();
  }, [enabled, pending, joined]);

  const toggle = useCallback(() => { setOriginal((on) => !on); }, []);

  const base = viewOf(results, texts);
  const state: TranslateState = pending ? 'pending'
    : limited ? 'limit'
      : base.state === 'shown' ? (original ? 'original' : 'shown')
        : base.state;

  return {
    state,
    texts: base.state === 'shown' && !original ? base.texts : texts.slice(),
    from: base.from,
    ask,
    toggle,
  };
}

/** The line under the words: how to go back and forth, or why there is nothing to show. */
export function TranslateNote({ view, className = '' }: {
  view: Pick<TranslateView, 'state' | 'from' | 'toggle'>;
  className?: string;
}) {
  const t = useMessages('messages');
  if (view.state === 'idle') return null;
  if (view.state === 'pending') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.pending')}</div>;
  }
  if (view.state === 'failed') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.failed')}</div>;
  }
  if (view.state === 'limit') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.limit')}</div>;
  }
  if (view.state === 'same') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.same', { language: languageName(getLanguage()) })}</div>;
  }
  const shown = view.state === 'shown';
  const from = sourceName(view.from);
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 ${className}`}>
      <span>{from ? t('messages:translate.from', { language: from }) : t('messages:translate.translated')}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
        onClick={view.toggle}
      >
        {shown ? t('messages:translate.showOriginal') : t('messages:translate.showTranslation')}
      </button>
    </div>
  );
}
