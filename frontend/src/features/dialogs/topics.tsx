/**
 * #4417: TOPICS (#topics-modal), from Settings & rules.
 *
 * A project's topics are the lasting conversations it is organised by: each
 * is a channel and a category at once, and they live in dapp.json's `topics`,
 * so changing one is a change to the project like any other. This dialog is
 * where a member proposes one —
 *
 *   New topic          a name, a channel handle, what it is for
 *   Rename             the name, the handle (the old one keeps working), the line
 *   Merge into…        its requests and votes move to the topic chosen;
 *                      its channel stays, read only
 *   Archive            its channel stays, read only; its requests are sorted again
 *
 * — and each one opens a PR for the group's vote
 * (POST /api/apps/:slug/topics-pr, src/services/topics-pr.js). Nothing
 * changes until it is voted in: the topics listed are the merged file's, read
 * from the community record (`places`), and the proposals still waiting are
 * listed under them.
 *
 * Ships hidden and EMPTY but for its title, its line and its error line, like
 * #app-domain-modal: everything else is drawn from the community record once
 * it is open, so the prerender and the first client render agree. The ids
 * that render behind the open (and so are not in the prerender): #topics-form
 * with #topics-name, #topics-handle and #topics-about, #topics-into (a merge's
 * survivor), #topics-submit and #topics-status.
 *
 * Fields are uncontrolled (refs, not `value`), as every dialog here is
 * (tests/dialog-components.test.js); a change of what the form is for writes
 * them once, from the topic it is about.
 */

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { reloadCommunity, useCommunity, type PlaceChannel } from '../dev-board/workshop/community-card';
import { channelsOf, liveTopics } from '../dev-board/workshop/places';
import { useDialog } from './use-dialog';

type Mode =
  | { op: 'add' }
  | { op: 'rename'; key: string }
  | { op: 'merge'; key: string }
  | { op: 'archive'; key: string };

/** A channel handle from what is typed: what the server will make of it. */
export function handleFromName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** "#onboarding · 9 requests"; a retired topic says what became of it. */
export function topicRowLine(topic: PlaceChannel, channels: PlaceChannel[] = []): string {
  if (topic.state === 'merged') {
    const into = channels.find((c) => c.kind === 'topic' && c.key === topic.merged_into);
    return `#${topic.handle} · merged into ${into ? `#${into.handle}` : 'another topic'}`;
  }
  if (topic.state === 'archived') return `#${topic.handle} · archived`;
  const n = Number(topic.requests) || 0;
  return `#${topic.handle} · ${n} ${n === 1 ? 'request' : 'requests'}`;
}

function TopicTile({ icon }: { icon: string }) {
  return (
    <IconTile size="xs" aria-hidden="true">
      <span className="text-base leading-none">{icon || '#'}</span>
    </IconTile>
  );
}

