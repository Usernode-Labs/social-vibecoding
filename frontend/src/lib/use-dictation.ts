// #4389 — dictation for a chat composer: the browser's speech recognition,
// wired so spoken words land in the box for review before anything is sent.
//
// Built here rather than inside the Messages composer so the make screen's
// own "speak your idea" (#4385) can reuse it as-is. It knows nothing about
// message boxes: a caller gives it the language to hear and what to do with
// what it hears, and gets back whether the browser can listen at all, whether
// it is listening now, what went wrong, and the two taps that matter.
//
// ── Why the support check is a function and not a constant ────────────
//
// There is no `window` in the prerender pass, and a module-level probe would
// have to answer before any component renders — which is exactly how the
// prerendered document and the browser's first paint stop agreeing. So
// callers read this in an effect and render nothing about dictation until
// then: neither the button nor the hint is in the cold document.
//
// A `service-not-allowed` refusal is the browser saying the speech service
// itself is unavailable here — a policy or a missing backend, not a
// permission a person could grant — so a retry would only fail the same way.
// That sets the visit-wide flag below, and `dictationSupported()` answers
// false from then on: the button goes and the "type it instead" hint takes
// over for the rest of the visit. `not-allowed` is different in kind: it is
// the microphone permission, which can be granted, so the button stays.

import { useCallback, useEffect, useRef, useState } from 'react';

// ── The Web Speech API, declared locally ──────────────────────────────
//
// The DOM library this frontend compiles against does not type the
// recogniser, and adding a dependency or a global declaration for one
// interface is not the change. The module spells the few members it uses;
// `webkitSpeechRecognition` is Chrome's original name and still the only one
// some web views know.
type DictationAlternative = { transcript: string };
type DictationResult = { isFinal: boolean; length: number; [index: number]: DictationAlternative };
type DictationResultList = { length: number; [index: number]: DictationResult };
type DictationErrorEvent = { error: string };
type DictationRecogniser = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: DictationResultList }) => void) | null;
  onerror: ((event: DictationErrorEvent) => void) | null;
  onend: (() => void) | null;
};
type DictationRecogniserCtor = new () => DictationRecogniser;

function recogniserCtor(): DictationRecogniserCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: DictationRecogniserCtor;
    webkitSpeechRecognition?: DictationRecogniserCtor;
  };
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

// The visit-wide flip a `service-not-allowed` refusal sets. Not React state:
// it outlives every component that mounts this visit, so the next composer
// does not offer the button to fail again.
let visitUnsupported = false;

/** Whether this browser offers speech recognition and this visit may use it. */
export function dictationSupported(): boolean {
  return !visitUnsupported && recogniserCtor() !== null;
}

/**
 * `base` with `heard` after it: the base trimmed only at its end (a draft may
 * end mid-sentence with intent), one space between the two when both have
 * words, and `heard` trimmed (a recogniser's first interim can carry a
 * leading space). Either side alone stands as it is.
 */
export function joinDictation(base: string, heard: string): string {
  const kept = base.replace(/\s+$/, '');
  const spoken = heard.trim();
  if (!kept) return spoken;
  if (!spoken) return kept;
  return `${kept} ${spoken}`;
}

export type DictationError = 'blocked' | 'unsupported' | 'failed';

export type Dictation = {
  /** Read in an effect: false during the first render, whatever the browser. */
  supported: boolean;
  /**
   * The probe of `supported` has run. The caller renders the button for
   * `supported` alone, but a "not available here" line needs `ready` too:
   * during the first render the answer is not in yet, and showing it then
   * would flash in a browser that does support dictation.
   */
  ready: boolean;
  listening: boolean;
  error: DictationError | null;
  start: () => void;
  stop: () => void;
};

/**
 * Listen to the microphone and report everything heard since `start()`:
 * `onText(finalText, interimText)` where `finalText` is the sentences the
 * recogniser has settled and `interimText` the words it is still guessing.
 * Nothing is sent anywhere and nothing clears a box — the caller composes the
 * value it wants, typically `joinDictation(whatWasThere, joinDictation(final, interim))`.
 *
 * `lang` is the tag to hear, read at `start()` time so a language change
 * between listens is honoured without remounting anything.
 */
export function useDictation({ lang, onText }: {
  lang: string;
  onText: (finalText: string, interimText: string) => void;
}): Dictation {
  const [supported, setSupported] = useState(false);
  // One probe, two answers: whether the browser can listen (which flips
  // `supported`) and whether the probe itself has run (which flips `ready`).
  // Both start false so nothing about dictation is in the first render.
  const [ready, setReady] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<DictationError | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const recogniserRef = useRef<DictationRecogniser | null>(null);
  const listeningRef = useRef(false);
  const finalsRef = useRef<string[]>([]);

  useEffect(() => {
    if (dictationSupported()) setSupported(true);
    setReady(true);
  }, []);

  useEffect(() => () => {
    listeningRef.current = false;
    recogniserRef.current?.abort();
    recogniserRef.current = null;
  }, []);

  const start = useCallback(() => {
    if (listeningRef.current || visitUnsupported) return;
    const Ctor = recogniserCtor();
    if (!Ctor) return;
    setError(null);
    finalsRef.current = [];
    const recogniser = new Ctor();
    recogniser.lang = langRef.current;
    recogniser.continuous = true;
    recogniser.interimResults = true;
    let interim = '';
    recogniser.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          const said = result[0].transcript.trim();
          if (said) finalsRef.current.push(said);
          interim = '';
        } else {
          interim = result[0].transcript;
        }
      }
      onTextRef.current(finalsRef.current.join(' '), interim);
    };
    recogniser.onerror = (event) => {
      if (event.error === 'not-allowed') {
        setError('blocked');
      } else if (event.error === 'service-not-allowed') {
        // Not a permission the person can grant: this visit stops offering it.
        visitUnsupported = true;
        setSupported(false);
        setError('unsupported');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError('failed');
      }
    };
    recogniser.onend = () => {
      listeningRef.current = false;
      setListening(false);
      if (recogniserRef.current === recogniser) recogniserRef.current = null;
    };
    recogniserRef.current = recogniser;
    listeningRef.current = true;
    setListening(true);
    try {
      recogniser.start();
    } catch {
      // Already running (`InvalidStateError`) — the same recogniser's end
      // event settles the state; nothing else to do here.
    }
  }, []);

  const stop = useCallback(() => {
    if (recogniserRef.current) {
      // abort(), not stop(): stop() lets the recogniser finish its current
      // phrase, which can deliver one last result after the person asked to
      // stop — words they did not review would land in the box anyway.
      recogniserRef.current.abort();
      recogniserRef.current = null;
    }
    listeningRef.current = false;
    setListening(false);
  }, []);

  return { supported, ready, listening, error, start, stop };
}
