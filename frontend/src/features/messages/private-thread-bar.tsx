/**
 * #6019 (stage 5): the head of a private thread, one the viewer started in
 * their chat with Homeroom bot (the AI tab). Everything in it is theirs
 * alone until they press one of two doors:
 *
 *   Only you can see this thread.          [File it] [Post it]
 *
 * File it files its words as a request on a project they pick; Post it posts
 * them in an existing thread, by its number, as their own message
 * (routes/conversations.js, services/private-threads.js). Either opens a
 * small form with the words to go public, which they can change first. Once
 * one has been done the head says where the thread went.
 *
 * An idea for no project yet has a third door (#6019 follow-up, plan v3:
 * "an idea with no community yet: Who is it for? starts a new project"):
 * New project asks who it is for (Just me, A group, A community) and opens
 * Create with the thread's words as the idea and that audience
 * (App.showCreateModal, first-session's make screen).
 *
 * The first render is nothing: where the thread stands is read in an effect.
 */

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { communityScopeStore, warmCommunities } from '../workshop/community-scope';

export interface PrivateThreadState {
  state: 'open' | 'filed' | 'posted' | 'dropped';
  number?: number | null;
  app?: { slug: string; name: string } | null;
  href?: string | null;
}

type Door = 'file' | 'post' | 'new';
type Audience = 'solo' | 'invited' | 'open';

/** The projects to pick from: the communities the viewer is in, in the switcher's order. Pure. */
export function projectChoices(scope: { list: string[] | null; info: Record<string, { name?: string }> }): Array<{ slug: string; name: string }> {
  return (scope.list || []).map((slug) => ({ slug, name: scope.info[slug]?.name || slug }));
}

export function PrivateThreadBar({ rootId, text }: { rootId: number; text: string }): ReactNode {
  const t = useMessages('messages');
  const scope = useStoreState(communityScopeStore);
  const [where, setWhere] = useState<PrivateThreadState | null>(null);
  const [door, setDoor] = useState<Door | null>(null);
  const [project, setProject] = useState('');
  const [title, setTitle] = useState('');
  const [number, setNumber] = useState('');
  const [words, setWords] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWhere(null);
    setDoor(null);
    let live = true;
    fetch(`/api/conversations/homeroom-bot/threads/${rootId}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data && typeof data.state === 'string') setWhere(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [rootId]);
  // The projects to pick from are read once a door is opened.
  useEffect(() => (door && door !== 'new' ? warmCommunities(0) : undefined), [door]);

  if (!where) return null;
  if (where.state === 'filed' || where.state === 'posted') {
    const id = where.state === 'filed' ? 'messages:privateThread.filed' : 'messages:privateThread.posted';
    return (
      <div className="messages-bot-note px-4 py-2" data-private-thread={where.state}>
        {t(id, { number: where.number ?? '', project: where.app?.name || '' })}
        {where.href ? <>{' · '}<a href={where.href}>{t('messages:privateThread.open')}</a></> : null}
      </div>
    );
  }

  const choices = projectChoices(scope);
  const startProject = (audience: Audience) => {
    const app = typeof window !== 'undefined' ? (window as any).App : null;
    app?.showCreateModal?.({ idea: text, audience });
  };
  const opening = (next: Door) => {
    setDoor(next);
    setError(null);
    setWords(text);
    setTitle(text.split('\n')[0].slice(0, 120));
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !door || !project) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/homeroom-bot/threads/${rootId}/${door}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(door === 'file'
          ? { project, title, text: words }
          : { project, number: Number(number), text: words }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) { setWhere(data); setDoor(null); return; }
      // Already done elsewhere: say where it went.
      if (res.status === 409 && data && typeof data.state === 'string') { setWhere(data); setDoor(null); return; }
      setError(data && typeof data.error === 'string' && data.error !== 'join_required'
        ? data.error : t('messages:privateThread.failed'));
    } catch {
      setError(t('messages:privateThread.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-2" data-private-thread="open">
      <div className="flex flex-wrap items-center gap-2">
        <span className="messages-bot-note min-w-0 flex-1">{t('messages:privateThread.label')}</span>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-private-door="file" aria-pressed={door === 'file'} onClick={() => opening('file')}>
          {t('messages:privateThread.fileIt')}
        </Button>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-private-door="post" aria-pressed={door === 'post'} onClick={() => opening('post')}>
          {t('messages:privateThread.postIt')}
        </Button>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-private-door="new" aria-pressed={door === 'new'} onClick={() => opening('new')}>
          {t('messages:privateThread.newProject')}
        </Button>
      </div>
      {door === 'new' ? (
        <div className="mt-2 flex flex-col gap-2" data-private-form="new">
          <p className="messages-bot-note">{t('messages:privateThread.whoFor')}</p>
          <div className="messages-bot-answers" role="group" aria-label={t('messages:privateThread.whoFor')}>
            <button type="button" className="messages-bot-primary" data-private-audience="solo" onClick={() => startProject('solo')}><span>{t('messages:privateThread.forMe')}</span></button>
            <button type="button" className="messages-bot-secondary" data-private-audience="invited" onClick={() => startProject('invited')}><span>{t('messages:privateThread.forGroup')}</span></button>
            <button type="button" className="messages-bot-secondary" data-private-audience="open" onClick={() => startProject('open')}><span>{t('messages:privateThread.forCommunity')}</span></button>
          </div>
        </div>
      ) : null}
      {door === 'file' || door === 'post' ? (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { void send(event); }} data-private-form={door}>
          <Select aria-label={t('messages:privateThread.project')} value={project} onChange={(e) => setProject(e.currentTarget.value)} required>
            <option value="">{t('messages:privateThread.chooseProject')}</option>
            {choices.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </Select>
          {door === 'file' ? (
            <Input aria-label={t('messages:privateThread.title')} placeholder={t('messages:privateThread.title')} value={title} maxLength={120} onChange={(e) => setTitle(e.currentTarget.value)} />
          ) : (
            <Input aria-label={t('messages:privateThread.number')} placeholder={t('messages:privateThread.number')} inputMode="numeric" value={number} onChange={(e) => setNumber(e.currentTarget.value.replace(/[^0-9]/g, ''))} required />
          )}
          <Textarea aria-label={t('messages:privateThread.words')} value={words} rows={3} maxLength={3500} onChange={(e) => setWords(e.currentTarget.value)} />
          {error ? <p role="alert" className="messages-bot-note">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !project || (door === 'post' && !number)}>
              {door === 'file' ? t('messages:privateThread.sendFile') : t('messages:privateThread.sendPost')}
            </Button>
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={() => setDoor(null)}>
              {t('messages:privateThread.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
