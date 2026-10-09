/**
 * #4455 — a change's page, drawn as the thread Messages opens beside a
 * message, as a request's page is (./request-head.tsx, #4453): the change is
 * the root post, and its replies and everything that happened to it follow
 * in `#gc-thread-messages` (../../group-chat/transcript.tsx `ChangeRows`).
 *
 * This is the head, rendered by `ChangeDetail` (./topic-head.tsx, which keeps
 * the page's own read of its row) into `#gc-thread-head`, the top of the
 * thread shell's scroller. Two pieces portal into the shell's other hosts
 * (../../group-chat/thread-shell.tsx `RequestShell`, in its change layout):
 *
 *   - `#gc-thread-back`: the "‹ Workshop" chip, above the sheet;
 *   - `#gc-thread-bar`: the sheet's header, "Change #N", the category in
 *     plain words, and the ⋯ disc, which holds everything that is not on the
 *     page (`AppView._topicCard`'s rows: the pull request, Share, Explore,
 *     Edit requests, the tags, Shot details, Take the shots again, Details).
 *
 * The root post: who put it up, when and what built it; the title; the
 * summary as a quote folded at four lines (the request page's own fold);
 * one row with the requests it addresses and the thanks; then where it
 * stands, as two cards one above the other, Votes then Testing, each its
 * name and figure over its bar, its button beside them and one line under;
 * then the Before and after card. The view model is
 * `AppView._changeThreadView`; this only draws.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Html } from '../../../lib/html';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { ActionButton, TitleContent, VoteButton, isVoteSpec } from '../card/dev-card';
import type { ActionSpec, DevCardModel } from '../card/model';
import type { ChangeGateView, ChangeThreadView, TopicBody } from './model';
import { RequestWords, sentences } from './request-head';
import { TopicBack } from './topic-back';
import { IncludedIn, IssueAssociations, SummaryMore } from './topic-head';

function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/** The sheet's header: what this is, its category, and everything else behind ⋯. */
function ChangeBar({ v, menuKey }: { v: ChangeThreadView; menuKey: string }): ReactNode {
  const t = useMessages('project');
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        <div className="messages-thread-name">{v.number ? t('project:topic.change.bar.titleNumbered', { number: v.number }) : t('project:topic.change.bar.title')}</div>
        {v.category ? <div className="messages-thread-sub" data-change-category="">{v.category}</div> : null}
      </div>
      {menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={menuKey}
          aria-haspopup="true"
          aria-label={t('project:topic.change.bar.more')}
          title={t('project:topic.change.bar.more')}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

/**
 * One card: its name and figure over its bar, its button beside them, and
 * one line under. A bar still moving is drawn in the lit ink; a finished
 * one is full and green, with a green check and figure (AGENTS.md: a
 * finished progress bar may be green).
 */
function GateCard({ which, g, action, id }: { which: 'votes' | 'testing'; g: ChangeGateView; action: ReactNode; id: number | null }): ReactNode {
  const t = useMessages('project');
  const open = () => (window as any).AppView?.openTechnicalDetails?.(id, 'checks');
  // The note's sentences arrive worded (AppView._changeThreadView); the door
  // into Details rides at the paragraph's end, in one message with them.
  const note = sentences(g.note);
  const door = <button type="button" className="dev-change-gate-link" onClick={open} />;
  return (
    <div className="dev-change-gate" data-change-gate={which} data-done={g.done ? 'true' : 'false'} data-tone={g.tone} role="group" aria-label={g.name}>
      <div className="dev-change-gate-main">
        <div className="dev-change-gate-head">
          <span className="dev-change-gate-name">
            {g.done ? <CheckIcon className="dev-change-gate-check" aria-hidden="true" /> : null}
            {g.name}
          </span>
          <span className="dev-change-gate-figure">{g.figure}</span>
        </div>
        <div className="dev-change-bar" role="img" aria-label={g.label}>
          {g.segments.map((seg, i) => (
            <span key={i} className="dev-change-bar-seg" style={{ flexGrow: seg.weight, flexBasis: 0 }}>
              <span className="dev-change-bar-fill" data-state={seg.state} style={{ width: `${Math.max(0, Math.min(100, seg.pct))}%` }} />
            </span>
          ))}
        </div>
      </div>
      {action ? <div className="dev-change-gate-act">{action}</div> : null}
      {g.note.length || (g.details && id) ? (
        <p className="dev-change-gate-note">
          {g.details && id
            ? (note
              ? <RichMessage id="project:topic.change.gate.noteSeeFailed" values={{ note }} components={[door]} />
              : <button type="button" className="dev-change-gate-link" onClick={open}>{t('project:topic.change.gate.seeFailed')}</button>)
            : note}
        </p>
      ) : null}
    </div>
  );
}

/** The Before and after card: the shots, or the line that says where they are. */
function ShotsCard({ s }: { s: NonNullable<ChangeThreadView['shots']> }): ReactNode {
  const t = useMessages('project');
  if (s.state === 'verified') {
    return (
      <section className="dev-change-shots" data-change-shots="verified">
        {/* AppView.shotsHtml's `thread` reading — escaped where it is built. */}
        <Html className="dev-change-shots-html" html={s.html} />
      </section>
    );
  }
  return (
    <section className="dev-change-shots dev-change-shots-plain" data-change-shots={s.state} aria-label={t('project:topic.change.shots.title')}>
      <div className="dev-change-card-name">{t('project:topic.change.shots.title')}</div>
      {s.html ? <Html className="dev-change-shots-tiles usn-visuals-body" data-visuals-scope="1" html={s.html} /> : null}
      {s.line ? (
        <p className="dev-change-shots-line">
          {s.waiting ? <span className="dc-status-spinner-arc" aria-hidden="true"></span> : null}
          <span>{s.line}</span>
        </p>
      ) : null}
    </section>
  );
}

export function ChangeThreadHead({ id, card, body, v, linkedIssues, onIssuesSaved }: {
  id: number | null;
  card: DevCardModel;
  body: TopicBody;
  v: ChangeThreadView;
  linkedIssues: number[];
  onIssuesSaved: (issues: number[]) => void;
}): ReactNode {
  const t = useMessages('project');
  const images = useInlineImageViewer();
  const all: ActionSpec[] = card.actions || [];
  const yes = all.find((a) => isVoteSpec(a, 'yes'));
  const no = all.find((a) => isVoteSpec(a, 'no'));
  const submit = all.find((a) => a.key === 'propose-change');
  const preview = all.find((a) => a.preview);
  const openApp = all.find((a) => a.key === 'open-app');
  const voteAction = yes && no ? <VoteButton yes={yes} no={no} /> : (submit ? <ActionButton a={submit} /> : null);
  const testAction = (preview || openApp || (v.testing.actions || []).length) ? (
    <>
      {(v.testing.actions || []).map((a) => <ActionButton key={a.key} a={a} />)}
      {/* A preview that did not start is the card's own words and its retry. */}
      {openApp ? <ActionButton a={openApp} />
        : (preview && !(v.testing.actions || []).some((a) => a.key === 'retry-preview') ? <ActionButton a={preview} /> : null)}
    </>
  ) : null;
  const thanks = v.thanks && id ? <span className="contents" data-kudos-host={id} data-kudos-face="thread"></span> : null;
  const issues = body.issues || [];
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<ChangeBar v={v} menuKey={card.rail?.menuKey || ''} />, bar) : null}
      {images.viewer}
      <article className="messages-message dev-request-root dev-change-root" data-change-root={id ?? ''}>
        <Avatar shape="square" size="sm" color={swatchFor(v.author)} aria-hidden="true">
          {(v.author || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1" {...images.scope}>
          <div className="messages-message-head">
            <span className="messages-message-author">{v.author}</span>
            {v.time ? <time dateTime={v.at || undefined} title={v.timeTitle}>{v.time}</time> : null}
            {v.via ? <span className="dev-change-via">{`· ${v.via}`}</span> : null}
          </div>
          <h1 className="dev-request-title" data-change-title={id ?? ''}>
            <TitleContent t={card.title} />
          </h1>
          <RequestWords html={body.summaryHtml || ''} />
          {body.summaryMore ? <SummaryMore m={body.summaryMore} /> : null}
          {body.summaryStale && body.summaryHtml
            ? <p className="dev-change-stale" role="note">{t('project:topic.change.summaryStale')}</p>
            : null}
          {body.includedIn ? <IncludedIn r={body.includedIn} /> : null}
          {id && (issues.length || body.canEditIssues || thanks) ? (
            <IssueAssociations
              proposalId={id}
              issues={issues}
              issueOptions={body.issueOptions || []}
              linkedIssues={linkedIssues}
              editable={body.canEditIssues === true}
              onSaved={onIssuesSaved}
              thread={{ thanks }}
            />
          ) : null}
          {body.note ? <p className="dev-change-stale">{body.note}</p> : null}
          <div className="dev-change-pair">
            <GateCard which="votes" g={v.votes} action={voteAction} id={id} />
            <GateCard which="testing" g={v.testing} action={testAction} id={id} />
          </div>
          {v.shots ? <ShotsCard s={v.shots} /> : null}
        </div>
      </article>
    </>
  );
}
