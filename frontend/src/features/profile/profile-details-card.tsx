/** The standard profile's in-page editor. Photo and publishing keep their
 * existing sheet; saving these two fields must not consume its staged photo. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useMessages } from '../../lib/i18n/react';
import { Profile } from './profile.js';

export function ProfileDetailsCard() {
  const t = useMessages('profile');
  const user = Profile._user();
  const [name, setName] = useState(user.displayName || '');
  const [bio, setBio] = useState(user.bio || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <section id="profile-details" className="profile-details-card">
      <h2>{t('profile:details.title')}</h2>
      <p>{t('profile:details.intro')}</p>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError('');
        setErrors({});
        const result = await Profile._save({ displayName: name, bio, detailsOnly: true });
        setSaving(false);
        if (!result.ok) {
          setError(result.error || '');
          setErrors(result.fieldErrors || {});
        }
      }}>
        <Label htmlFor="profile-details-name">{t('profile:edit.name.label')}</Label>
        <Input id="profile-details-name" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} aria-invalid={!!errors.displayName} aria-describedby={errors.displayName ? 'profile-details-name-error' : undefined} />
        {errors.displayName ? <p id="profile-details-name-error" role="alert">{errors.displayName}</p> : null}
        <Label htmlFor="profile-details-handle">{t('profile:edit.username.label')}</Label>
        <Input id="profile-details-handle" value={user.username ? `@${user.username}` : ''} readOnly aria-describedby="profile-details-handle-note" />
        <a id="profile-details-handle-note" href="#settings/username">{t('profile:details.handleNote')}</a>
        <Label htmlFor="profile-details-bio">{t('profile:edit.about.bio')}</Label>
        <Textarea id="profile-details-bio" value={bio} maxLength={Profile.MAX_BIO} rows={4} onChange={(event) => setBio(event.target.value)} aria-invalid={!!errors.bio} aria-describedby={errors.bio ? 'profile-details-bio-error' : undefined} />
        <output className="profile-details-count" htmlFor="profile-details-bio">{bio.length}/{Profile.MAX_BIO}</output>
        {errors.bio ? <p id="profile-details-bio-error" role="alert">{errors.bio}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="profile-details-actions">
          <Button type="submit" disabled={saving}>{t('profile:details.save')}</Button>
          <Button type="button" variant="neutral" disabled={saving} onClick={() => { setName(user.displayName || ''); setBio(user.bio || ''); setError(''); setErrors({}); }}>{t('core:common.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}
