/**
 * `#gc-messages` — the group chat transcript, as the only React writer below
 * that host.
 *
 * This is the deck's NAMED-ROW transcript (its "Recipe App · 2 members"
 * screen): a square avatar, a bold name at reading size, a time, and flat
 * content. It is built from @/components/ui/chat.tsx, which is what that
 * module was written for — the bubble transcript in the same file belongs to
 * the agent chat, and the two are different shapes on purpose.
 *
 * ── What React owns, and what it deliberately does not ────────────────
 *
 * React owns every row: the shell, the header, the body, the quote block and
 * the reactions — all of which are DATA on the message, so all of which
 * reconcile. That is the point of the conversion: a reaction toggle used to
 * rebuild one row's `innerHTML`, an edit used to rebuild another's, and a
 * bookmark toggle swapped an icon element in place. All three are store
 * updates now.
 *
 * Two things stay module-filled hosts, per the controller-host seam in
 * AGENTS.md:
 *
 *   * `[data-gc-vote-controls]` — the inline vote buttons on a vote row. Their
 *     markup comes from `AppView.voteState`, which arrives on its own schedule
 *     and is re-filled in place by `refreshVoteControls()` without touching the
 *     transcript. Modelling it here would mean re-rendering every row whenever
 *     any vote changed.
 *   * `[data-gc-spec-share]` — the spec-share card, a whole second renderer.
 *
 * Both are rendered ONCE as empty hosts with constant `className`, so React
 * never writes an attribute the module has since changed. Same rule the dialog
 * islands run under (see ../../lib/legacy-dom.ts).
 */

import { useMemo } from 'react';

import { ChatMessageRow, ThreadReplySummary } from '@/components/ui/chat';
import { Avatar, ReactionPill } from '@/components/ui/feed';

import { useStoreState } from '../../lib/use-store-state';
import { transcriptStore, type TranscriptMessage } from './transcript-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * A stable colour per author, so the same person is the same swatch in every
 * row without the server having to store one. Same idea as `tintFor` for app
 * tiles, and deliberately not the accent ramp: an identity is not a state.
 */
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];
function swatchFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

/**
 * The sanitized markdown the module produced.
 *
 * Memoised on the STRING, so the `{__html}` wrapper keeps its identity across
 * re-renders. React diffs host props by reference and re-assigns `innerHTML`
 * whenever that object is new — even for an identical string — which on a long
 * transcript means every row's body is rewritten on every reaction. The Dev
 * board hit exactly this and its note is in features/dev-board/board-frame.tsx.
 */
function Body({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className="gc-msg-content" dangerouslySetInnerHTML={wrapper} />;
}

function Reactions({ msg }: { msg: TranscriptMessage }) {
  if (!msg.reactions.length) return <div className="gc-reactions" id={`gc-react-${msg.id ?? ''}`} />;
  return (
    <div className="gc-reactions" id={`gc-react-${msg.id ?? ''}`}>
      {msg.reactions.map((r) => (
        <ReactionPill
          key={r.emoji}
          emoji={r.emoji}
          count={r.count}
          className={r.mine ? 'gc-react-mine' : undefined}
          title={r.users.join(', ')}
          data-emoji={r.emoji}
          onClick={() => controller()?.toggleReaction?.(msg.id, r.emoji)}
        />
      ))}
    </div>
  );
}

/** A system or vote row — one line of text, plus whatever the module fills in. */
function SystemRow({ msg }: { msg: TranscriptMessage }) {
  return (
    <div
      className={`gc-msg-system ${msg.kind === 'vote' ? 'gc-msg-vote' : ''}${msg.voteRowClass ? ` ${msg.voteRowClass}` : ''}`}
      data-msg-id={msg.id ?? ''}
    >
      <span className="gc-msg-system-text">{msg.systemText}</span>
      {msg.kind === 'vote' ? <span data-gc-vote-controls={msg.id ?? ''} /> : null}
      <Reactions msg={msg} />
    </div>
  );
}

function MessageRow({ msg }: { msg: TranscriptMessage }) {
  return (
    <ChatMessageRow
      className={`gc-msg ${msg.mine ? 'gc-msg-self' : ''}`}
      data-msg-id={msg.id ?? ''}
      data-username={msg.username}
      avatar={(
        <Avatar shape="square" size="md" color={swatchFor(msg.username)} aria-hidden="true">
          {msg.username.charAt(0).toUpperCase()}
        </Avatar>
      )}
      name={(
        <>
          {msg.unread ? <span className="gc-unread-dot" aria-label="Unread" /> : null}
          <span className={msg.mine ? 'gc-msg-username-self' : undefined}>{msg.username}</span>
        </>
      )}
      timestamp={(
        <>
          <span className="gc-msg-time">{msg.time}</span>
          {msg.editedTitle ? (
            <span className="gc-msg-edited" title={msg.editedTitle}>edited</span>
          ) : null}
        </>
      )}
    >
      {msg.quote ? (
        <ThreadReplySummary
          count={1}
          timestamp={msg.quote.username}
          className="gc-msg-quote"
          onClick={() => controller()?.scrollToMessage?.(msg.quote?.targetId)}
        />
      ) : null}
      <Body html={msg.bodyHtml} />
      {msg.hasAttachments ? <div data-gc-attachments={msg.id ?? ''} /> : null}
      <Reactions msg={msg} />
    </ChatMessageRow>
  );
}

/**
 * `source` names which transcript this host shows — `main` for the general
 * chat, `thread` for the topic sub-view. One component for both: they are the
 * same rows in different containers, and the differences (a "Load earlier"
 * control, an empty/loading line) are data.
 */
export function Transcript({ source = 'main' }: { source?: string }) {
  const state = useStoreState(transcriptStore);
  const view = state.byKey[source];
  if (!state.ready || !view) return null;
  return (
    <>
      {view.lead.earlier ? (
        <div className="text-center py-1">
          <button
            type="button"
            id="gc-thread-earlier"
            className="gc-vote-btn"
            onClick={() => controller()?.loadThreadHistoryForOpen?.()}
          >
            Load earlier
          </button>
        </div>
      ) : null}
      {view.lead.placeholder ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-2">{view.lead.placeholder}</div>
      ) : null}
      {view.messages.map((msg, i) => {
        const key = msg.id != null ? `m${msg.id}` : `i${i}`;
        if (msg.kind === 'spec_share') return <div key={key} data-gc-spec-share={msg.id ?? ''} />;
        if (msg.kind === 'message') return <MessageRow key={key} msg={msg} />;
        return <SystemRow key={key} msg={msg} />;
      })}
    </>
  );
}
