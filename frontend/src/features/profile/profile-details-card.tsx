/** The standard profile's in-page editor. Photo and publishing keep their
 * existing sheet; saving these two fields must not consume its staged photo. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useMessages } from '../../lib/i18n/react';
import { Profile } from './profile.js';

type DetailsUser = { displayName?: string | null; bio?: string | null; username?: string | null };
export function ProfileDetailsCard({ id = 'profile-details', embedded = false, user: providedUser, onSaved }: {
  id?: string; embedded?: boolean; user?: DetailsUser | null; onSaved?: () => void;
} = {}) {
  const t = useMessages('profile');
  const user = providedUser || Profile._user();
  const [name, setName] = useState(user.displayName || '');
  const [bio, setBio] = useState(user.bio || '');
  const [saving, setSaving] = useState(false);
  const dirty = name !== (user.displayName || '') || bio !== (user.bio || '');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <section id={id} className="profile-details-card" data-embedded={embedded || undefined}>
      {!embedded ? <><h2>{t('profile:details.title')}</h2><p>{t('profile:details.intro')}</p></> : null}
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (saving || (embedded && !dirty)) return;
        setSaving(true);
        setError('');
        setErrors({});
        const result = await Profile._save({ displayName: name, bio, detailsOnly: true });
        setSaving(false);
        if (result.ok) onSaved?.();
        if (!result.ok) {
          setError(result.error || '');
          setErrors(result.fieldErrors || {});
        }
      }}>
        <Label className="profile-details-label" htmlFor={`${id}-name`}>{t('profile:edit.name.label')}</Label>
        <Input className="profile-details-input" id={`${id}-name`} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} aria-invalid={!!errors.displayName} aria-describedby={errors.displayName ? `${id}-name-error` : undefined} />
        {errors.displayName ? <p id={`${id}-name-error`} role="alert">{errors.displayName}</p> : null}
        <Label className="profile-details-label" htmlFor={`${id}-handle`}>{t('profile:edit.username.label')}</Label>
        <Input className="profile-details-input" id={`${id}-handle`} value={user.username ? `@${user.username}` : ''} readOnly aria-describedby={`${id}-handle-note`} />
        <a className="profile-details-handle-note" id={`${id}-handle-note`} href="#settings/username">{t('profile:details.handleNote')}</a>
        <Label className="profile-details-label" htmlFor={`${id}-bio`}>{t('profile:edit.about.bio')}</Label>
        <Textarea className="profile-details-input" id={`${id}-bio`} value={bio} maxLength={Profile.MAX_BIO} rows={embedded ? 2 : 3} onChange={(event) => setBio(event.target.value)} aria-invalid={!!errors.bio} aria-describedby={errors.bio ? `${id}-bio-error` : undefined} />
        <output className="profile-details-count" htmlFor={`${id}-bio`}>{bio.length}/{Profile.MAX_BIO}</output>
        {errors.bio ? <p id={`${id}-bio-error`} role="alert">{errors.bio}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!embedded || dirty || saving || error || Object.keys(errors).length ? <div className="profile-details-actions">
          <Button type="submit" disabled={saving}>{t('profile:details.save')}</Button>
          <Button type="button" variant="neutral" disabled={saving} onClick={() => { setName(user.displayName || ''); setBio(user.bio || ''); setError(''); setErrors({}); }}>{t('core:common.cancel')}</Button>
        </div> : null}
      </form>
    </section>
  );
}
