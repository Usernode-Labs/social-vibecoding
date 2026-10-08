// Speech input for the composers (#4389): the browser's own Web Speech API,
// wrapped so no screen repeats the browser-specific parts. The Messages
// composer uses it for the mic in the Homeroom bot's chat; the make screen's
// speak button (#4385) adopts the same helper when it lands.
//
// No language is set, so the browser's own applies. Only FINAL results are
// reported, so `onText` carries whole phrases, not half-spoken words: each
// call carries every phrase recognised so far in this session, joined with
// spaces, which lets a caller rewrite its field rather than append blindly.
//
// Nothing here asks for a key, a service or server code — the recognition
// runs where it always ran, in the browser.

/** The slice of the Web Speech API this helper needs. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

/** The constructor, under either name the browsers ship it, or null outside a DOM. */
function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Whether this browser can recognise speech at all. A plain feature check a composer calls at render time. */
export function speechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export interface SpeechInputHandlers {
  /** The phrases recognised so far, joined with spaces. */
  onText: (transcript: string) => void;
  /** A plain-English reason the session failed, already mapped. */
  onError?: (message: string) => void;
  /** Recognition stopped, for any reason. Fires once per session. */
  onEnd?: () => void;
}

/** A recognition session. `stop()` ends it; what was heard so far stays reported. */
export interface SpeechInputSession {
  stop(): void;
}

/** The browser's error codes, as sentences a person can act on. */
function reason(code: string | undefined): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was declined.';
  if (code === 'no-speech') return 'Nothing was heard. Try again.';
  return 'Speaking didn’t work. Try again.';
}

/**
 * Start recognising speech. Continuous and interim-aware, but only final
 * phrases reach `onText`. The browser's own microphone permission prompt is
 * what a first press triggers; nothing here builds a permission screen.
 */
export function startSpeechInput(handlers: SpeechInputHandlers): SpeechInputSession {
  const Ctor = recognitionCtor();
  // Not expected — callers hide the control when `speechInputSupported()` is
  // false — but failing closed beats a session stuck "listening" forever.
  if (!Ctor) {
    handlers.onError?.(reason(undefined));
    handlers.onEnd?.();
    return { stop: () => {} };
  }
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;

  const phrases: string[] = [];
  // `stopped` marks a stop() we asked for: the `aborted` error the browser can
  // answer it with is ours, not a failure, and reports nothing.
  let stopped = false;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    handlers.onEnd?.();
  };

  recognition.onresult = (event) => {
    // `resultIndex` is the first result this event touched; everything before
    // it is already reported, so the walk starts there and keeps only finals.
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const phrase = (result[0]?.transcript || '').trim();
      if (phrase) phrases.push(phrase);
    }
    if (phrases.length) handlers.onText(phrases.join(' '));
  };
  recognition.onerror = (event) => {
    if (stopped && event.error === 'aborted') return;
    handlers.onError?.(reason(event.error));
  };
  recognition.onend = finish;

  try {
    recognition.start();
  } catch {
    // A start() that throws (already running, or the engine refused) is the
    // generic failure; there is nothing to stop and no onend coming.
    handlers.onError?.(reason(undefined));
    finish();
    return { stop: () => {} };
  }
  return {
    stop: () => {
      // The graceful stop, not abort(): the browser gets to flush the phrase
      // it was hearing, so "what was heard stays in the field".
      stopped = true;
      try { recognition.stop(); } catch { /* already stopped */ }
    },
  };
}
