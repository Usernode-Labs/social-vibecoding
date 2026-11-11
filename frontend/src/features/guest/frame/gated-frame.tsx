/**
 * A members' page opened by a visitor, in the one frame, as the 2026-11-06
 * screen tour draws it (its steps o12 to o15, `gated()` in the tour's
 * screens/out.mjs): the address has its own page saying what lives there,
 * in place of the landing under a sheet. Sign in is the page's one primary
 * button; a second group lists what is open without an account, so the
 * page is not a dead end; beside them, the way in for somebody new.
 *
 * The landing (../../auth/landing.tsx) draws it for the same links the
 * standard look answers with its sign-in sheet over a blurred stand-in
 * (../../auth/deep-link-sign-in.tsx). The sheet is still how a visitor
 * signs in, and signing in still lands on the link: under a look it opens
 * from this page's button, not by itself.
 *
 * Messages, Homeroom bot and You say what lives there in three rows. Any
 * other members' address (a private project, Settings, notifications)
 * keeps the product's own words for it as the title and claims nothing
 * about a page the visitor cannot see.
 */
import { Btn, Card, Lead, PageBody, Row, Sec } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';

export type GatedKind = 'messages' | 'bot' | 'you' | 'page';

const KIND_FOR_HEAD: Readonly<Record<string, GatedKind>> = Object.freeze({
  messages: 'messages',
  chat: 'messages',
  'homeroom-bot': 'bot',
  ai: 'bot',
  profile: 'you',
  me: 'you',
});

/** Which page a remembered address is for: its first segment, as the router reads it. */
export function gatedKind(target: string): GatedKind {
  const raw = String(target || '');
  const head = raw.startsWith('#') ? raw.slice(1).split(/[/?]/)[0] : '';
  return Object.prototype.hasOwnProperty.call(KIND_FOR_HEAD, head) ? KIND_FOR_HEAD[head] : 'page';
}

export function GatedFrame({ target, title, waitlist, onSignIn, onStart, onBrowse }: {
  /** The address the visitor asked for (a fragment, or an app path). */
  target: string;
  /** The product's own words for that place (deepLinkTitle), the title of a page with no rows of its own. */
  title: string;
  /** New accounts wait in line: the second button says so. */
  waitlist: boolean;
  onSignIn: () => void;
  /** The landing's own way in for somebody new (its start sheet). */
  onStart: () => void;
  /** Leave for the landing, where everything public is. */
  onBrowse: () => void;
}) {
  const t = useMessages('auth');
  const tc = useMessages('core');
  const kind = gatedKind(target);
  const join = waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.hero.signUp');

  const lives = kind === 'messages' ? [
    { icon: 'chat', title: t('auth:frame.gated.messages.direct'), line: t('auth:frame.gated.messages.directLine') },
    { icon: 'users', title: t('auth:frame.gated.messages.groups'), line: t('auth:frame.gated.messages.groupsLine') },
    { icon: 'at', title: t('auth:frame.gated.messages.mentions'), line: t('auth:frame.gated.messages.mentionsLine') },
  ] : kind === 'bot' ? [
    { icon: 'spark', title: t('auth:frame.gated.bot.ask'), line: t('auth:frame.gated.bot.askLine') },
    { icon: 'tool', title: t('auth:frame.gated.bot.build'), line: t('auth:frame.gated.bot.buildLine') },
    { icon: 'vote', title: t('auth:frame.gated.bot.needs'), line: t('auth:frame.gated.bot.needsLine') },
  ] : kind === 'you' ? [
    { icon: 'tool', title: t('auth:frame.gated.you.changes'), line: t('auth:frame.gated.you.changesLine') },
    { icon: 'chat', title: t('auth:frame.gated.you.requests'), line: t('auth:frame.gated.you.requestsLine') },
    { icon: 'trophy', title: t('auth:frame.gated.you.challenges'), line: t('auth:frame.gated.you.challengesLine') },
  ] : [];
  const head = kind === 'messages' ? { title: tc('core:tabs.messages'), purpose: t('auth:frame.gated.messages.purpose') }
    : kind === 'bot' ? { title: tc('core:tabs.ai'), purpose: t('auth:frame.gated.bot.purpose') }
      : kind === 'you' ? { title: tc('core:tabs.me'), purpose: t('auth:frame.gated.you.purpose') }
        : { title, purpose: t('auth:frame.gated.purpose') };

  return (
    <PageBody
      data-gated-frame={kind}
      title={head.title}
      purpose={head.purpose}
      acts={(
        <>
          <Btn kind="line" onClick={onStart}>{join}</Btn>
          <Btn icon="door" data-gated-sign-in="" onClick={onSignIn}>{t('auth:guest.header.signIn')}</Btn>
        </>
      )}
      side={(
        <Sec label={t('auth:frame.gated.newHere')}>
          <Card>
            <Row lead={<Lead icon="clock" />} title={join} line={waitlist ? t('auth:frame.gated.waitLine') : undefined} onClick={onStart} go />
          </Card>
        </Sec>
      )}
    >
      {lives.length ? (
        <Sec label={t('auth:frame.gated.lives')}>
          <Card>
            {lives.map((row) => <Row key={row.icon + row.title} lead={<Lead icon={row.icon} />} title={row.title} line={row.line} />)}
          </Card>
        </Sec>
      ) : null}
      <Sec label={t('auth:frame.gated.open')}>
        <Card>
          <Row lead={<Lead icon="grid" />} title={t('auth:frame.gated.browse')} line={t('auth:frame.gated.browseLine')} onClick={onBrowse} go />
        </Card>
      </Sec>
    </PageBody>
  );
}
