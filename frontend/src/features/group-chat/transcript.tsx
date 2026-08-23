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
 *
 * ── The inline editor is the third, and it is a different shape ───────
 *
 * `GroupChat._startEdit` puts a `.gc-edit` block into a row: it INSERTS a
 * sibling after `.gc-msg-content` and hides that node with an inline
 * `display:none`. It does not write any node React renders — React manages
 * this row's `className` and its body's `dangerouslySetInnerHTML`, neither of
 * which the editor touches, and an unknown sibling plus an inline style are
 * both things the reconciler leaves alone. The row's key is `m<id>`, so the
 * element itself survives every repaint the editor could overlap with.
 *
 * That is why it stays where it is. What did NOT stay is anything that wrote
 * a node React owns: the save button's icon and attributes, and the two
 * `.gc-msg-content.innerHTML` assignments the edit paths used, all of which
 * are store patches now (`_paintBookmark`, `_patchBody` in group-chat.js).
 * The `innerHTML` ones were not merely redundant — `Body` memoises on the
 * string, so React kept believing the old content and repainted the row from
 * it the next time anything else about the message changed.
 */

import { useMemo } from 'react';

import { ChatMessageRow, ThreadReplySummary } from '@/components/ui/chat';
import { Avatar, ReactionPill } from '@/components/ui/feed';
import { BookmarkIcon, BookmarkSolidIcon } from '@/components/ui/icons';

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

/**
 * The row's three header controls: edit, save, react.
 *
 * NO onClick. group-chat.js binds ONE delegated `click` listener to the
 * messages container and dispatches on `closest('.gc-msg-save')` and friends —
 * delegation does not care which renderer made the node, so the module's
 * existing handlers catch these the moment they exist. Wiring them here would
 * be a second handler for the same click.
 *
 * `tabindex={-1}` on edit and react is the legacy behaviour and deliberate:
 * both are hover affordances with a long-press equivalent on touch, and
 * putting them in the tab order would mean two extra stops per message.
 * Save is NOT one of those — it is the row's only keyboard-reachable control
 * and carries `aria-pressed`, which is how its state is announced.
 *
 * These three were dropped when the transcript became React: the store
 * modelled `bookmarked` and `canEdit` and the component rendered neither, so
 * every message in the group chat quietly lost all three. Found by seeding a
 * chat and counting the buttons, not by a test.
 */
function RowActions({ msg }: { msg: TranscriptMessage }) {
  if (!(msg.showEdit || msg.showBookmark || msg.showReact)) return null;
  const saved = msg.bookmarked;
  return (
    <>
      {msg.showEdit ? (
        <button type="button" className="gc-msg-edit" title="Edit" aria-label="Edit message" tabIndex={-1}>
          {'\u270F\uFE0F'}
        </button>
      ) : null}
      {msg.showBookmark ? (
        <button
          type="button"
          className={saved ? 'gc-msg-save gc-msg-saved' : 'gc-msg-save'}
          title={saved ? 'Saved — click to unsave' : 'Save to your notifications'}
          aria-label={saved ? 'Unsave message' : 'Save message'}
          aria-pressed={saved}
        >
          {/* Solid when saved, outline when not — the state lives in the SHAPE,
              which is legible at 12px and in a screenshot. Not one path with
              its fill flipped; see the note in @/components/ui/icons.tsx. */}
          {saved ? <BookmarkSolidIcon /> : <BookmarkIcon strokeWidth="1.5" />}
        </button>
      ) : null}
      {msg.showReact ? (
        <button type="button" className="gc-react-add" title="React" aria-label="Add reaction" tabIndex={-1}>
          {'\u{1F642}'}
        </button>
      ) : null}
    </>
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
      {/*
          A system or vote row is savable and reactable, exactly as the string
          template had it — the same two buttons, in the same place, before the
          reaction pills. Not editable: `showEdit` is false for every row whose
          kind is not `message`, which is how the legacy branch expressed it
          (it simply never called the edit builder here).
      */}
      <RowActions msg={msg} />
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
      actions={<RowActions msg={msg} />}
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
