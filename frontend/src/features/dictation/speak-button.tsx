import { useEffect, useRef, useState } from 'react';
import { MicrophoneIcon, XIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { appendTranscript, DictationSession, type DictationState } from './session';

const ERRORS: Record<string, string> = {
  permission_denied: 'core:dictation.error.permission', unsupported: 'core:dictation.error.unsupported',
  policy_blocked: 'core:dictation.error.policy',
  unavailable: 'core:dictation.error.unavailable', interrupted: 'core:dictation.error.interrupted',
  invalid_audio: 'core:dictation.error.invalidAudio', no_speech: 'core:dictation.error.noSpeech',
  key_required: 'core:dictation.error.keyRequired', credits_required: 'core:dictation.error.credits',
  too_long: 'core:dictation.error.tooLong', timeout: 'core:dictation.error.timeout', busy: 'core:dictation.error.busy',
};

export interface SpeakButtonProps {
  scope: string;
  getText: () => string;
  onText: (text: string) => void;
  maxLength: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

/** Adds words through the field's existing writer, including legacy drafts. */
export function SpeakButton(props: SpeakButtonProps) {
  const t = useMessages('core');
  const current = useRef(props); current.current = props;
  const session = useRef<DictationSession | null>(null);
  const [state, setState] = useState<DictationState>({ phase: 'idle', error: null });
  useEffect(() => {
    if (props.disabled) { setState({ phase: 'idle', error: null }); return undefined; }
    const scope = props.scope;
    let busy = false;
    const capture = new DictationSession({ onState: (next) => { busy = next.phase !== 'idle'; setState(next); current.current.onBusyChange?.(busy); }, onText: (text) => {
      const target = current.current;
      if (target.scope !== scope || target.disabled) return;
      target.onText(appendTranscript(target.getText(), text, target.maxLength));
    } });
    session.current = capture;
    const leave = () => capture.cancel();
    const hide = () => { if (document.hidden) leave(); };
    // A field's own submit cancels dictation before it can refill a sent box.
    const submit = (event: Event) => {
      const target = event.target as Element | null;
      if (busy && target?.contains(button.current)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('submit', submit, true);
    const shortcut = (event: KeyboardEvent) => {
      const form = button.current?.closest('form');
      if (busy && form?.contains(event.target as Node) && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    document.addEventListener('keydown', shortcut, true);
    window.addEventListener('hashchange', leave);
    return () => {
      capture.cancel(); session.current = null;
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('submit', submit, true);
      document.removeEventListener('keydown', shortcut, true);
      window.removeEventListener('hashchange', leave);
    };
  }, [props.scope, props.disabled]);
  const button = useRef<HTMLButtonElement>(null);
  const busy = state.phase !== 'idle';
  const recording = state.phase === 'recording';
  const label = recording ? t('core:dictation.stop') : state.phase === 'asking' ? t('core:dictation.permission')
    : state.phase === 'transcribing' ? t('core:dictation.transcribing') : t('core:dictation.speak');
  return (
    <span className="relative inline-flex shrink-0 items-center" data-dictation={state.phase}>
      <button ref={button} type="button" disabled={props.disabled || (busy && !recording)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => { if (recording) session.current?.stop(); else void session.current?.start(); }}
        className={`relative inline-flex h-9 w-9 after:absolute after:-inset-1 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:opacity-40 ${recording ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}
        aria-label={label} title={label} aria-pressed={recording}>
        {recording ? <span className="h-3 w-3 rounded-sm bg-current" aria-hidden="true" /> : <MicrophoneIcon className="h-5 w-5" aria-hidden="true" />}
      </button>
      {busy ? <button type="button" className="relative inline-flex h-9 w-9 after:absolute after:-inset-1 items-center justify-center rounded-full text-zinc-600 dark:text-zinc-300" onClick={() => session.current?.cancel()} aria-label={t('core:dictation.cancel')}><XIcon className="h-4 w-4" aria-hidden="true" /></button> : null}
      {busy || state.error ? <span role={state.error ? 'alert' : 'status'} className="absolute bottom-full right-0 z-20 mb-2 w-64 rounded-xl bg-white p-3 text-[13px] text-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700">{state.error ? t(ERRORS[state.error] || 'core:dictation.error.failed') : recording ? t('core:dictation.listening') : label}</span> : null}
    </span>
  );
}
