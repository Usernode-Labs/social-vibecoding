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
 *   - `#gc-thread-bar`: the sheet's header, "Change #N" and its status pill
 *     (the board card's, #5178), the category in plain words, and the ⋯
 *     disc, which holds everything that is not on the page
 *     (`AppView._topicCard`'s rows: the pull request, Share, Explore,
 *     Edit requests, the tags, Shot details, Take the shots again, Details).
 *
 * The root post: who put it up, when and what built it; the title; the
 * summary as a quote folded at four lines (the request page's own fold);
 * the plan it was built from, as the request page's plan card (#4479);
 * one row with the requests it addresses and the thanks; then where it
 * stands, as two cards one above the other, Votes then Testing, each its
 * name and figure over its bar, its button beside them and one line under;
 * then the Before and after card. The view model is
 * `AppView._changeThreadView`; this only draws.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Html } from '../../../lib/html';
import { Diagram, readDiagram } from '../../../lib/diagram/diagram';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { releaseSentence } from '../../../lib/release-eta';
import { useReleaseNow } from '../../../lib/use-release-now';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { ActionButton, StatusPill, TitleContent, VoteButton, isVoteSpec } from '../card/dev-card';
import type { ActionSpec, DevCardModel } from '../card/model';
import type { ChangeGateView, ChangeThreadView, FixChecksView, TopicBody } from './model';
import { useChecksExplanation, useFixAsk, useFixing } from './failed-checks';
import { RequestWords, SpecCard, sentences } from './request-head';
import { TopicBack } from './topic-back';
import { holdVotesInView, onVotesAsked, takeVotesInView } from './votes-in-view';
import { IncludedIn, IssueAssociations, ProposalBody, SummaryMore } from './topic-head';

function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/**
 * The sheet's header: what this is, its status, its category, and everything
 * else behind ⋯. When the change has a technical half (`detailsId`, the same
 * gate the ⋯ Details row uses), the title itself opens the Details sheet
 * (#5329): it looks as it always did, and underlines on hover.
 */
export function ChangeBar({ v, menuKey, detailsId = null }: { v: ChangeThreadView; menuKey: string; detailsId?: number | null }): ReactNode {
  const t = useMessages('project');
  const title = v.number ? t('project:topic.change.bar.titleNumbered', { number: v.number }) : t('project:topic.change.bar.title');
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="messages-thread-name min-w-0">
            {detailsId ? (
              <button
                type="button"
                className="messages-thread-name-link"
                data-change-details-open=""
                onClick={() => (window as any).AppView?.openTechnicalDetails?.(detailsId)}
                aria-label={t('project:topic.change.bar.openDetails', { title })}
                title={t('project:topic.change.bar.openDetailsTitle')}
              >
                {title}
              </button>
            ) : title}
          </div>
          {v.status ? (
            <span className="shrink-0" data-change-status={v.status.key}>
              <StatusPill s={v.status} inline />
            </span>
          ) : null}
        </div>
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
 * The Testing card's Fix it, for the change's author, with the re-run beside
 * it (./failed-checks.ts askFix): the dev chat's own Fix it message, sent to
 * the change's build conversation in the author's name, without leaving the
 * page. A refusal ("still working", no credits) is said under the row.
 */
function FixRow({ fix, rerun }: { fix: FixChecksView; rerun: ReactNode }): ReactNode {
  const t = useMessages('project');
  const { asking, refused, tap } = useFixAsk(fix);
  return (
    <>
      <div className="dev-change-gate-fix">
        <button
          type="button"
          className="gc-vote-btn gc-vote-btn-accent"
          data-change-fix-checks={fix.changeId}
          disabled={asking}
          onClick={tap}
        >
          {asking ? t('project:topic.change.gate.fixAsking') : t('project:topic.change.gate.fix')}
        </button>
        {rerun}
      </div>
      {refused ? <p className="dev-change-gate-refused" role="alert">{refused}</p> : null}
    </>
  );
}

/**
 * One card: its name and figure over its bar, its button beside them, and
 * one line under. A bar still moving is drawn in the lit ink; a finished
 * one is full and green, with a green check and figure (AGENTS.md: a
 * finished progress bar may be green).
 *
 * The Testing card whose checks failed says what went wrong in plain words
 * over that line (`explain`: the model's sentence once read, the failure's
 * own words until then), and offers its author Fix it with the re-run
 * beside it (`fix`, `rerun`). From the tap until the build conversation's
 * turn ends it reads "Fixing", with a door into that conversation.
 */
function GateCard({ which, g, action, rerun = null, id, repeat = false }: {
  which: 'votes' | 'testing'; g: ChangeGateView; action: ReactNode; rerun?: ReactNode; id: number | null; repeat?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const open = () => (window as any).AppView?.openTechnicalDetails?.(id, 'checks');
  const watch = () => (window as any).AppView?.openChangeWorkspace?.(id);
  // A merge of Homeroom itself: when its release comes, counted down here
  // rather than frozen when the page was read.
  const now = useReleaseNow(g.release);
  const release = g.release ? releaseSentence(g.release, now) : null;
  const explanation = useChecksExplanation(g.explain);
  const fixing = useFixing(g.fix);
  const shown: ChangeGateView = fixing ? {
    ...g,
    figure: t('project:topic.change.gate.fixing'),
    tone: 'muted',
    segments: [{ weight: 1, pct: 100, state: 'moving' }],
    label: t('project:topic.change.gate.fixingLabel'),
    note: [t('project:topic.change.gate.fixingNote')],
    explain: null,
    fix: null,
    authorNote: null,
    details: false,
  } : g;
  // What went wrong, over the line: the lead ("One of the app's tests
  // failed.") and the sentence, as one paragraph in the card's own ink.
  const why = shown.explain ? sentences([...shown.note, explanation || shown.explain.fallback]) : '';
  // The note's sentences arrive worded (AppView._changeThreadView); the door
  // into Details rides at the paragraph's end, in one message with them.
  const lines = shown.explain
    ? [shown.authorNote, shown.fix ? t('project:topic.change.gate.fixNote') : null]
    : (release ? [...shown.note, t('project:topic.change.gate.release', { release })] : shown.note);
  const note = sentences(lines);
  const door = <button type="button" className="dev-change-gate-link" onClick={open} />;
  return (
    <div
      className="dev-change-gate"
      // #5725: the repeat at the foot of the page is the same card, but
      // `data-change-gate` stays the ONE card declared checks, votes-in-view
      // and tests find; the repeat carries its own attribute instead.
      data-change-gate={repeat ? undefined : which}
      data-change-gate-repeat={repeat ? which : undefined}
      data-done={shown.done ? 'true' : 'false'}
      data-tone={shown.tone}
      data-change-fixing={fixing ? '' : undefined}
      role="group"
      aria-label={shown.name}
    >
      <div className="dev-change-gate-main">
        <div className="dev-change-gate-head">
          <span className="dev-change-gate-name">
            {shown.done ? <CheckIcon className="dev-change-gate-check" aria-hidden="true" /> : null}
            {shown.name}
          </span>
          <span className="dev-change-gate-figure">{shown.figure}</span>
        </div>
        <div className="dev-change-bar" role="img" aria-label={shown.label}>
          {shown.segments.map((seg, i) => (
            <span key={i} className="dev-change-bar-seg" style={{ flexGrow: seg.weight, flexBasis: 0 }}>
              <span className="dev-change-bar-fill" data-state={seg.state} style={{ width: `${Math.max(0, Math.min(100, seg.pct))}%` }} />
            </span>
          ))}
        </div>
      </div>
      {action ? <div className="dev-change-gate-act">{action}</div> : null}
      {why ? <p className="dev-change-gate-why" data-change-gate-why={explanation ? 'explained' : 'own-words'}>{why}</p> : null}
      {shown.fix ? <FixRow fix={shown.fix} rerun={rerun} /> : null}
      {shown.noteDetail ? (
        <details className="dev-change-gate-note" data-change-gate-explanation="">
          <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500" title={shown.noteDetail}>
            {note}
          </summary>
          <p className="mt-2">{shown.noteDetail}</p>
        </details>
      ) : fixing && id ? (
        <p className="dev-change-gate-note">
          <RichMessage
            id="project:topic.change.gate.noteWatch"
            values={{ note }}
            components={[<button type="button" className="dev-change-gate-link" data-change-fix-watch="" onClick={watch} />]}
          />
        </p>
      ) : note || (shown.details && id) ? (
        <p className="dev-change-gate-note" data-change-release={release ? '' : undefined}>
          {shown.details && id
            ? (note
              ? <RichMessage id="project:topic.change.gate.noteSeeFailed" values={{ note }} components={[door]} />
              : <button type="button" className="dev-change-gate-link" onClick={open}>{t('project:topic.change.gate.seeFailed')}</button>)
            : note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A change whose code did not come across when Homeroom moved off GitHub
 * (`v.codeMissing`, src/services/code-missing.js): its branch is not on the
 * git host, so it cannot be built, tested or merged until it is back. Said
 * once, above Votes and Testing, as the project page says its own "code
 * changes are paused" (../board-frame.tsx CodePauseNotice): the same amber
 * notice. Votes still count, so the cards under it stay as they are.
 */
export function CodeMissingNotice(): ReactNode {
  const t = useMessages('project');
  return (
    <Alert variant="notice" density="compact" className="mt-3" data-change-code-missing="">
      <span>{t('project:topic.change.codeMissing')}</span>
    </Alert>
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
  // With Fix it on the card, the re-run sits beside it, under the line; the
  // card's corner keeps Preview.
  const testingActions = (v.testing.actions || []).map((a) => <ActionButton key={a.key} a={a} />);
  const withFix = !!v.testing.fix;
  const testAction = (preview || openApp || (!withFix && testingActions.length)) ? (
    <>
      {withFix ? null : testingActions}
      {/* A preview that did not start is the card's own words and its retry. */}
      {openApp ? <ActionButton a={openApp} />
        : (preview && !(v.testing.actions || []).some((a) => a.key === 'retry-preview') ? <ActionButton a={preview} /> : null)}
    </>
  ) : null;
  const thanks = v.thanks && id ? <span className="contents" data-kudos-host={id} data-kudos-face="thread"></span> : null;
  const issues = body.issues || [];
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  // Run four (13 Oct 2026): a door that sends someone to vote on this change
  // ("See the change", a vote's notification) opens it at the Votes card,
  // below the header, rather than at its title (./votes-in-view.ts).
  const pair = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let release: (() => void) | null = null;
    const show = () => {
      const card = pair.current?.querySelector<HTMLElement>('[data-change-gate="votes"]');
      if (!card || !takeVotesInView(id)) return;
      release?.();
      release = holdVotesInView(card);
    };
    show();
    const off = onVotesAsked(show);
    return () => { off(); release?.(); };
  }, [id]);
  // #5725: the Votes card repeated in the thread's pin host, at the top of
  // the scroller, so a long page keeps where the vote stands and its button
  // on screen however far down the reader is (evan asked for it to stick as
  // you scroll rather than only sit at the bottom). The pin host is a child
  // of the scroller and `position: sticky` (app.css): the reading area's top
  // edge is its offset, with the scroller's own 4px top padding pulled in so
  // no reply shows in the slit above the card, and the replies scroll under
  // it. Nothing else pins inside this scroller, so nothing is overlapped.
  //
  // It is HIDDEN while the card under the description is on screen, so a
  // page short enough to show both still shows one card. It is in the DOM
  // from the first paint (hidden), so a reader who scrolled before this
  // mounted still gets it.
  //
  // BOTH ends are found from the card itself, never by a document-wide id:
  // the pin host through the scroller that holds the card, and "on screen"
  // through an observer with no root. A second thread — the Workshop's panel,
  // another pane — can hold a host of the same id, and a document-wide
  // `#gc-thread-scroll` can be that thread's box (#4640), which clamps nothing
  // this card is in and so never reports it gone.
  //
  // The observer's root is the viewport (#5725, second run): it applies every
  // clipping ancestor itself, so the card counts as in view only where a
  // reader can see it, whichever box moved it — the thread's own scroller,
  // the page, a restored scroll position on reload, or a reflow of the words
  // above it. A `scroll` listener only hears the scroller it was attached to,
  // and the card stayed hidden when that was not the box that moved.
  const [pin, setPin] = useState<Element | null>(null);
  const [topInView, setTopInView] = useState(true);
  useEffect(() => {
    const card = pair.current?.querySelector<HTMLElement>('[data-change-gate="votes"]');
    const scroller = card ? card.closest<HTMLElement>('#gc-thread-scroll') : null;
    setPin(scroller ? scroller.querySelector('#gc-thread-pin') : null);
    if (!card) { setTopInView(true); return; }
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setTopInView(entry.isIntersecting);
      });
      io.observe(card);
      return () => io.disconnect();
    }
    // No IntersectionObserver: the card's box against its nearest scroller
    // and the window, re-measured on any scroll of the document (capture, so
    // it hears every scroller) and on resize.
    const view = () => {
      const box = card.getBoundingClientRect();
      const clip = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight || 0 };
      const top = Math.max(clip.top, 0);
      const bottom = Math.min(clip.bottom, window.innerHeight || 0);
      return box.height > 0 && box.bottom > top && box.top < bottom;
    };
    let frame = 0;
    const measure = () => { frame = 0; if (card.isConnected) setTopInView(view()); };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(card);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [id]);
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<ChangeBar v={v} menuKey={card.rail?.menuKey || ''} detailsId={id && body.changeId ? id : null} />, bar) : null}
      {pin ? createPortal(
        <div className="dev-change-gate-repeat" hidden={topInView}>
          <GateCard which="votes" g={v.votes} action={voteAction} id={id} repeat />
        </div>,
        pin,
      ) : null}
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
          <ChangeDiagram value={body.diagram} />
          <RequestWords html={body.summaryHtml || ''} />
          {body.summaryMore ? <SummaryMore m={body.summaryMore} /> : null}
          {body.descriptionFold && body.proposalBody
            ? <ProposalBody b={body.proposalBody} named="description" part="description" />
            : null}
          {body.summaryStale && body.summaryHtml
            ? <p className="dev-change-stale" role="note">{t('project:topic.change.summaryStale')}</p>
            : null}
          {body.plan ? (
            <div className="messages-object-list dev-request-specs" data-change-plan={id ?? ''}>
              <SpecCard card={body.plan} />
            </div>
          ) : null}
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
          {v.codeMissing ? <CodeMissingNotice /> : null}
          <div ref={pair} className="dev-change-pair">
            <GateCard which="votes" g={v.votes} action={voteAction} id={id} />
            <GateCard which="testing" g={v.testing} action={testAction} rerun={withFix ? testingActions : null} id={id} />
          </div>
          {v.shots ? <ShotsCard s={v.shots} /> : null}
        </div>
      </article>
    </>
  );
}

/**
 * #4490: the change's diagram, leading its page above the description. A
 * Mermaid diagram that cannot be drawn says so in a muted line, with the
 * author's source one tap down, rather than leaving a hole.
 */
function ChangeDiagram({ value }: { value: unknown }): ReactNode {
  const t = useMessages('project');
  const d = useMemo(() => readDiagram(value), [value]);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [d]);
  if (!d) return null;
  if (failed && d.kind === 'mermaid') {
    return (
      <div className="dev-change-diagram-failed" data-change-diagram-failed="">
        <p>{t('project:topic.change.diagram.failed')}</p>
        <details>
          <summary>{t('project:topic.change.diagram.showSource')}</summary>
          <pre>{d.source}</pre>
        </details>
      </div>
    );
  }
  return <Diagram d={d} source="author" onFail={() => setFailed(true)} className="dev-change-diagram" />;
}
