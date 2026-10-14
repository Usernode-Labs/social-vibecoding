// #4389 — the composer's microphone button. Rendered only in the chat with
// Homeroom bot (the composer decides that); chats with people, groups and
// channels never mount this.
import { MicrophoneIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';

/**
 * The dictation toggle beside Send. `listening` lights it (app.css);
 * `onToggle` starts or stops the recogniser. The button keeps the field's
 * focus with `onMouseDown` preventDefault, the same contract Send and the
 * mention list are on, so a phone's keyboard does not drop through the tap.
 */
export function SpeakButton({ listening, onToggle }: {
  listening: boolean;
  onToggle: () => void;
}) {
  const t = useMessages('messages');
  const label = listening ? t('messages:composer.dictation.stop') : t('messages:composer.dictation.start');
  return (
    <button
      type="button"
      className="messages-composer-action messages-composer-speak"
      aria-pressed={listening}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      aria-label={label}
      title={label}
    >
      <MicrophoneIcon aria-hidden="true" />
    </button>
  );
}
