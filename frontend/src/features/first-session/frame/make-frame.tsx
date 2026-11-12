/**
 * Make and Import in the one frame (version 2 of the screen tour's s42 and
 * s43): the kit's layout holding today's form. The title is the page's
 * head, with Make it (or Import it) as its primary button, the other way
 * to start beside it and the close control at its end; Start from an idea
 * is four cards; the two answers are fields in one card; who can change it
 * stands in the side column. The import form is one narrow column.
 *
 * Presentational. Every value, ref and handler is the make screen's own
 * (../make.tsx `MakeScreen`, ../import-repo.tsx `ImportForm`): the form's
 * state stays there, and so do the ids, the `data-*` names and the fields'
 * own elements, so the keyboard surface, the kept draft, dictation and the
 * request are the standard form's. Nothing is fetched, worded or decided
 * here. Drawn only from Create, under a look, below the frame's bar; the
 * first session's Make keeps the whole screen and its own form.
 *
 * The classes that start `mk-` are this page's own small parts (the
 * sentence with its blank, the line about speed, the microphone's place),
 * dressed in app.css (MAKE AND IMPORT) with the kit's tokens.
 */
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, UIEvent } from 'react';

import { Btn, Frame, Icon, Sec, k } from '@/components/ui/kit';
import { RichMessage, useMessages } from '../../../lib/i18n/react';

