/**
 * `#profile-edit-sheet` — the editable profile's card (#982), as React
 * (#1191 slice 6, conversion 1), rebuilt as inset-grouped sections (#1285).
 *
 * It is NOT one of the nine static-modal dialogs, so it does not go through
 * lib/static-modal.ts: there is no root in the shipped markup whose card gets
 * lifted. It is created on demand and handed to `PlatformUI.modal`, which is
 * exactly what lib/kit-surface.ts's `kind: 'modal'` presentation does — and
 * doing it there rather than by hand is what keeps the roll-back correct when
 * the kit refuses.
 *
 * ── Why the kit MODAL and not the kit bottom sheet (#1285) ────────────
 *
 * This was `kind: 'sheet'` until #1285, and the reporter's screenshot is what
 * that cost. `app.css`'s `.platform-sheet-adopted` writes `display: flex
 * !important` and NO `flex-direction` — correct for the three surfaces it was
 * written for (`ANCHORED_PANEL_CLASS`, the dev-console root), because each
 * carries `flex flex-col` in its own class string and the `!important` only
 * re-asserts what they had. This panel's class string was `px-4 pb-5`, so it
 * became a ROW: heading, photo group, four fields, the username block, both
 * error slots, Save and Cancel laid out side by side, Save stretched to the
 * full height and Cancel pushed off-screen.
 *
 * `flex flex-col` (below, in the card's constant class) is the one-line half of
 * the fix. The other half is the surface: `.platform-sheet-adopted` also pins
 * `max-height: 70vh` and `.un-sheet` sets `touch-action: none` with pointer
 * handlers on the whole sheet and no scroller detection, so an inner
 * `overflow-y-auto` would be dismissed by the drag that tried to scroll it.
 * `.un-modal` is a real keyboard-aware scroller (`overflow-y: auto`,
 * `max-height: calc(100dvh - 32px - insets - kb)`), which is what a form this
 * tall needs. #915 moved the hamburger drawer sheet→panel for the same reason.
 *
 * Three constraints, all from the lift:
 *
 * - **`className` on the root AND the card is a constant.** `adoptKitSurface`
 *   writes `platform-modal-adopted` onto the root and `platform-modal-card`
 *   onto the card, and React writes the whole attribute when the prop changes,
 *   so a re-render with a computed class string would silently drop either one
 *   mid-presentation.
 * - **The card is restored before React unmounts it.** The kit has physically
 *   reparented it; the layout-effect cleanup runs before React detaches the
 *   node, so `restore()` there is what stops a `NotFoundError` on close.
 * - **The root is the flagged node, the card is the lifted one.** Exactly the
 *   dialogs' split (lib/static-modal.ts): `.platform-modal-adopted` is
 *   `display: none !important`, so it cannot go on the node the kit is
 *   showing. The root is also where the no-kit card chrome lives — while
 *   adopted it is hidden, so that chrome costs nothing.
 *
 * `home: 'placeholder'` because the card's home is inside the root inside
 * `#profile-root`, which is the no-kit presentation the legacy code fell back
 * to (`root.insertBefore(panel, root.firstChild)`) so the editor is never
 * unreachable.
 *
 * ── Why the rows are the kit's inset-grouped vocabulary ───────────────
 *
 * `.un-group` / `.un-group-header` / `.un-group-row` come from native.css, the
 * same stylesheet the switches in features/settings/sections/alerts.tsx reach
 * into. Two rules they impose:
 *
 *   * **No Tailwind `bg-*` on a `.un-group` element.** `tailwind.css` loads
 *     AFTER `native.css`, so a utility would beat `var(--un-group-bg)` — which
 *     is the token that makes the card read as raised against the modal's
 *     `--un-sheet-bg`.
 *   * **`.un-group` is `overflow: hidden`,** which clips an outward
 *     `focus:ring-2` box-shadow. The row fields therefore run `ring={false}`
 *     and the focus cue is a `focus-within:` background tint on the ROW — a
 *     background is not clipped.
 *
 * Rows carry `px-4` on purpose: the hairline pseudo-element is drawn at
 * `left: 16px`, and `.un-group-header`'s own `padding: 0 16px 7px` puts the
 * section heading on that same line.
 *
 * The form's field values live here, in component state, seeded from the
 * session user. Everything that decides what a value MEANS — the byte budget,
 * the downscale, the save order, the per-field server messages — is in
 * ./profile.js.
 *
 * ── "Public page" is here now ─────────────────────────────────────────
 *
 * The opt-in public profile's controls (#582) were a card of their own on the
 * Me screen, second only to the identity card. The prototype's Me has no room
 * for them — its card carries one action, Edit — and they are about exactly
 * what this sheet edits: whether the name, photo and bio above are visible to
 * people who are not signed in. So they are a group of this sheet, with the
 * same status line. They act IMMEDIATELY, as they always did (the switch is a
 * PATCH of its own, not part of Save). #2787 folded them into one switch row —
 * see PublicPage below.
 */

