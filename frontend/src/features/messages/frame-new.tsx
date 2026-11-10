/**
 * New message in the one frame, as the 2026-11-06 screen tour draws it (its
 * step s16): the standard sheet over the inbox, with one field and the
 * people as rows. A picked person's row is lit and their name is in the
 * field; the button names what happens.
 *
 * One person is a direct message. More make a group, named after the people
 * in it, as groups made by hand usually are ("Evan / Lukas / Salah"); its
 * owner renames it from the group's own menu. The standard dialog
 * (./create-dialog.tsx) asks for the name and a note first; it stays the
 * way in under the standard look.
 *
 * Blocked people are managed from the sheet's foot: the dialog was the one
 * place that listed them, and a look must not take that away.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { Av, Btn, Card, Field, Fields, GroupLink, Lead, Note, Row, Sec, Sheet } from '@/components/ui/kit';
import { startAgentSession } from '../agent-session/store';
import { useMessages } from '../../lib/i18n/react';
import * as api from './api';
import { swatchFor } from './format';
import { createDirect, createGroup, setUserBlocked } from './store';
import type { ConversationUser } from './types';

/** A group's name from the people in it, within the 80 characters a name may have. */
export function groupTitle(me: string, picked: Pick<ConversationUser, 'username'>[]): string {
  const title = [me, ...picked.map((user) => user.username)].filter(Boolean).join(' / ');
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

const face = (user: ConversationUser) => <Av size={40} name={user.username || '?'} src={user.avatarUrl} color={swatchFor(user.username || '?')} />;

export function NewMessageSheetView({
  query, onQuery, picked, people, searching, onToggle, onUnpick, busy, error, onStart, onClose, blocked, onBlocked, onUnblock, onAgent = null,
}: {
  query: string;
  onQuery: (next: string) => void;
  picked: ConversationUser[];
  /** The rows under the field: the people already talked to, or those found for what was typed. */
  people: ConversationUser[];
  searching: boolean;
  onToggle: (user: ConversationUser) => void;
  /** Backspace in an empty field takes the last picked person out. */
  onUnpick: () => void;
  busy: boolean;
  error: string;
  onStart: () => void;
  onClose: () => void;
  /** The blocked list once asked for; null until then. */
  blocked: ConversationUser[] | null;
  onBlocked: () => void;
  /** Agent chat, the other kind the standard dialog offers: plan and build a change with a coding agent. Null while a person is being picked. */
  onAgent?: (() => void) | null;
  onUnblock: (user: ConversationUser) => void;
}) {
  const t = useMessages('messages');
  const tc = useMessages('core');
  const typed = query.trim();
  const isPicked = (user: ConversationUser) => picked.some((item) => item.id === user.id);
  // Whoever is picked stays in sight, ahead of the rest.
  const others = people.filter((user) => !isPicked(user));
  const rows = [...picked, ...others];
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !query && picked.length) onUnpick();
    if (event.key === 'Enter' && picked.length && !busy) onStart();
  };
  return (
    <Sheet
      title={t('messages:frame.new.title')}
      purpose={t('messages:frame.new.purpose')}
      onClose={onClose}
      closeLabel={tc('core:common.close')}
      primary={<Btn block icon="chat" disabled={busy || !picked.length} onClick={onStart}>{t('messages:frame.new.start')}</Btn>}
      foot={blocked ? null : <GroupLink onClick={onBlocked}>{t('messages:frame.new.blocked')}</GroupLink>}
    >
      <Fields>
        <Field
          label={t('messages:frame.new.to')}
          icon="search"
          before={picked.length ? <span>{picked.map((user) => user.username).join(', ')}</span> : null}
          type="text"
          autoComplete="off"
          placeholder={picked.length ? '' : t('messages:frame.new.placeholder')}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
      </Fields>
      {error ? <Note tone="bad">{error}</Note> : null}
      {rows.length ? (
        <Sec label={typed ? t('messages:frame.new.found') : t('messages:frame.new.talkTo')}>
          <Card>
            {rows.map((user) => (
              <Row key={user.id} sm lead={face(user)} title={user.username} on={isPicked(user)} pressed={isPicked(user)} onClick={() => onToggle(user)} />
            ))}
          </Card>
        </Sec>
      ) : null}
      {typed && !others.length ? <Card pad>{searching ? t('messages:frame.new.searching') : t('messages:frame.new.none')}</Card> : null}
      {onAgent && !typed && !picked.length && !blocked ? (
        <Sec label={t('messages:frame.new.orElse')}>
          <Card>
            <Row lead={<Lead icon="spark" />} title={t('messages:inbox.new.agent.label')} line={t('messages:inbox.new.agent.hint')} go onClick={onAgent} />
          </Card>
        </Sec>
      ) : null}
      {blocked ? (
        <Sec label={t('messages:frame.new.blocked')}>
          {blocked.length ? (
            <Card>
              {blocked.map((user) => (
                <Row key={user.id} sm lead={face(user)} title={user.username} right={<Btn kind="quiet" small onClick={() => onUnblock(user)}>{t('messages:frame.new.unblock')}</Btn>} />
              ))}
            </Card>
          ) : <Card pad>{t('messages:frame.new.nobodyBlocked')}</Card>}
        </Sec>
      ) : null}
    </Sheet>
  );
}

/** The sheet with its state: who is picked, what was typed and found, and the start. */
export function NewMessageSheet({ known, onClose }: {
  /** The people the viewer already has a direct message with, most recent first. */
  known: ConversationUser[];
  onClose: () => void;
}) {
  const t = useMessages('messages');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ConversationUser[]>([]);
  const [found, setFound] = useState<ConversationUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<ConversationUser[] | null>(null);
  const typed = query.trim();
  useEffect(() => {
    if (!typed) { setFound([]); setSearching(false); return undefined; }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try { const users = await api.searchUsers(typed); if (alive) setFound(users); }
      catch { if (alive) setFound([]); }
      finally { if (alive) setSearching(false); }
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [typed]);
  const people = useMemo(() => (typed ? found : known), [typed, found, known]);
  const toggle = (user: ConversationUser) => {
    setError('');
    setPicked((now) => (now.some((item) => item.id === user.id) ? now.filter((item) => item.id !== user.id) : [...now, user].slice(0, 99)));
    setQuery('');
  };
  async function start() {
    if (!picked.length || busy) return;
    setBusy(true); setError('');
    try {
      const me = String(window.App?.user?.username || '');
      picked.length === 1
        ? await createDirect(picked[0].id)
        : await createGroup(groupTitle(me, picked), picked.map((user) => user.id));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : (picked.length === 1 ? t('messages:create.error.direct') : t('messages:create.error.group')));
    } finally { setBusy(false); }
  }
  async function showBlocked() {
    try { setBlocked(await api.listBlocks()); } catch { setBlocked([]); }
  }
  async function unblock(user: ConversationUser) {
    try {
      await setUserBlocked(user.id, false);
      setBlocked((now) => (now || []).filter((item) => item.id !== user.id));
    } catch (err) { setError(err instanceof Error ? err.message : t('messages:create.error.unblock')); }
  }
  return (
    <NewMessageSheetView
      query={query}
      onQuery={setQuery}
      picked={picked}
      people={people}
      searching={searching}
      onToggle={toggle}
      onUnpick={() => setPicked((now) => now.slice(0, -1))}
      busy={busy}
      error={error}
      onStart={() => void start()}
      onClose={onClose}
      blocked={blocked}
      onBlocked={() => void showBlocked()}
      onAgent={() => { onClose(); void startAgentSession({ entry: 'messages' }); }}
      onUnblock={(user) => void unblock(user)}
    />
  );
}