/** The screen's root and its scroller, exactly the standard screen's two nodes, around a kit form. */
export function MakeFrameShell({ rootRef, scrollerRef, rootClass, entry, mode, children }: {
  rootRef: RefObject<HTMLDivElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** MAKE_ROOT_UNDER_HEADER: app.css gives it the frame's page area. */
  rootClass: string;
  entry: string;
  mode: 'make' | 'import';
  children?: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      data-make-entry={entry}
      data-make-kit={mode}
      className={rootClass}
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div ref={scrollerRef} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

/** The head both forms share: the title (the dialog's name), an optional sentence, the buttons, the close control. */
function FormHead({ title, purpose, other, submit, onClose, closeLabel }: {
  title: string;
  purpose?: string;
  other: ReactNode;
  submit: ReactNode;
  onClose: (() => void) | null;
  closeLabel: string;
}) {
  return (
    <div className={k('head')}>
      <div className={k('tx')}>
        <h1 id="first-session-make-title" className={k('title')}>{title}</h1>
        {purpose ? <p className={k('purpose')}>{purpose}</p> : null}
      </div>
      <div className={k('acts')}>
        {other}
        {submit}
        {onClose ? (
          <button type="button" className={k('ib')} data-make-close="" onClick={onClose} aria-label={closeLabel}>
            <Icon name="x" size={18} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface MakeIdea {
  /** `data-first-session-example`: the template's key, 'idea', or 'more'. */
  attr: string;
  on: boolean;
  /** The tile's picture: an emoji, the tier chart, or four of what is behind Something else. */
  lead: ReactNode;
  label: string;
  /** The fourth card opens the sheet. */
  popup?: boolean;
  /** A pick from the sheet took the fourth card over: its chevron says it opens again. */
  chevron?: boolean;
  onPick: () => void;
}

/** "What should it do?" as the plain box. */
export interface MakeBriefPlain {
  kind: 'plain';
  boxRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  max: number;
  placeholder: string;
  onChange: (next: string) => void;
  onScroll: (event: UIEvent<HTMLTextAreaElement>) => void;
  /** The box's top edge fades while it is scrolled (the standard box's own class). */
  fade: string;
  /** The line under it while it still holds what they said before: its `data-*` name and words. */
  kept: { attr: 'data-make-waitlist-idea' | 'data-make-search-idea'; text: string } | null;
}

/** "What should it do?" as a picked idea's sentence, with its blank and its choices. */
export interface MakeBriefSentence {
  kind: 'sentence';
  template: string;
  head: string;
  tail: string;
  fill: string;
  /** A game: the rest of the sentence is theirs, in a box under it. */
  finish: boolean;
  /** Your own…: the blank is a field. */
  own: boolean;
  words: string;
  onWords: (next: string) => void;
  fieldRef: RefObject<HTMLInputElement | null>;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  fieldPlaceholder: string;
  areaPlaceholder: string;
  areaMax: number;
  chips: Array<{ key: string; label: string; on: boolean; onPick: () => void }>;
  /** Write it yourself; not offered for a game. */
  onWriteOut: (() => void) | null;
}

export interface MakeFrameProps {
  /** The rise the standard form arrives with (its own classes). */
  motion: string;
  title: string;
  onSubmit: () => void;
  onImport: () => void;
  onClose: (() => void) | null;
  /** Making it… */
  busy: boolean;
  /** Dictating, busy, or at the allowance's limit. */
  off: boolean;
  ideas: MakeIdea[];
  brief: MakeBriefPlain | MakeBriefSentence;
  /** Return in the description goes on to the name. */
  onToName: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** The microphone (../../dictation/speak-button.tsx), with the screen's own handlers. */
  mic: ReactNode;
  /** What a press of Make it found missing in the description, or null. */
  briefNeeded: string | null;
  name: {
    boxRef: RefObject<HTMLInputElement | null>;
    value: string;
    placeholder: string;
    onChange: (next: string) => void;
    needed: string | null;
  };
  /** Instant or custom, and the message that says which. */
  speed: { key: string; id: string } | null;
  /** Who can change it (../../who-decides/make-rule.tsx MakeRuleRows). */
  rule: ReactNode;
  /** The allowance row when it bears on Make it: the product's own block, under the kit's page. */
  allowance: ReactNode;
  error: string | null;
}

/** s42: "What do you want to make?" */
export function MakeFrame(p: MakeFrameProps) {
  const t = useMessages('onboarding');
  const b = p.brief;
  const label = t('onboarding:firstSession.make.briefLabel');
  return (
    <form data-make-kit-form="make" className={`mk-form ${p.motion}`} onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <Frame data-make-frame="make">
        <div className={k('inner')}>
          <FormHead
            title={p.title}
            onClose={p.onClose}
            closeLabel={t('core:common.close')}
            other={<Btn kind="line" className="d" data-make-import-link="" onClick={p.onImport}>{t('onboarding:firstSession.make.importLink')}</Btn>}
            submit={(
              <Btn type="submit" data-make-submit="" disabled={p.off}>
                {p.busy ? t('onboarding:firstSession.make.making') : t('onboarding:firstSession.make.submit')}
              </Btn>
            )}
          />
          <div className={k('cols')}>
            <div className={k('stack')}>
              <Sec label={t('onboarding:firstSession.make.startFromIdea')}>
                <div className={k('grid', 'g2')} role="group" aria-label={t('onboarding:firstSession.make.ideasLabel')}>
                  {p.ideas.map((idea, i) => (
                    <button
                      key={i}
                      type="button"
                      className={k('card', 'press', idea.on && 'on')}
                      aria-pressed={idea.on}
                      aria-haspopup={idea.popup ? 'dialog' : undefined}
                      data-first-session-example={idea.attr}
                      onClick={idea.onPick}
                    >
                      <span className={k('row', 'wrap')}>
                        <span className={k('lead')} aria-hidden="true">{idea.lead}</span>
                        <span className={k('tx')}><span className={k('t')}>{idea.label}</span></span>
                        {idea.chevron ? <Icon name="cd" size={18} className="go" /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </Sec>
              <Sec label={t('onboarding:firstSession.make.frame.yourIdea')}>
                <div className={k('card')} data-make-brief="">
                  <div className={k('fields')}>
                    <div className={k('field')}>
                      {b.kind === 'sentence' ? (
                        <>
                          <div className="mk-lab">
                            <span>{label}</span>
                            {b.onWriteOut ? (
                              <button type="button" className={k('link')} data-make-write-out="" onClick={b.onWriteOut}>
                                {t('onboarding:firstSession.make.writeItYourself')}
                              </button>
                            ) : null}
                          </div>
                          <p data-make-sentence={b.template} className="mk-say">
                            {b.head}
                            {b.finish
                              ? (b.fill ? <span className="mk-blank">{b.fill}</span> : null)
                              : b.own
                                ? (
                                  <input
                                    ref={b.fieldRef}
                                    id="make-words"
                                    type="text"
                                    autoComplete="off"
                                    enterKeyHint="next"
                                    maxLength={60}
                                    value={b.words}
                                    aria-label={t('onboarding:firstSession.make.ownWordsLabel')}
                                    onChange={(e) => b.onWords(e.target.value)}
                                    onKeyDown={p.onToName}
                                    placeholder={b.fieldPlaceholder}
                                    className="mk-blank mk-blank-field"
                                  />
                                )
                                : <span className="mk-blank">{b.fill}</span>}
                            {b.tail}
                          </p>
                          {b.finish ? (
                            <>
                              <label htmlFor="make-words" className="mk-finish">
                                <Icon name="edit" size={15} />
                                {t('onboarding:firstSession.make.finishLabel')}
                              </label>
                              <div className={k('inp', 'area', Boolean(b.words) && 'val')}>
                                <textarea
                                  ref={b.areaRef}
                                  id="make-words"
                                  className={k('v')}
                                  rows={2}
                                  maxLength={b.areaMax}
                                  value={b.words}
                                  enterKeyHint="next"
                                  aria-describedby={p.briefNeeded ? 'first-session-brief-needed' : undefined}
                                  onChange={(e) => b.onWords(e.target.value)}
                                  onKeyDown={p.onToName}
                                  placeholder={b.areaPlaceholder}
                                />
                                <span className="mk-mic">{p.mic}</span>
                              </div>
                            </>
                          ) : null}
                          <div className={k('btnrow', 'chips')} role="group" aria-label={t('onboarding:firstSession.make.choicesLabel')}>
                            {b.chips.map((chip) => (
                              <Btn key={chip.key} small kind={chip.on ? '' : 'quiet'} className="chip" aria-pressed={chip.on} data-make-choice={chip.key} onClick={chip.onPick}>
                                {chip.label}
                              </Btn>
                            ))}
                            {b.finish ? null : <span className="mk-mic mk-mic-row">{p.mic}</span>}
                          </div>
                        </>
                      ) : (
                        <>
                          <label htmlFor="first-session-brief">{label}</label>
                          <div className={k('inp', 'area', Boolean(b.value) && 'val')}>
                            <textarea
                              ref={b.boxRef}
                              id="first-session-brief"
                              className={`${k('v')}${b.fade ? ` ${b.fade}` : ''}`}
                              rows={3}
                              maxLength={b.max}
                              value={b.value}
                              enterKeyHint="next"
                              aria-describedby={p.briefNeeded ? 'first-session-brief-needed' : undefined}
                              onChange={(e) => b.onChange(e.target.value)}
                              onKeyDown={p.onToName}
                              onScroll={b.onScroll}
                              placeholder={b.placeholder}
                            />
                            <span className="mk-mic">{p.mic}</span>
                          </div>
                          {b.kept ? <span className={k('hint')} {...{ [b.kept.attr]: '' }}>{b.kept.text}</span> : null}
                        </>
                      )}
                      {p.briefNeeded ? <span id="first-session-brief-needed" role="alert" className={k('hint', 'bad')}>{p.briefNeeded}</span> : null}
                    </div>
                    <div className={k('field')}>
                      <label htmlFor="first-session-name">{t('onboarding:firstSession.make.nameLabel')}</label>
                      <div className={k('inp', Boolean(p.name.value) && 'val')}>
                        <input
                          ref={p.name.boxRef}
                          id="first-session-name"
                          className={k('v')}
                          type="text"
                          autoComplete="off"
                          enterKeyHint="go"
                          value={p.name.value}
                          aria-describedby={p.name.needed ? 'first-session-name-hint' : undefined}
                          onChange={(e) => p.name.onChange(e.target.value)}
                          placeholder={p.name.placeholder}
                        />
                      </div>
                      {p.name.needed ? <span id="first-session-name-hint" role="alert" className={k('hint', 'bad')}>{p.name.needed}</span> : null}
                    </div>
                  </div>
                </div>
                {p.speed ? (
                  <p data-make-speed={p.speed.key} className="mk-speed">
                    <Icon name={p.speed.key === 'instant' ? 'bolt' : 'spark'} size={16} />
                    <span><RichMessage id={p.speed.id} components={[<b />]} /></span>
                  </p>
                ) : null}
                {p.error ? <p role="alert" className="mk-error">{p.error}</p> : null}
              </Sec>
              {/* A phone's head has no room for the second button: the other way to start is the link under the form, where today's form has it. */}
              <div className={k('foot', 'p')}>
                <button type="button" className={k('link')} data-make-import-link="" onClick={p.onImport}>{t('onboarding:firstSession.make.importLink')}</button>
              </div>
            </div>
            <div className={k('stack')}>
              <Sec label={t('onboarding:firstSession.make.frame.whoCanChange')}>
                {p.rule}
              </Sec>
            </div>
          </div>
        </div>
      </Frame>
      {p.allowance ? <div className="mk-after">{p.allowance}</div> : null}
      {/* Held while it makes, as the standard form is: the press stays in view when the keys go down. */}
      {p.busy ? <div aria-hidden="true" data-make-hold="" className="h-[60vh] shrink-0" /> : null}
    </form>
  );
}

export interface ImportFrameProps {
  motion: string;
  title: string;
  line: string;
  onSubmit: () => void;
  onDescribe: () => void;
  onClose: (() => void) | null;
  /** Importing… */
  busy: boolean;
  /** Busy, or at the allowance's limit. */
  off: boolean;
  url: {
    boxRef: RefObject<HTMLInputElement | null>;
    value: string;
    onChange: (next: string) => void;
    onBlur: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  };
  /** Check, or Re-check once it passed; off while it checks. */
  check: { label: string; off: boolean; onPress: () => void };
  /** The line under the address: what the check said, or who to invite. */
  status: { state: string; tone: 'ok' | 'bad' | undefined; text: string; spinner: ReactNode };
  name: {
    boxRef: RefObject<HTMLInputElement | null>;
    value: string;
    onChange: (next: string) => void;
    needed: string | null;
  };
  /** What the repo's own settings mean for who sees it, once checked. */
  note: string | null;
  allowance: ReactNode;
  error: string | null;
}

/** s43: "Import a GitHub repo". */
export function ImportFrame(p: ImportFrameProps) {
  const t = useMessages('onboarding');
  const describe = t('onboarding:firstSession.import.describeInstead');
  return (
    <form data-make-import="" data-make-kit-form="import" className={`mk-form ${p.motion}`} onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <Frame data-make-frame="import">
        <div className={k('inner', 'narrow')}>
          <FormHead
            title={p.title}
            purpose={p.line}
            onClose={p.onClose}
            closeLabel={t('core:common.close')}
            other={<Btn kind="line" className="d" data-make-describe="" onClick={p.onDescribe}>{describe}</Btn>}
            submit={(
              <Btn type="submit" data-make-import-submit="" disabled={p.off}>
                {p.busy ? t('onboarding:firstSession.import.importing') : t('onboarding:firstSession.import.submit')}
              </Btn>
            )}
          />
          <div className={k('stack')}>
            <Sec label={t('onboarding:firstSession.import.frame.repository')}>
              <div className={k('card')}>
                <div className={k('fields')}>
                  <div className={k('field')}>
                    <label htmlFor="make-import-url">{t('onboarding:firstSession.import.urlLabel')}</label>
                    <div className={k('fieldrow')}>
                      <div className={k('inp', 'code', Boolean(p.url.value) && 'val')}>
                        <Icon name="link" size={18} />
                        <input
                          ref={p.url.boxRef}
                          id="make-import-url"
                          className={k('v')}
                          type="text"
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          enterKeyHint="go"
                          value={p.url.value}
                          aria-describedby="make-import-status"
                          onChange={(e) => p.url.onChange(e.target.value)}
                          onBlur={p.url.onBlur}
                          onKeyDown={p.url.onKeyDown}
                          placeholder={t('onboarding:firstSession.import.urlPlaceholder')}
                        />
                      </div>
                      <Btn small kind="quiet" data-make-import-check="" disabled={p.check.off} onClick={p.check.onPress}>{p.check.label}</Btn>
                    </div>
                    <span id="make-import-status" role="status" data-import-state={p.status.state} className={`${k('hint', p.status.tone)} mk-status`}>
                      {p.status.spinner}
                      {p.status.text}
                    </span>
                  </div>
                  <div className={k('field')}>
                    <label htmlFor="make-import-name">{t('onboarding:firstSession.import.nameLabel')}</label>
                    <div className={k('inp', Boolean(p.name.value) && 'val')}>
                      <input
                        ref={p.name.boxRef}
                        id="make-import-name"
                        className={k('v')}
                        type="text"
                        autoComplete="off"
                        enterKeyHint="go"
                        value={p.name.value}
                        aria-describedby={p.name.needed ? 'make-import-name-hint' : undefined}
                        onChange={(e) => p.name.onChange(e.target.value)}
                        placeholder={t('onboarding:firstSession.import.namePlaceholder')}
                      />
                    </div>
                    {p.name.needed ? <span id="make-import-name-hint" role="alert" className={k('hint', 'bad')}>{p.name.needed}</span> : null}
                  </div>
                </div>
              </div>
              {p.note ? <p data-make-import-note="" className={k('secnote')}>{p.note}</p> : null}
              {p.error ? <p role="alert" className="mk-error">{p.error}</p> : null}
            </Sec>
            <div className={k('foot', 'p')}>
              <button type="button" className={k('link')} data-make-describe="" onClick={p.onDescribe}>{describe}</button>
            </div>
          </div>
        </div>
      </Frame>
      {p.allowance ? <div className="mk-after mk-after-narrow">{p.allowance}</div> : null}
    </form>
  );
}