import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDownIcon } from '@/components/ui/icons';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { Profile } from './profile.js';
import { PublicProfileCard } from './public-profile-card';

/**
 * The no-kit card chrome, on the node the kit flags rather than the node it
 * lifts. Constant: `platform-modal-adopted` is written here through classList.
 */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/**
 * The lifted card. Constant for the same reason (`platform-modal-card` lands
 * here), and `flex flex-col` is the #1285 regression guard: nothing about this
 * card's layout may depend on what an adopted-class `display` happens to be.
 * Its padding is zeroed by `.un-modal .platform-modal-card` while adopted, so
 * `px-4 pb-5` only draws in the fallback.
 */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

/** A group row's shared geometry. `px-4` is load-bearing — see the note above. */
const ROW_CLASS = 'un-group-row px-4 py-2 focus-within:bg-violet-50 dark:focus-within:bg-violet-950/40';
/** A row that is itself the tappable control. */
const ROW_ACTION_CLASS = 'un-group-row flex items-center w-full px-4 min-h-[44px] text-sm font-medium';

const ROW_LABEL_CLASS = 'text-sm font-normal text-zinc-900 dark:text-zinc-100';
const FOOTNOTE_CLASS = 'px-4 mt-1.5 text-xs text-zinc-500 dark:text-zinc-400';
const COUNTER_CLASS = 'text-xs text-zinc-500 tabular-nums dark:text-zinc-400';

