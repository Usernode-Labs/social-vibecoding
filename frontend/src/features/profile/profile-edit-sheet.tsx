/**
 * `#profile-edit-sheet` — the editable profile's panel (#982), as React
 * (#1191 slice 6, conversion 1).
 *
 * It is NOT one of the nine static-modal dialogs, so it does not go through
 * lib/static-modal.ts: there is no root in the shipped markup whose card gets
 * lifted. It is created on demand and handed to `PlatformUI.sheet`, which is
 * exactly what lib/kit-surface.ts's `kind: 'sheet'` presentation does — and
 * doing it there rather than by hand is what keeps the roll-back correct when
 * the kit refuses.
 *
 * Two constraints, both from that lift:
 *
 * - **`className` on the panel is a constant.** `adoptKitSurface` writes
 *   `platform-sheet-adopted` onto this node, and React writes the whole
 *   attribute when the prop changes, so a re-render with a computed class
 *   string would silently drop it mid-presentation. The inline-fallback
 *   decoration therefore goes on through `useClassToggle`.
 * - **The panel is restored before React unmounts it.** The kit has physically
 *   reparented it; the layout-effect cleanup runs before React detaches the
 *   node, so `restore()` there is what stops a `NotFoundError` on close.
 *
 * `home: 'placeholder'` because the panel's home is inside `#profile-root`,
 * which is the no-kit presentation the legacy code fell back to
 * (`root.insertBefore(panel, root.firstChild)`) so the editor is never
 * unreachable.
 *
 * The form's field values live here, in component state, seeded from the
 * session user. Everything that decides what a value MEANS — the byte budget,
 * the downscale, the save order, the per-field server messages — is in
 * ./profile.js.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useClassToggle, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { Profile } from './profile.js';

const FIELD_CLASS =
  'w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 ' +
  'bg-white dark:bg-zinc-900 text-sm';

function Avatar({ url, initial }: { url: string | null; initial: string }): ReactNode {
  if (url) {
    return (
      <img
        className="w-16 h-16 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={url}
        alt=""
      />
    );
  }
  return (
    <div
      className={
        'w-16 h-16 text-xl rounded-full shrink-0 flex items-center justify-center '
        + 'font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/** One labelled field plus a live counter, and the slot the save path pins a
 *  server-side message into. */
function Field({
  label, id, tag, value, onChange, maxLength, hint, placeholder, error,
}: {
  label: string;
  id: string;
  tag: 'input' | 'textarea';
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  hint?: string | null;
  placeholder?: string;
  error?: string | null;
}): ReactNode {
  return (
    <div className="mb-4">
      <div className="flex items-baseline gap-2 mb-1">
        <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 flex-1">
          {label}
        </label>
        <span className="text-xs text-zinc-400">{`${value.length}/${maxLength}`}</span>
      </div>
      {tag === 'textarea' ? (
        <textarea
          id={id}
          rows={3}
          className={FIELD_CLASS}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        >
        </textarea>
      ) : (
        <input
          id={id}
          type="text"
          className={FIELD_CLASS}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{hint}</p>
      ) : null}
      <p className={error ? 'text-xs text-red-500 mt-1' : 'text-xs text-red-500 mt-1 hidden'}>
        {error || ''}
      </p>
    </div>
  );
}

