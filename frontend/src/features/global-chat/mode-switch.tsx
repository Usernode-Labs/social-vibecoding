import { useEffect } from 'react';

import { ChatIcon } from '@/components/ui/icons';

import {
  initializeGlobalChat,
  toggleGlobalChat,
  useGlobalChatState,
} from './store';

/**
 * The only persisted fact is the thread; this control's mode starts Classic
 * on every document and native-WebView launch by construction.
 */
export function GlobalChatModeSwitch() {
  const snapshot = useGlobalChatState();

  useEffect(() => {
    void initializeGlobalChat();
    const retry = () => { void initializeGlobalChat({ force: true }); };
    window.addEventListener('sv:authed', retry);
    return () => window.removeEventListener('sv:authed', retry);
  }, []);

  // This is the release gate, not a cohort flag. The control is absent until
  // the checked-in parity artifact says the complete experimental interface
  // is ready; once true it is shown to every signed-in viewer.
  if (!snapshot.bootstrap?.parityReady) return null;

  const label = snapshot.open ? 'Classic' : 'Chat';
  return (
    <button
      id="global-chat-mode-switch"
      type="button"
      className={`global-chat-mode-switch${snapshot.open ? ' is-chat' : ''}`}
      aria-pressed={snapshot.open}
      aria-label={snapshot.open ? 'Switch to Classic mode' : 'Switch to Chat (experimental)'}
      title={snapshot.open ? 'Switch to Classic mode' : 'Switch to Chat (experimental)'}
      onClick={() => void toggleGlobalChat()}
    >
      <ChatIcon className="w-4 h-4" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