export function TopicsDialog() {
  const nameRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<HTMLInputElement>(null);
  const aboutRef = useRef<HTMLTextAreaElement>(null);
  const intoRef = useRef<HTMLSelectElement>(null);
  const [slug, setSlug] = useState('');
  const [mode, setMode] = useState<Mode>({ op: 'add' });
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  // The handle follows the name until someone types a handle of their own.
  const handleTouched = useRef(false);

  const community = useCommunity(slug);
  const places = community?.places || null;
  const channels = channelsOf(places);
  const live = liveTopics(places);
  const retired = channels.filter((c) => c.kind === 'topic' && c.state !== 'live');
  const proposals = places?.proposals || [];
  const subject = mode.op === 'add' ? null : live.find((t) => t.key === mode.key) || null;

  const dialog = useDialog<{ slug?: string }>('topics', {
    onOpen: (payload) => {
      const target = payload?.slug
        || (window.AppView?.appData?.slug as string | undefined)
        || ((window as unknown as { App?: { currentApp?: string | null } }).App?.currentApp ?? '')
        || '';
      setSlug(target);
      setMode({ op: 'add' });
      setMenuFor(null);
      setError('');
      setStatus('');
      if (target) void reloadCommunity(target);
    },
    onClose: () => {
      setMode({ op: 'add' });
      setMenuFor(null);
      setError('');
      setStatus('');
    },
    canClose: () => !pending.current,
  });

  // Fill the form for what it is about now: empty for a new topic, the
  // topic's own words for a rename.
  useEffect(() => {
    if (!dialog.isOpen) return;
    handleTouched.current = mode.op === 'rename';
    const t = mode.op === 'rename' ? subject : null;
    if (nameRef.current) nameRef.current.value = t ? t.name : '';
    if (handleRef.current) handleRef.current.value = t ? t.handle : '';
    if (aboutRef.current) aboutRef.current.value = t ? t.about : '';
    if (intoRef.current) intoRef.current.value = '';
    // `subject` is read once per change of mode, deliberately: a record that
    // lands while someone is typing must not overwrite what they typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.isOpen, mode]);

  function followName() {
    if (handleTouched.current || !handleRef.current || !nameRef.current) return;
    handleRef.current.value = handleFromName(nameRef.current.value);
  }

  function choose(next: Mode) {
    setMenuFor(null);
    setError('');
    setStatus('');
    setMode(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !slug) return;
    let body: Record<string, string>;
    if (mode.op === 'add' || mode.op === 'rename') {
      const name = (nameRef.current?.value || '').trim();
      const handle = (handleRef.current?.value || '').trim().replace(/^#/, '').toLowerCase();
      const about = (aboutRef.current?.value || '').trim();
      if (name.length < 3) return setError('A topic needs a name of at least 3 characters.');
      if (name.length > 48) return setError('A topic\'s name is 48 characters at most.');
      if (about.length > 140) return setError('What it is for is one line: 140 characters at most.');
      if (mode.op === 'add') {
        body = { op: 'add', name, handle: handle || handleFromName(name), about };
      } else {
        if (!subject) return setError('That topic is not live any more.');
        body = { op: 'rename', id: mode.key };
        if (name !== subject.name) body.name = name;
        if (handle && handle !== subject.handle) body.handle = handle;
        if (about !== subject.about) body.about = about;
        if (Object.keys(body).length === 2) return setError('Change the name, the channel or what it is for first.');
      }
    } else if (mode.op === 'merge') {
      const into = intoRef.current?.value || '';
      if (!into) return setError('Choose the topic to merge it into.');
      body = { op: 'merge', id: mode.key, into };
    } else {
      body = { op: 'archive', id: mode.key };
    }

    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not open the proposal. Try again.');
        return;
      }
      setStatus(`"${data.title || 'Topic change'}" is up for a vote. It applies once voted in.`);
      setMode({ op: 'add' });
      void reloadCommunity(slug);
      (window.AppView?.refreshDevData as ((reason: string) => void) | undefined)?.('vote');
    } catch {
      setError('Network error while opening the proposal.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    dialog.closeForNavigation();
  };

  const formTitle = mode.op === 'add' ? 'New topic'
    : mode.op === 'rename' ? `Rename #${subject?.handle || ''}`
      : mode.op === 'merge' ? `Merge #${subject?.handle || ''} into…`
        : `Archive #${subject?.handle || ''}`;

  return (
    <DialogRoot id="topics-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">Topics</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          Each change is a proposal the group votes on. It applies once voted in.
        </p>
        <p
          id="topics-error"
          role="alert"
          className={`${error ? '' : 'hidden'} text-sm text-red-700 dark:text-red-400 mb-3`}
        >{error}</p>

        {dialog.isOpen ? (
          <div className="topics-dialog-body" data-topics-slug={slug}>
            {status ? (
              <p id="topics-status" role="status" className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">{status}</p>
            ) : null}
            {!places ? (
              <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">Loading…</p>
            ) : (
              <>
                {live.length ? (
                  <GroupedList className="mb-4" data-topics-list="live">
                    {live.map((t) => (
                      <div key={t.key || t.handle} data-topic-row={t.key || t.handle}>
                        <ListRow
                          leading={<TopicTile icon={t.icon} />}
                          title={t.name}
                          subtitle={topicRowLine(t, channels)}
                          chevron={false}
                          className="py-2.5"
                          trailing={(
                            <button
                              type="button"
                              className="topics-row-more"
                              aria-label={`Change ${t.name}`}
                              aria-expanded={menuFor === t.key}
                              data-topic-more={t.key || ''}
                              onClick={() => setMenuFor(menuFor === t.key ? null : t.key)}
                            >⋯</button>
                          )}
                        />
                        {menuFor === t.key && t.key ? (
                          <div className="topics-row-actions" role="group" aria-label={`Change ${t.name}`}>
                            <button type="button" data-topic-op="rename" onClick={() => choose({ op: 'rename', key: t.key as string })}>Rename</button>
                            {live.length > 1 ? (
                              <button type="button" data-topic-op="merge" onClick={() => choose({ op: 'merge', key: t.key as string })}>Merge into…</button>
                            ) : null}
                            <button type="button" data-topic-op="archive" onClick={() => choose({ op: 'archive', key: t.key as string })}>Archive</button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </GroupedList>
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">No topics yet. Propose the first below.</p>
                )}

                <form id="topics-form" className="space-y-3" data-topics-op={mode.op} onSubmit={submit}>
                  <SectionHeader className="px-0 pt-0">{formTitle}</SectionHeader>
                  {mode.op === 'add' || mode.op === 'rename' ? (
                    <>
                      <div>
                        <label htmlFor="topics-name" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                          {mode.op === 'add' ? 'New topic' : 'Name'}
                        </label>
                        <Input
                          id="topics-name"
                          ref={nameRef}
                          type="text"
                          maxLength={48}
                          autoComplete="off"
                          box="dialog"
                          hint="muted"
                          ring="seamless"
                          placeholder="What it is about, in a few words"
                          onInput={followName}
                        />
                      </div>
                      <div>
                        <label htmlFor="topics-handle" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                          Channel
                        </label>
                        <Input
                          id="topics-handle"
                          ref={handleRef}
                          type="text"
                          maxLength={32}
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          box="dialog"
                          hint="muted"
                          ring="seamless"
                          placeholder="onboarding"
                          onInput={() => { handleTouched.current = true; }}
                        />
                        {mode.op === 'rename' ? (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Links to the old name keep working.</p>
                        ) : null}
                      </div>
                      <div>
                        <label htmlFor="topics-about" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                          What it is for
                        </label>
                        <Textarea
                          id="topics-about"
                          ref={aboutRef}
                          rows={2}
                          maxLength={140}
                          box="dialog"
                          hint="muted"
                          ring="seamless"
                          className="resize-none"
                          placeholder="One line people see at the top of the channel"
                        />
                      </div>
                    </>
                  ) : null}
                  {mode.op === 'merge' ? (
                    <div>
                      <label htmlFor="topics-into" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                        Merge into
                      </label>
                      <select id="topics-into" ref={intoRef} defaultValue="" className="topics-into">
                        <option value="" disabled>Choose a topic</option>
                        {live.filter((t) => t.key !== mode.key).map((t) => (
                          <option key={t.key || t.handle} value={t.key || ''}>{`${t.icon ? `${t.icon} ` : ''}${t.name} (#${t.handle})`}</option>
                        ))}
                      </select>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                        Its requests and their votes move to the topic you choose. Its channel stays, read only, with its history.
                      </p>
                    </div>
                  ) : null}
                  {mode.op === 'archive' ? (
                    <p className="text-sm text-zinc-600 dark:text-zinc-300">
                      Its channel stays, read only, with its history. Its requests are sorted into the other topics again.
                    </p>
                  ) : null}
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="neutral"
                      ink="neutral"
                      layout="flex"
                      disabled={busy}
                      onClick={() => (mode.op === 'add' ? dialog.close() : choose({ op: 'add' }))}
                    >Cancel</Button>
                    <Button id="topics-submit" type="submit" layout="flex" disabled={busy}>
                      {busy ? 'Opening PR…' : 'Open PR'}
                    </Button>
                  </div>
                </form>

                {proposals.length ? (
                  <>
                    <SectionHeader className="px-0 pt-5">Waiting for a vote</SectionHeader>
                    <GroupedList data-topics-list="proposals">
                      {proposals.map((p) => (
                        <ListRow
                          key={p.session_id}
                          as="a"
                          href={`#app/${encodeURIComponent(slug)}/dev/sessions/${p.session_id}`}
                          onClick={leave}
                          title={p.title || 'Topic change'}
                          subtitle={p.pr_number ? `PR #${p.pr_number}` : undefined}
                        />
                      ))}
                    </GroupedList>
                  </>
                ) : null}

                {retired.length ? (
                  <>
                    <SectionHeader className="px-0 pt-5">Archived</SectionHeader>
                    <GroupedList data-topics-list="archived">
                      {retired.map((t) => (
                        <ListRow
                          key={t.key || t.handle}
                          leading={<TopicTile icon={t.icon} />}
                          title={t.name}
                          subtitle={topicRowLine(t, channels)}
                          chevron={false}
                          className="py-2.5"
                        />
                      ))}
                    </GroupedList>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </DialogCard>
    </DialogRoot>
  );
}
