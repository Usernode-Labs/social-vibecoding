/**
 * #6248: A REQUEST DRAFT, READ BEFORE IT IS FILED. When Homeroom bot drafts
 * a request for somebody, the card under its reply waits with File it and
 * Not now. That card could not be opened until the request was filed, so the
 * draft could not be read in full: the message clips its details at 1200
 * characters (services/homeroom-bot-mayor.js). The card now opens this pane
 * in the AI tab's own column, beside the chat (../ai/preview.ts), the place
 * a design's preview opens.
 *
 * READ AS A DOCUMENT, AND FILED FROM WHERE IT IS READ (25 Nov 2026). The
 * pane used to hand the details to the chat's renderer and stop: a line 100
 * characters long at the chat's size, no title, and nothing of what the
 * draft carries besides its words. It now opens with the request's whole
 * title, sets the words in a reading column, and lists beside them what a
 * person checks before filing: what the draft leaves undecided, its Done
 * when checks, the requests it overlaps and where it happened (the draft's
 * extras, which File it files with it). In a pane 640px wide or more that
 * list is a second column; narrower, and on a phone, it follows the words
 * (app.css `.request-draft-*`, a container query, because the pane's width
 * follows the thread beside it and not the window).
 *
 * The foot says where the request will go and holds File it and Not now:
 * the same tap the card's buttons make (api.decideBotAction), decided once
 * on the server, which settles the card on every device. The pane then
 * closes. The card keeps its buttons; a draft decided there and pressed
 * here says so under the buttons, as the card does (OfferRefused).
 *
 * The whole draft is read from the saved row (GET
 * /api/conversations/homeroom-bot/actions/:actionId/draft). Until it comes,
 * and when it cannot be read, the message's own copy is shown: its title,
 * project and clipped details. Nothing loads in the first render, so the
 * server's markup and the first client render agree.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { SectionHeader } from '@/components/ui/grouped-list';
import { ChevronLeftIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useDetailCard, useDetailLabel } from '../detail/detail-card';
import * as api from './api';
import { OfferRefused, refusalOf, type OfferRefusal } from './bot-question';
import { MessageMarkdown } from './format';

const ICON = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800';
/** The label over a panel of the list beside the words: the shell's small caps, without a list's own gutter. */
const PANEL_LABEL = 'px-0.5 pb-2 pt-0';

/** How a draft says an open request relates to it, by the server's word for it. */
const RELATION: Record<NonNullable<api.DraftRelated['relation']>, string> = {
  same: 'messages:draft.pane.relation.same',
  part_of: 'messages:draft.pane.relation.partOf',
  depends_on: 'messages:draft.pane.relation.dependsOn',
  build_together: 'messages:draft.pane.relation.buildTogether',
};

/** What the message itself says about the draft, shown until the saved row is read. */
export interface DraftCopy {
  title: string;
  project: string;
  details: string;
  appSlug: string | null;
}

/** Pure: whether a draft carries anything to list beside its words. */
export function draftHasExtras(extras: api.RequestDraftExtras | null | undefined): boolean {
  return !!extras && (extras.undecided.length > 0 || extras.doneWhen.length > 0 || extras.related.length > 0
    || !!extras.where.request || !!extras.where.saw);
}

/** One panel of the list beside the words: its label, then its lines in a quiet card. */
function Panel({ kind, label, children }: { kind: string; label: string; children: ReactNode }): ReactNode {
  return (
    <div className="request-draft-panel" data-draft-panel={kind}>
      <SectionHeader className={PANEL_LABEL}>{label}</SectionHeader>
      <ul>{children}</ul>
    </div>
  );
}

