import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speaking a message instead of typing it (#4389), through the browser's own
 * speech recognition: no new service, dependency or key. The helper carries
 * no Messages-specific code, so the make screen's speak button (#4385) can
 * use the same one.
 *
 * The caller decides the words: `onText` receives the dictated text and
 * `onError` a kind (`'blocked'` when the microphone was refused, `'failed'`
 * when the engine could not be used or could not start); the hook never
 * writes to the DOM. Silence and a refused `start` leave the button at rest
 * without a message, per the spec.
 */

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The constructor the browser offers, under either of its two names. */
export function speechRecognitionCtor(
  win?: { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor } | undefined,
): SpeechRecognitionCtor | null {
  // Server render has no window, and a caller that hands one in is trusted.
  const scope = win ?? (typeof window === 'undefined' ? undefined : (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }));
  if (!scope) return null;
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

/** What was already in the box, plus what was said, once, with one space. */
export function joinDictation(base: string, spoken: string): string {
  if (!spoken || !spoken.trim()) return base;
  return base + (base && !/\s$/.test(base) ? ' ' : '') + spoken.trim();
}

export type SpeechErrorKind = 'blocked' | 'failed';

export function useSpeechInput({ onText, onError }: { onText: (text: string) => void; onError: (kind: SpeechErrorKind) => void }): {
  supported: boolean;
  listening: boolean;
  start: (base: string) => void;
  stop: () => void;
  cancel: () => void;
} {
  // False on the first render, so the initial markup matches the server
  // prerender; an effect turns it on where the browser has the API.
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // A cancelled session's late results are dropped, so a send or a scope
  // change cannot refill the emptied box.
  const droppedRef = useRef(false);
  const baseRef = useRef('');
  // Kept in refs so a re-render never restarts a running recognition.
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTextRef.current = onText; onErrorRef.current = onError; });

  const cancel = useCallback(() => {
    droppedRef.current = true;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) { try { recognition.abort(); } catch { /* already stopped */ } }
    setListening(false);
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    // `stop()` keeps the engine's final result; `onend` returns the button.
    if (recognition) { try { recognition.stop(); } catch { /* not running */ } }
  }, []);

  const start = useCallback((base: string) => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    if (recognitionRef.current) { try { recognitionRef.current.abort(); } catch { /* already stopped */ } recognitionRef.current = null; }
    droppedRef.current = false;
    baseRef.current = base;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || (typeof document !== 'undefined' ? document.documentElement.lang : '') || 'en-US';
    recognition.onresult = (event) => {
      if (droppedRef.current) return;
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i][0]?.transcript || '';
      onTextRef.current(joinDictation(baseRef.current, transcript));
    };
    recognition.onerror = (event) => {
      const kind = event?.error;
      if (kind === 'not-allowed' || kind === 'service-not-allowed') onErrorRef.current('blocked');
      else if (kind === 'no-speech' || kind === 'aborted') { /* silence: the button just returns to rest */ }
      else onErrorRef.current('failed');
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // A second start on a running engine throws InvalidStateError.
      recognitionRef.current = null;
      setListening(false);
      onErrorRef.current('failed');
    }
  }, []);

  useEffect(() => {
    setSupported(!!speechRecognitionCtor());
  }, []);

  // Leaving the chat (unmount) stops listening and drops late results.
  useEffect(() => cancel, [cancel]);

  return { supported, listening, start, stop, cancel };
}