function Avatar({ url, initial }: { url: string | null; initial: string }): ReactNode {
  if (url) {
    return (
      <img
        className="w-12 h-12 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={url}
        alt=""
      />
    );
  }
  return (
    <div
      className={
        'w-12 h-12 text-lg rounded-full shrink-0 flex items-center justify-center '
        + 'font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/** The section heading + card pair every group is made of. */
function Group({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <>
      <div className="un-group-header">{title}</div>
      <div className="un-group">{children}</div>
    </>
  );
}

/**
 * The slot the save path pins a server-side message into. Always rendered, so
 * the message appears without moving anything: same contract the retired
 * per-field `<p>` had.
 */
function FieldError({ message }: { message?: string | null }): ReactNode {
  return (
    <p className={message ? 'px-4 mt-1.5 text-xs text-red-700 dark:text-red-400' : 'px-4 mt-1.5 text-xs text-red-700 hidden dark:text-red-400'}>
      {message || ''}
    </p>
  );
}

/**
 * The public page's controls (#582), as a group of this sheet. `controls` is
 * ./profile-store.js's publicControlsView; null while
 * GET /api/me/public-profile has not answered, and then the group is not drawn
 * at all rather than drawn wrong.
 *
 * ── Why one switch and not five rows (#2787) ──────────────────────────
 *
 * This used to be a Visibility row, then Publish / Preview / Open / Copy link
 * as four tappable rows, then a four-line footnote listing every field the
 * page does and does not include — the tallest group of the sheet on a phone,
 * for a setting most people never change, and it never said what "publish"
 * meant. Now:
 *
 *   * ONE switch row, "Public profile", whose second line says in plain words
 *     what the state means (`id="public-profile-visibility"` keeps carrying
 *     it). The switch keeps `id="public-profile-publish"` and still calls the
 *     same immediate PATCH.
 *   * Open / Copy link only while the page is actually live: on a private
 *     profile the link leads nowhere for anyone else.
 *   * "What's on it" is a disclosure row. The field list and the preview card
 *     live behind it, driven by the store's existing `previewOpen`.
 */
function PublicPage({ controls, status, publishing, previewOpen }: {
  controls: any;
  status: string;
  publishing: boolean;
  previewOpen: boolean;
}): ReactNode {
  const published = !!controls.published;
  return (
    <section id="public-profile-controls" className="mb-4">
      <Group title="Public page">
        <label
          htmlFor="public-profile-publish"
          className="un-group-row flex items-center gap-3 px-4 py-2 min-h-[44px] cursor-pointer select-none"
        >
          <span className="flex-1 min-w-0">
            <span className={`block ${ROW_LABEL_CLASS}`}>Public profile</span>
            <span id="public-profile-visibility" className={`block text-xs ${controls.visibilityClass}`}>
              {controls.visibility}
            </span>
          </span>
          <Switch
            id="public-profile-publish"
            className="shrink-0 disabled:opacity-60"
            aria-describedby="public-profile-visibility"
            checked={published}
            disabled={publishing}
            onChange={() => { void Profile._setPublished(!published); }}
          />
        </label>
        {published ? (
          <a
            href={controls.openHref}
            className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
            onClick={() => Profile._dismissSheet()}
          >
            Open public page
          </a>
        ) : null}
        {published ? (
          <button
            type="button"
            className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
            onClick={() => { void Profile.copyPublicLink(controls.openHref); }}
          >
            Copy public link
          </button>
        ) : null}
        <button
          id="public-profile-preview-toggle"
          type="button"
          aria-expanded={previewOpen}
          aria-controls="public-profile-preview"
          className={`${ROW_ACTION_CLASS} gap-3 text-zinc-900 dark:text-zinc-100`}
          onClick={() => Profile.togglePreview()}
        >
          <span className="flex-1 text-left font-normal">What&apos;s on it</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={previewOpen
              ? 'w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 rotate-180 transition-transform'
              : 'w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 transition-transform'}
          />
        </button>
      </Group>
      {controls.moderationDisabled ? (
        <p className="px-4 mt-1.5 text-xs text-red-700 dark:text-red-400">
          You can keep editing or turn it off, but the public page stays unavailable.
        </p>
      ) : null}
      <p className={status ? FOOTNOTE_CLASS : 'px-4 text-xs text-zinc-500 dark:text-zinc-400'} role="status" aria-live="polite">{status}</p>
      <div id="public-profile-preview" className={previewOpen ? 'mt-3' : 'hidden mt-3'}>
        {previewOpen ? (
          <>
            <p className="px-4 mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Only your username, display name, bio, Homeroom-hosted photo and
              verified social accounts. Never your email, wallet, roles,
              memberships, unverified handles or private activity. Changes take
              effect at once, and nobody can search for the page.
            </p>
            <PublicProfileCard profile={controls.profile} allowReport={false} />
          </>
        ) : null}
      </div>
    </section>
  );
}

export function ProfileEditSheet({
  avatarUrl,
  initial,
  publicControls = null,
  publicStatus = '',
  publishing = false,
  previewOpen = false,
}: {
  avatarUrl: string | null;
  initial: string;
  publicControls?: any;
  publicStatus?: string;
  publishing?: boolean;
  previewOpen?: boolean;
}): ReactNode {
  const user = (Profile as unknown as { _user(): Record<string, unknown> })._user();
  const links = (user.links || {}) as Record<string, string>;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // What Back left behind the last time, if anything (QA 2026-09-24 Q16):
  // see Profile._draft. Taken once, by the opening render.
  const [draft] = useState(() => (Profile as unknown as {
    takeDraft?: () => { displayName: string; bio: string } | null;
  }).takeDraft?.() ?? null);
  const [name, setName] = useState(draft ? draft.displayName : String(user.displayName || ''));
  const [bio, setBio] = useState(draft ? draft.bio : String(user.bio || ''));

  // The fields as they stand, for Profile._dismissSheet to keep when the card
  // closes by Back rather than by a decision.
  const fields = useRef({ displayName: name, bio });
  fields.current = { displayName: name, bio };
  useIsomorphicLayoutEffect(() => {
    const host = Profile as unknown as { _draftSource: null | (() => { displayName: string; bio: string }) };
    const read = () => ({ ...fields.current });
    host._draftSource = read;
    return () => {
      if (host._draftSource === read) host._draftSource = null;
    };
  }, []);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRemove, setShowRemove] = useState(!!user.avatarUrl);

  // Hand the card to the native kit, exactly once, and put it back before
  // React ever tries to remove it.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      // The backdrop or Escape: a dismissal, not a decision, so what was
      // typed is kept for the next open, as Back keeps it.
      //
      // The teardown below dismisses the kit as well, and its callback lands
      // here after the exit fade. That close has already happened (and a
      // reopen inside the fade must not be closed by it), so it is ignored:
      // the teardown clears `adoption` before it dismisses.
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        Profile._dismissSheet({ keepDraft: true });
      },
    });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.restore();
      handle.dismiss();
    };
  }, []);

  // The staged photo's object URL is revoked by Profile._clearPendingAvatar;
  // closing the card any other way (route change, a second showEditSheet) goes
  // through _dismissSheet, which calls it. So there is nothing for this
  // component to tear down beyond the kit adoption above.

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
        || 'That image could not be used. Try a PNG, JPEG or WebP.');
    }
  };

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    const result = await Profile._save({
      displayName: name, bio,
    });
    if (result.ok) return;
    if (result.fieldErrors) setFieldErrors(result.fieldErrors);
    else setFormError(result.error || 'Could not save your profile.');
    setSaving(false);
  };

  return (
    <div id="profile-edit-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-edit-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="text-lg font-bold pt-3 pb-4">Edit profile</div>

        {/*
            The file input lives OUTSIDE .un-group on purpose: it is a real
            child wherever it sits, and a non-row child between two rows breaks
            the `.un-group-row + .un-group-row` hairline.
        */}
        <input
          id="profile-edit-file"
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={() => { void onFile(); }}
        />

        <section className="mb-4">
          <Group title="Photo">
            <div className="un-group-row flex items-center gap-3 px-4 py-2.5">
              <div id="profile-edit-preview" className="shrink-0">
                <Avatar url={avatarUrl} initial={initial} />
              </div>
              <div className="min-w-0">
                <div className={ROW_LABEL_CLASS}>Profile photo</div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  PNG, JPEG or WebP.
                </p>
              </div>
            </div>
            <button
              id="profile-edit-choose"
              className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
              onClick={() => fileRef.current?.click()}
            >
              Change photo
            </button>
            <button
              id="profile-edit-remove"
              className={
                showRemove
                  ? `${ROW_ACTION_CLASS} text-red-700 dark:text-red-400`
                  : `${ROW_ACTION_CLASS} text-red-700 dark:text-red-400 hidden`
              }
              onClick={() => { Profile.stageAvatarRemoval(); setShowRemove(false); }}
            >
              Remove photo
            </button>
          </Group>
          <p
            id="profile-edit-photo-error"
            className={photoError
              ? 'px-4 mt-1.5 text-xs text-red-700 dark:text-red-400'
              : 'px-4 mt-1.5 text-xs text-red-700 hidden dark:text-red-400'}
          >
            {photoError || ''}
          </p>
        </section>

        <section className="mb-4">
          <Group title="Your name">
            <div className={ROW_CLASS}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor="profile-edit-name" className={`${ROW_LABEL_CLASS} flex-1`}>
                  Display name
                </Label>
                <span className={COUNTER_CLASS}>
                  {`${name.length}/${Profile.MAX_DISPLAY_NAME}`}
                </span>
              </div>
              <Input
                id="profile-edit-name"
                type="text"
                box="groupRow"
                ring={false}
                value={name}
                maxLength={Profile.MAX_DISPLAY_NAME}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </Group>
          <p className={FOOTNOTE_CLASS}>
            The name other people see. Leave it empty to show your @handle.
          </p>
          <FieldError message={fieldErrors.displayName} />
        </section>

        <section className="mb-4">
          <Group title="About">
            <div className={ROW_CLASS}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor="profile-edit-bio" className={`${ROW_LABEL_CLASS} flex-1`}>
                  Bio
                </Label>
                <span className={COUNTER_CLASS}>
                  {`${bio.length}/${Profile.MAX_BIO}`}
                </span>
              </div>
              <Textarea
                id="profile-edit-bio"
                rows={3}
                box="groupRow"
                ring={false}
                className="resize-none"
                value={bio}
                maxLength={Profile.MAX_BIO}
                onChange={(e) => setBio(e.target.value)}
              />
            </div>
          </Group>
          <FieldError message={fieldErrors.bio} />
        </section>

        {publicControls ? (
          <PublicPage
            controls={publicControls}
            status={publicStatus}
            publishing={publishing}
            previewOpen={previewOpen}
          />
        ) : null}

        <section className="mb-4">
          <Group title="Verified social accounts">
            <div id="profile-edit-github" className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <span className={`${ROW_LABEL_CLASS} flex-1 min-w-0`}>GitHub</span>
              {links.github ? (
                <span className="text-right min-w-0">
                  <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700 dark:text-emerald-400">
                    Verified
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {String(links.github)}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Not shown</span>
              )}
            </div>
            <div id="profile-edit-x" className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <span className={`${ROW_LABEL_CLASS} flex-1 min-w-0`}>X</span>
              {links.x ? (
                <span className="text-right min-w-0">
                  <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700 dark:text-emerald-400">
                    Verified
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {`@${String(links.x)}`}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Not shown</span>
              )}
            </div>
            <a
              href="#settings/connectors"
              className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
              onClick={() => Profile._dismissSheet()}
            >
              Connect or change social accounts
            </a>
          </Group>
          <p className={FOOTNOTE_CLASS}>
            Provider verification and public visibility are managed separately in Settings.
          </p>
        </section>

        {/*
            The username is not editable HERE. It is the sign-in identifier, so
            changing it needs the current password — a credential prompt
            has no business in a sheet that also edits a bio, and the rename has
            its own cooldown and confirmation copy. It lives in
            Settings -> Username (features/settings/sections/username.tsx).

            Still shown read-only, and still WITH the reason: a greyed-out field
            with no explanation reads as a bug. The footnote is now a route, not
            a refusal.
        */}
        <section className="mb-4">
          <Group title="Username">
            <div className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <Label htmlFor="profile-edit-username" className={`${ROW_LABEL_CLASS} shrink-0`}>
                Username
              </Label>
              <Input
                id="profile-edit-username"
                type="text"
                box="groupRow"
                ring={false}
                width="flex"
                className="text-right text-zinc-500 dark:text-zinc-500 cursor-not-allowed"
                value={user.username ? `@${user.username}` : ''}
                readOnly
                disabled
              />
            </div>
          </Group>
          <p className={FOOTNOTE_CLASS}>
            {'Your @handle is your sign-in name and your public page address. To change it, go to '}
            <a href="#settings/username" className="text-violet-700 hover:text-violet-400 dark:text-violet-400">Settings → Username</a>
            {'. To change only how your name appears, set a display name above.'}
          </p>
        </section>

        <section className="mb-4">
          <Group title="Account email">
            <a href="#settings/email" className={ROW_ACTION_CLASS} onClick={() => Profile._dismissSheet()}>
              Email &amp; recovery
            </a>
          </Group>
          <p className={FOOTNOTE_CLASS}>Add or verify a private email address in Settings.</p>
        </section>

        <p
          id="profile-edit-error"
          className={formError ? 'text-sm text-red-700 mb-2 dark:text-red-400' : 'text-sm text-red-700 mb-2 hidden dark:text-red-400'}
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
    </div>
  );
}