export function ProfileEditSheet({
  avatarUrl,
  initial,
}: {
  avatarUrl: string | null;
  initial: string;
}): ReactNode {
  const user = (Profile as unknown as { _user(): Record<string, unknown> })._user();
  const links = (user.links || {}) as Record<string, string>;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [adopted, setAdopted] = useState(false);

  const [name, setName] = useState(String(user.displayName || ''));
  const [bio, setBio] = useState(String(user.bio || ''));
  const [github, setGithub] = useState(String(links.github || ''));
  const [x, setX] = useState(String(links.x || ''));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRemove, setShowRemove] = useState(!!user.avatarUrl);

  // Hand the panel to the native kit, exactly once, and put it back before
  // React ever tries to remove it.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    if (!contentEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'sheet',
      contentEl,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => {
        adoption = null;
        Profile._dismissSheet();
      },
    });
    setAdopted(!!adoption);
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.restore();
      handle.dismiss();
    };
  }, []);

  // The no-kit presentation: the panel simply stays where React put it, at the
  // top of #profile-root, with the card chrome the kit shell would otherwise
  // have drawn. Written on the ref because the kit owns this node's classList.
  useClassToggle(panelRef, 'rounded-xl', !adopted);
  useClassToggle(panelRef, 'border', !adopted);
  useClassToggle(panelRef, 'border-zinc-200', !adopted);
  useClassToggle(panelRef, 'dark:border-zinc-800', !adopted);
  useClassToggle(panelRef, 'mb-5', !adopted);

  // The staged photo's object URL is revoked by Profile._clearPendingAvatar;
  // closing the sheet any other way (route change, a second showEditSheet)
  // goes through _dismissSheet, which calls it.
  useEffect(() => () => { /* teardown handled by Profile._dismissSheet */ }, []);

  const onFile = async (): Promise<void> => {
    const input = fileRef.current;
    const chosen = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!chosen) return;
    setPhotoError(null);
    try {
      await Profile.stageAvatar(chosen);
      setShowRemove(true);
    } catch (err) {
      setPhotoError((err && (err as Error).message)
        || 'That image could not be used — try a PNG, JPEG or WebP.');
    }
  };

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    const result = await Profile._save({
      displayName: name, bio, github, x,
    });
    if (result.ok) return;
    if (result.fieldErrors) setFieldErrors(result.fieldErrors);
    else setFormError(result.error || 'Could not save your profile.');
    setSaving(false);
  };

  return (
    <div id="profile-edit-sheet" ref={panelRef} className="px-4 pb-5">
      <div className="text-lg font-bold py-3">Edit profile</div>

      <div className="flex items-center gap-4 mb-3">
        <div id="profile-edit-preview" className="shrink-0">
          <Avatar url={avatarUrl} initial={initial} />
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            id="profile-edit-file"
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={() => { void onFile(); }}
          />
          <button
            id="profile-edit-choose"
            className={
              'px-3 py-1.5 rounded-lg text-sm font-medium border '
              + 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }
            onClick={() => fileRef.current?.click()}
          >
            Choose photo
          </button>
          <button
            id="profile-edit-remove"
            className={
              showRemove
                ? 'px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 '
                  + 'border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950'
                : 'px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 '
                  + 'border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950 hidden'
            }
            onClick={() => { Profile.stageAvatarRemoval(); setShowRemove(false); }}
          >
            Remove photo
          </button>
        </div>
      </div>
      <p
        id="profile-edit-photo-error"
        className={photoError ? 'text-xs text-red-500 mb-3' : 'text-xs text-red-500 mb-3 hidden'}
      >
        {photoError || ''}
      </p>

      <Field
        label="Display name"
        id="profile-edit-name"
        tag="input"
        value={name}
        onChange={setName}
        maxLength={Profile.MAX_DISPLAY_NAME}
        hint="The name other people see. Leave it empty to show your @handle."
        error={fieldErrors.displayName}
      />
      <Field
        label="Bio"
        id="profile-edit-bio"
        tag="textarea"
        value={bio}
        onChange={setBio}
        maxLength={Profile.MAX_BIO}
        error={fieldErrors.bio}
      />
      <Field
        label="GitHub"
        id="profile-edit-github"
        tag="input"
        value={github}
        onChange={setGithub}
        maxLength={39}
        placeholder="handle, without the @"
        error={fieldErrors.github}
      />
      <Field
        label="X"
        id="profile-edit-x"
        tag="input"
        value={x}
        onChange={setX}
        maxLength={39}
        placeholder="handle, without the @"
        error={fieldErrors.x}
      />

      {/*
          The username is deliberately not editable — here or anywhere. It is
          the sign-in identifier and the address of the public builder page, so
          it is shown read-only WITH the reason: a greyed-out field with no
          explanation reads as a bug.
      */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
          Username
        </label>
        <input
          id="profile-edit-username"
          type="text"
          value={user.username ? `@${user.username}` : ''}
          readOnly
          disabled
          className={
            'w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 '
            + 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-500 text-sm '
            + 'cursor-not-allowed'
          }
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          Your @handle is your sign-in name and the address of your public
          builder page, so it can’t be changed. Set a display name above to
          change how your name appears.
        </p>
      </div>

      <p
        id="profile-edit-error"
        className={formError ? 'text-sm text-red-500 mb-2' : 'text-sm text-red-500 mb-2 hidden'}
      >
        {formError || ''}
      </p>

      <Button
        id="profile-edit-save"
        layout="tapFull"
        variant="tapPrimary"
        size="none"
        ink="solidText"
        className="disabled:opacity-60"
        disabled={saving}
        onClick={() => { void onSave(); }}
      >
        Save
      </Button>
      <button
        className="w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400"
        onClick={() => Profile._dismissSheet()}
      >
        Cancel
      </button>
    </div>
  );
}
