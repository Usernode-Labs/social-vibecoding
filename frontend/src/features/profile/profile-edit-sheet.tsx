import { t as tr } from "../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
 *   node, so bringing it home there is what stops a `NotFoundError` on close.
 *   `release()` does that and leaves a snapshot in the kit's shell for the
 *   exit, which otherwise faded out an empty box where the card had been.
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
 *
 * ── A new photo is positioned before it is used (#3525) ───────────────
 *
 * Change photo used to stage the file's centred square the moment it was
 * picked. Now a picked file opens "Position your photo"
 * (./avatar-crop-dialog.tsx) over this card, and nothing is staged until its
 * Use photo. The Photo row's second line says where a photo change stands:
 * before a pick, that you choose the part that shows; after Use photo or
 * Remove photo, that it waits for Save. The step renders as the last child of
 * the root and this card is `inert` while it is up; the dialog's header says
 * why both.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDownIcon } from '@/components/ui/icons';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { returnKeyHandler } from '../../lib/return-to-next';
import type { CropRect } from './avatar-crop';
import { AvatarCropDialog, type CropSource } from './avatar-crop-dialog';
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

/**
 * The Photo row's second line: what choosing does, and then where a change
 * stands, because nothing about a staged photo is saved until Save (#3525).
 */
function photoNote(pending: 'new' | 'removed' | null): string {
  if (pending === 'new') return tr("account:new_photo_not_saved_yet_press_save_to_use_it_b4617917");
  if (pending === 'removed') return tr("account:your_photo_will_be_removed_when_you_press_save_62f36c7f");
  return tr("account:png_jpeg_or_webp_you_choose_the_part_that_shows__77d5a126");
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
      <Localized element={<Group title={catalogText("account:public_page_b191fca3")}>
        <label
          htmlFor="public-profile-publish"
          className="un-group-row flex items-center gap-3 px-4 py-2 min-h-[44px] cursor-pointer select-none"
        >
          <span className="flex-1 min-w-0">
            <span className={`block ${ROW_LABEL_CLASS}`}><Message id="account:public_profile_eaad68e1" /></span>
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
          ><Message id="account:open_public_page_193b919d" /></a>
        ) : null}
        {published ? (
          <button
            type="button"
            className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
            onClick={() => { void Profile.copyPublicLink(controls.openHref); }}
          ><Message id="account:copy_public_link_8a29ed34" /></button>
        ) : null}
        <button
          id="public-profile-preview-toggle"
          type="button"
          aria-expanded={previewOpen}
          aria-controls="public-profile-preview"
          className={`${ROW_ACTION_CLASS} gap-3 text-zinc-900 dark:text-zinc-100`}
          onClick={() => Profile.togglePreview()}
        >
          <span className="flex-1 text-left font-normal"><Message id="account:what_s_on_it_1e40e68d" /></span>
          <ChevronDownIcon
            aria-hidden="true"
            className={previewOpen
              ? 'w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 rotate-180 transition-transform'
              : 'w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 transition-transform'}
          />
        </button>
      </Group>} messages={{"title":"account:public_page_b191fca3"}} />
      {controls.moderationDisabled ? (
        <p className="px-4 mt-1.5 text-xs text-red-700 dark:text-red-400"><Message id="account:you_can_keep_editing_or_turn_it_off_but_the_publ_8358b8fa" /></p>
      ) : null}
      <p className={status ? FOOTNOTE_CLASS : 'px-4 text-xs text-zinc-500 dark:text-zinc-400'} role="status" aria-live="polite">{status}</p>
      <div id="public-profile-preview" className={previewOpen ? 'mt-3' : 'hidden mt-3'}>
        {previewOpen ? (
          <>
            <p className="px-4 mb-3 text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:only_your_username_display_name_bio_homeroom_hos_485767c0" /></p>
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
  cropSource = null,
  pendingPhoto = null,
}: {
  avatarUrl: string | null;
  initial: string;
  publicControls?: any;
  publicStatus?: string;
  publishing?: boolean;
  previewOpen?: boolean;
  /** The chosen photo while "Position your photo" is up (#3525). */
  cropSource?: CropSource | null;
  /** A staged photo change that Save has not written yet. */
  pendingPhoto?: 'new' | 'removed' | null;
}): ReactNode {
  useUiLanguage();
  const user = (Profile as unknown as { _user(): Record<string, unknown> })._user();
  const links = (user.links || {}) as Record<string, string>;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const chooseRef = useRef<HTMLButtonElement | null>(null);

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
      handle.release();
    };
  }, []);

  // The staged photo's object URL is revoked by Profile._clearPendingAvatar;
  // closing the card any other way (route change, a second showEditSheet) goes
  // through _dismissSheet, which calls it. So there is nothing for this
  // component to tear down beyond the kit adoption above.

  // While the positioning step is up this card is `inert` (see the dialog's
  // header), which takes focus off anything inside it. When the step closes,
  // focus comes back to Change photo, where the viewer left it.
  const cropping = !!cropSource;
  const wasCropping = useRef(cropping);
  useEffect(() => {
    if (wasCropping.current && !cropping) chooseRef.current?.focus({ preventScroll: true });
    wasCropping.current = cropping;
  }, [cropping]);

  const photoFailed = (err: unknown): void => {
    setPhotoError((err instanceof Error && err.message)
      || tr("account:that_image_could_not_be_used_try_a_png_jpeg_or_w_37d52c13"));
  };

  // A picked file opens the positioning step; nothing is staged yet (#3525).
  const onFile = async (): Promise<void> => {
    const input = fileRef.current;
    const chosen = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!chosen) return;
    setPhotoError(null);
    try {
      await Profile.beginAvatarCrop(chosen);
    } catch (err) {
      photoFailed(err);
    }
  };

  // Use photo: the square the viewer chose is cut, downscaled and staged.
  const onCropAccept = async (crop: CropRect): Promise<void> => {
    setPhotoError(null);
    try {
      if (await Profile.acceptAvatarCrop(crop)) setShowRemove(true);
    } catch (err) {
      photoFailed(err);
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
    else setFormError(result.error || tr("account:could_not_save_your_profile_2453823b"));
    setSaving(false);
  };

  return (
    <div id="profile-edit-root" ref={rootRef} className={ROOT_CLASS}>
      {/* Return in the name goes on to the bio, where it is a new line
          (#3907: the iOS keyboard's chevrons are gone). */}
      <div id="profile-edit-sheet" ref={panelRef} className={CARD_CLASS} inert={cropping} onKeyDown={returnKeyHandler()}>
        <div className="text-lg font-bold pt-3 pb-4"><Message id="account:edit_profile_15c4aa13" /></div>

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
          <Localized element={<Group title={catalogText("account:photo_d84eebad")}>
            <div className="un-group-row flex items-center gap-3 px-4 py-2.5">
              <div id="profile-edit-preview" className="shrink-0">
                <Avatar url={avatarUrl} initial={initial} />
              </div>
              <div className="min-w-0">
                <div className={ROW_LABEL_CLASS}><Message id="account:profile_photo_ac8a7318" /></div>
                <p id="profile-edit-photo-note" className="text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
                  {photoNote(pendingPhoto)}
                </p>
              </div>
            </div>
            <button
              id="profile-edit-choose"
              ref={chooseRef}
              className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
              onClick={() => fileRef.current?.click()}
            ><Message id="account:change_photo_c5fbcb8b" /></button>
            <button
              id="profile-edit-remove"
              className={
                showRemove
                  ? `${ROW_ACTION_CLASS} text-red-700 dark:text-red-400`
                  : `${ROW_ACTION_CLASS} text-red-700 dark:text-red-400 hidden`
              }
              onClick={() => { Profile.stageAvatarRemoval(); setShowRemove(false); }}
            ><Message id="account:remove_photo_f46512ab" /></button>
          </Group>} messages={{"title":"account:photo_d84eebad"}} />
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
          <Localized element={<Group title={catalogText("account:your_name_2c6b2e25")}>
            <div className={ROW_CLASS}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor="profile-edit-name" className={`${ROW_LABEL_CLASS} flex-1`}><Message id="account:display_name_2b7f6a84" /></Label>
                <span className={COUNTER_CLASS}>
                  {`${name.length}/${Profile.MAX_DISPLAY_NAME}`}
                </span>
              </div>
              <Input
                id="profile-edit-name"
                type="text"
                enterKeyHint="next"
                box="groupRow"
                ring={false}
                value={name}
                maxLength={Profile.MAX_DISPLAY_NAME}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </Group>} messages={{"title":"account:your_name_2c6b2e25"}} />
          <p className={FOOTNOTE_CLASS}><Message id="account:the_name_other_people_see_leave_it_empty_to_show_657568dc" /></p>
          <FieldError message={fieldErrors.displayName} />
        </section>

        <section className="mb-4">
          <Localized element={<Group title={catalogText("account:about_4efca0d1")}>
            <div className={ROW_CLASS}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor="profile-edit-bio" className={`${ROW_LABEL_CLASS} flex-1`}><Message id="account:bio_3933b180" /></Label>
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
          </Group>} messages={{"title":"account:about_4efca0d1"}} />
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
          <Localized element={<Group title={catalogText("account:verified_social_accounts_0afe08e1")}>
            <div id="profile-edit-github" className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <span className={`${ROW_LABEL_CLASS} flex-1 min-w-0`}><Message id="account:github_f911e414" /></span>
              {links.github ? (
                <span className="text-right min-w-0">
                  <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700 dark:text-emerald-400"><Message id="account:verified_4f783840" /></span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {String(links.github)}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:not_shown_a08f0f94" /></span>
              )}
            </div>
            <div id="profile-edit-x" className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <span className={`${ROW_LABEL_CLASS} flex-1 min-w-0`}><Message id="account:x_4b68ab38" /></span>
              {links.x ? (
                <span className="text-right min-w-0">
                  <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700 dark:text-emerald-400"><Message id="account:verified_4f783840" /></span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {`@${String(links.x)}`}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="account:not_shown_a08f0f94" /></span>
              )}
            </div>
            <a
              href="#settings/linked-accounts"
              className={`${ROW_ACTION_CLASS} text-violet-700 dark:text-violet-400`}
              onClick={() => Profile._dismissSheet()}
            ><Message id="account:connect_or_change_social_accounts_60d4c4c2" /></a>
          </Group>} messages={{"title":"account:verified_social_accounts_0afe08e1"}} />
          <p className={FOOTNOTE_CLASS}><Message id="account:provider_verification_and_public_visibility_are__04555f6c" /></p>
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
          <Localized element={<Group title={catalogText("account:username_e3b89e9d")}>
            <div className="un-group-row flex items-center gap-3 px-4 min-h-[44px]">
              <Label htmlFor="profile-edit-username" className={`${ROW_LABEL_CLASS} shrink-0`}><Message id="account:username_e3b89e9d" /></Label>
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
          </Group>} messages={{"title":"account:username_e3b89e9d"}} />
          <p className={FOOTNOTE_CLASS}><RichMessage id="account:sentence_184b595b3dc7" components={[<a href="#settings/username" className="text-violet-700 hover:text-violet-400 dark:text-violet-400" />]} /></p>
        </section>

        <section className="mb-4">
          <Localized element={<Group title={catalogText("account:account_email_316ef5f9")}><RichMessage id="account:sentence_210692ef77d0" components={[<a href="#settings/email" className={ROW_ACTION_CLASS} onClick={() => Profile._dismissSheet()} />]} /></Group>} messages={{"title":"account:account_email_316ef5f9"}} />
          <p className={FOOTNOTE_CLASS}><Message id="account:add_or_verify_a_private_email_address_in_setting_46e5960b" /></p>
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
        ><Message id="account:save_1509f561" /></Button>
        <button
          className="w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400"
          onClick={() => Profile._dismissSheet()}
        ><Message id="account:cancel_19766ed6" /></button>
      </div>
      {/*
          LAST, after the card: the card has been lifted into the kit and a
          comment holds its place, so a sibling rendered before it would be
          inserted against a node that is not there. Keyed by the photo, so a
          second pick starts from its own centred square.
      */}
      {cropSource ? (
        <AvatarCropDialog
          key={cropSource.url}
          source={cropSource}
          onAccept={onCropAccept}
          onCancel={() => Profile.cancelAvatarCrop()}
        />
      ) : null}
    </div>
  );
}