export function RequestDraftPane({ actionId, copy, seq = 0, onClose, closeAs = 'close' }: {
  actionId: number;
  copy: DraftCopy;
  /** Each open's count, so opening the same draft again reads it again. */
  seq?: number;
  /** The tab's own column: this closes the preview. */
  onClose?: () => void;
  /** × beside the chat; a back arrow to it where the pane is the whole screen. */
  closeAs?: 'close' | 'back';
}): ReactNode {
  const t = useMessages('messages');
  const [draft, setDraft] = useState<api.RequestDraft | null>(null);
  // A press being decided ('yes' is File it), and what the server said when it refused one.
  const [pressed, setPressed] = useState<'yes' | 'no' | null>(null);
  const [refused, setRefused] = useState<OfferRefusal | null>(null);

  useEffect(() => {
    let live = true;
    setDraft(null);
    setPressed(null);
    setRefused(null);
    api.readRequestDraft(actionId).then((read) => { if (live) setDraft(read); }, () => { /* the message's copy stays */ });
    return () => { live = false; };
  }, [actionId, seq]);

  const title = draft?.title || copy.title;
  const project = draft?.app.name || copy.project;
  // The saved row's whole description; the message's clipped one until it comes.
  const details = draft?.details || copy.details;
  const appSlug = draft?.app.slug || copy.appSlug;
  const extras = draft?.extras ?? null;
  const rail = draftHasExtras(extras);
  // Beside a thread on the bot tab (20 Nov 2026): the head card says it (../detail/detail-card.tsx).
  const card = useDetailCard();
  useDetailLabel({ title, line: t('messages:draft.pane.sub', { project }) });

  // The card's own tap, decided once on the server; the message's new state
  // reaches every device, and this pane has nothing left to show.
  function decide(choice: 'yes' | 'no') {
    if (pressed) return;
    setPressed(choice);
    setRefused(null);
    api.decideBotAction(actionId, choice).then(() => { onClose?.(); }, (error: unknown) => {
      setPressed(null);
      setRefused(refusalOf(error));
    });
  }

  return (
    <section className="messages-design-pane" data-request-draft-pane={actionId} aria-label={t('messages:draft.pane.label')}>
      {card ? null : (
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        {onClose && closeAs === 'back' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:draft.pane.back')} title={t('messages:draft.pane.back')} data-draft-close="back">
            <ChevronLeftIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-[12rem] flex-1 truncate text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:draft.pane.sub', { project })}</div>
        {onClose && closeAs === 'close' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:draft.pane.close')} title={t('messages:draft.pane.close')} data-draft-close="close">
            <XIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      )}
      <div className="request-draft-scroll">
        <div className="request-draft-grid" data-draft-rail={rail ? '' : undefined}>
          <div className="request-draft-main">
            <h2 className="request-draft-title" data-draft-title="">{title}</h2>
            {details ? (
              <div className="request-draft-words">
                <MessageMarkdown content={details} appSlug={appSlug} />
              </div>
            ) : null}
          </div>
          {rail && extras ? (
            <div className="request-draft-rail" data-draft-extras="">
              {extras.undecided.length ? (
                <Panel kind="undecided" label={t('messages:draft.pane.undecided')}>
                  {extras.undecided.map((line, index) => <li key={index}>{line}</li>)}
                </Panel>
              ) : null}
              {extras.doneWhen.length ? (
                <Panel kind="doneWhen" label={t('messages:draft.pane.doneWhen')}>
                  {extras.doneWhen.map((line, index) => <li key={index}>{line}</li>)}
                </Panel>
              ) : null}
              {extras.related.length ? (
                <Panel kind="related" label={t('messages:draft.pane.related')}>
                  {extras.related.map((r) => (
                    <li key={r.number}>
                      {/* The chat's own chip for the number: it opens that request. */}
                      <MessageMarkdown content={`#${r.number} ${r.title}`} appSlug={appSlug} />
                      {r.relation ? <small>{t(RELATION[r.relation])}</small> : null}
                      {r.why ? <small>{r.why}</small> : null}
                    </li>
                  ))}
                </Panel>
              ) : null}
              {extras.where.request || extras.where.saw ? (
                <Panel kind="where" label={t('messages:draft.pane.where')}>
                  {extras.where.request ? (
                    <li>{t('messages:draft.pane.whereRequest', { number: extras.where.request.number, project: extras.where.request.name })}</li>
                  ) : null}
                  {extras.where.saw ? <li>{extras.where.saw}</li> : null}
                </Panel>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="request-draft-bar" data-draft-bar="">
        <p className="request-draft-goes">
          <RichMessage id="messages:draft.pane.goesOn" values={{ project }} components={[<b />]} />
        </p>
        <div className="messages-bot-answers" role="group" aria-label={t('messages:draft.pane.question', { project })}>
          <button type="button" className="messages-bot-secondary" disabled={!!pressed} onClick={() => decide('no')} data-draft-action="not-now">
            <span>{t('messages:draft.pane.notNow')}</span>
          </button>
          <button type="button" className="messages-bot-primary" disabled={!!pressed} onClick={() => decide('yes')} data-draft-action="file">
            <span>{t('messages:draft.pane.file')}</span>
          </button>
        </div>
        <OfferRefused refusal={refused} />
      </div>
    </section>
  );
}
