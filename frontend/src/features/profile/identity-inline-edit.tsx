/**
 * Editing the display name and the bio where they are shown (#7156).
 *
 * The standard look's identity card keeps no separate "Your profile" form:
 * a pencil beside the name and a small Edit bio / Add a bio under the @handle
 * open the one field they edit, in place of the line that was there. Both
 * save through ./profile.js's `_save({ …, detailsOnly: true })`, which skips
 * the photo the Edit profile sheet may have staged, and each sends the other
 * field as the account holds it so saving one never rewrites the other.
 *
 * Rendered by ./profile-view.tsx.
 */
import { useState } from 'react';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PencilSquareIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { cleanDisplayName, displayNameProblem } from './display-name';
import { Profile } from './profile.js';

type IdentityUser = { displayName?: string | null; bio?: string | null };

export type InlineEditProps = {
  user: IdentityUser | null | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
};

/** A pencil beside the name. Open, it is the name as a box with its actions
 *  in place of the name's own line. */
export function InlineNameEdit({ user, open, onOpen, onClose }: InlineEditProps) {
  const t = useMessages('profile');
  const stored = user?.displayName || '';
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!open) {
    return (
      <button
        type="button"
        id="profile-name-edit"
        className="profile-name-edit"
        aria-label={t('profile:identity.editName')}
        title={t('profile:identity.editName')}
        onClick={() => { setValue(stored); setError(''); setErrors({}); onOpen(); }}
      >
        <PencilSquareIcon aria-hidden="true" />
      </button>
    );
  }

  const close = () => { setValue(stored); setError(''); setErrors({}); onClose(); };

  return (
    <form
      className="profile-inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        const cleaned = cleanDisplayName(value);
        const problem = displayNameProblem(cleaned, 40);
        if (problem) {
          setError('');
          setErrors({
            displayName: problem === 'lineBreaks'
              ? t('profile:edit.name.lineBreaks')
              : t('profile:edit.name.tooLong', { count: 40 }),
          });
          return;
        }
        setSaving(true);
        setError('');
        setErrors({});
        setValue(cleaned);
        // The bio as the account holds it: this form edits the name alone.
        const result = await Profile._save({ displayName: cleaned, bio: user?.bio || '', detailsOnly: true });
        setSaving(false);
        if (result.ok) { onClose(); return; }
        setError(result.error || '');
        setErrors(result.fieldErrors || {});
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      }}
    >
      <Label htmlFor="profile-name-input">{t('profile:edit.name.label')}</Label>
      <Input
        id="profile-name-input"
        value={value}
        maxLength={40}
        onChange={(event) => setValue(event.target.value)}
        aria-invalid={!!errors.displayName}
        aria-describedby={errors.displayName ? 'profile-name-error' : undefined}
      />
      {errors.displayName ? <p id="profile-name-error" role="alert">{errors.displayName}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="profile-inline-actions">
        <button type="submit" disabled={saving}>{t('profile:details.save')}</button>
        <button type="button" disabled={saving} onClick={close}>{t('core:common.cancel')}</button>
      </div>
    </form>
  );
}

/** The bio under the @handle, with its Edit bio (or Add a bio, when there is
 *  none) beneath it. */
export function InlineBioEdit({ user, open, onOpen, onClose }: InlineEditProps) {
  const t = useMessages('profile');
  const stored = user?.bio || '';
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!open) {
    return (
      <>
        {/*
            The bio is deliberately plain text, not markdown: React renders it
            as a text child, which is the whole safety story — no HTML string
            is ever built for it, here or anywhere.

            `break-words` is load-bearing (#1612): a bio is free text, so it
            can be one 280-character word or a pasted URL with no space in it,
            and `whitespace-pre-line` alone leaves that on a single line — it
            spills past the card and gives the whole screen a horizontal
            scrollbar.
        */}
        {stored ? (
          <p className="profile-id-bio text-sm text-zinc-600 dark:text-zinc-300 mt-3 whitespace-pre-line break-words">
            {stored}
          </p>
        ) : null}
        <button
          type="button"
          id="profile-bio-edit"
          className="profile-bio-edit"
          onClick={() => { setValue(stored); setError(''); setErrors({}); onOpen(); }}
        >
          {stored ? t('profile:identity.editBio') : t('profile:identity.addBio')}
        </button>
      </>
    );
  }

  const close = () => { setValue(stored); setError(''); setErrors({}); onClose(); };

  return (
    <form
      className="profile-inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError('');
        setErrors({});
        // The name as the account holds it: this form edits the bio alone.
        const result = await Profile._save({ displayName: user?.displayName || '', bio: value, detailsOnly: true });
        setSaving(false);
        if (result.ok) { onClose(); return; }
        setError(result.error || '');
        setErrors(result.fieldErrors || {});
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      }}
    >
      <Label htmlFor="profile-bio-input">{t('profile:edit.about.bio')}</Label>
      <Textarea
        id="profile-bio-input"
        value={value}
        maxLength={Profile.MAX_BIO}
        rows={3}
        onChange={(event) => setValue(event.target.value)}
        aria-invalid={!!errors.bio}
        aria-describedby={errors.bio ? 'profile-bio-error' : undefined}
      />
      <output className="profile-inline-count" htmlFor="profile-bio-input">{value.length}/{Profile.MAX_BIO}</output>
      {errors.bio ? <p id="profile-bio-error" role="alert">{errors.bio}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="profile-inline-actions">
        <button type="submit" disabled={saving}>{t('profile:details.save')}</button>
        <button type="button" disabled={saving} onClick={close}>{t('core:common.cancel')}</button>
      </div>
    </form>
  );
}
