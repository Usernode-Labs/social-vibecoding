/**
 * "Upload a project archive": the make screen's third form (./make.tsx), what
 * its small "Upload a project archive" link under Make it opens from the
 * Create button (#6994), and what #create/archive opens directly.
 *
 * The person chooses a .zip, .tar.gz, .tgz, .rar or .7z of a website they
 * already have. The file is sent straight away (POST /api/apps/archive,
 * raw bytes), which checks it and answers the number of files it found and
 * whether it has an index.html. Nothing is created until "Upload it" is
 * pressed: the create request then names the upload's id, and the project's
 * setup writes its files as the first commit.
 *
 * It looks and behaves like the GitHub import form it stands beside
 * (./import-repo.tsx): the same card, the same two fields, the same link
 * back to describing a new project.
 */

import { type ReactNode, useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SpinnerArcIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';

/** The same cap the server enforces (services/archive-import.js). */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export const ARCHIVE_ACCEPT = '.zip,.tar.gz,.tgz,.rar,.7z,application/zip,application/gzip,application/x-rar-compressed,application/x-7z-compressed';

export type ArchiveCheck =
  | { ok: true; id: string; fileCount: number; name: string }
  | { ok: false; error: string };

/** The name an archive opens on: its file's name without the archive extension. */
export function archiveBaseName(filename: string): string {
  const base = String(filename || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.(?:tar\.gz|tgz|zip|rar|7z)$/i, '').trim().slice(0, 120);
}

/**
 * POST /api/apps/archive with the chosen file. The size and extension are
 * checked first, so a file the server would refuse says so without a
 * request. Never throws.
 */
export async function uploadArchive(file: File, fetcher: typeof fetch = fetch): Promise<ArchiveCheck> {
  if (file.size > MAX_ARCHIVE_BYTES) return { ok: false, error: translate('onboarding:firstSession.archive.error.tooBig') };
  if (!/\.(?:tar\.gz|tgz|zip|rar|7z)$/i.test(file.name)) return { ok: false, error: translate('onboarding:firstSession.archive.error.type') };
  let res: Response;
  try {
    res = await fetcher(`/api/apps/archive?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    return { ok: false, error: translate('onboarding:firstSession.archive.error.network') };
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* a non-JSON body is reported through the HTTP status below */
  }
  if (!res.ok) {
    return { ok: false, error: (typeof data.error === 'string' && data.error) || translate('onboarding:firstSession.archive.error.network') };
  }
  return {
    ok: true,
    id: String(data.id || ''),
    fileCount: Number(data.fileCount) || 0,
    name: String(data.name || ''),
  };
}

export type ArchiveMissing = 'file' | 'name' | null;

/** The first answer "Upload it" still needs; null when a checked file and a name are there. */
export function archiveMissing(checked: boolean, name: string): ArchiveMissing {
  if (!checked) return 'file';
  if (!name.trim()) return 'name';
  return null;
}

export type ArchiveUploaded = { archive: string; name: string; fileCount: number };

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
const HINT = 'pb-1 text-xs text-zinc-500 dark:text-zinc-400';
const NEEDED = 'pb-1 text-xs text-red-700 dark:text-red-400';
const OK = 'pb-1 text-xs text-emerald-700 dark:text-emerald-400';

type CheckState = 'idle' | 'uploading' | 'ok' | 'error';

/**
 * The before/after shots cannot drive a file picker, so `?shot=archive-ok`,
 * `?shot=archive-error` and `?shot=archive-uploading` open the form on that
 * state for the capture (the platform's `?shot=` convention). Nothing is
 * sent and nothing is created: the state is drawn only.
 */
function shotCheck(): { state: CheckState; status: string; file: string; name: string } | null {
  if (typeof window === 'undefined') return null;
  let shot = '';
  try { shot = new URLSearchParams(window.location.search).get('shot') || ''; } catch { return null; }
  if (shot === 'archive-uploading') {
    return { state: 'uploading', status: translate('onboarding:firstSession.archive.uploading'), file: 'ghost-site.zip', name: '' };
  }
  if (shot === 'archive-ok') {
    return {
      state: 'ok',
      status: translate('onboarding:firstSession.archive.found_other', { count: 42 }),
      file: 'ghost-site.zip',
      name: 'ghost-site',
    };
  }
  if (shot === 'archive-error') {
    return { state: 'error', status: 'There is no index.html at the top of this archive.', file: 'ghost-site.zip', name: '' };
  }
  return null;
}

/**
 * The form, inside the make screen's frame: its `className` is the make
 * form's own and `header` its heading, so the three forms stand in the same
 * place. `submit` posts the create with the upload's id and answers an error
 * to show, or null once it has handed the project on.
 */
export function ArchiveForm({ className, header, submit, onDescribe, allowance, blocked = false }: {
  className: string;
  header: ReactNode;
  /** At the allowance's limit: Upload it is pale (the make screen's rule). */
  blocked?: boolean;
  submit: (upload: ArchiveUploaded) => Promise<string | null>;
  /** "Describe a new project instead": back to Make it. */
  onDescribe: () => void;
  allowance?: ReactNode;
}) {
  const t = useMessages('onboarding');
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const shot = useRef(shotCheck()).current;
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<{ id: string; fileCount: number } | null>(null);
  const [name, setName] = useState(shot?.name || '');
  const [nameTyped, setNameTyped] = useState(false);
  const [state, setState] = useState<CheckState>(shot?.state || 'idle');
  const [status, setStatus] = useState(shot?.status || '');
  const [missing, setMissing] = useState<ArchiveMissing>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const choose = useCallback(() => {
    // The same file chosen again must fire `change` too.
    if (fileRef.current) fileRef.current.value = '';
    fileRef.current?.click();
  }, []);

  const check = useCallback(async (chosen: File) => {
    setFile(chosen);
    setChecked(null);
    setState('uploading');
    setStatus(translate('onboarding:firstSession.archive.uploading'));
    setMissing(null);
    setError(null);
    const result = await uploadArchive(chosen);
    if (!result.ok) {
      setState('error');
      setStatus(result.error);
      return;
    }
    setChecked({ id: result.id, fileCount: result.fileCount });
    setState('ok');
    setStatus(translate(result.fileCount === 1
      ? 'onboarding:firstSession.archive.found_one'
      : 'onboarding:firstSession.archive.found_other', { count: result.fileCount }));
    // The name opens on the file's own, unless one was already typed.
    if (!nameTyped) setName(result.name || archiveBaseName(chosen.name));
  }, [nameTyped]);

  const go = useCallback(async () => {
    if (busy || busyRef.current) return;
    const gap = archiveMissing(!!checked, name);
    if (gap) {
      setMissing(gap);
      (gap === 'file' ? fileRef.current : nameRef.current)?.focus({ preventScroll: true });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const failed = await submit({ archive: checked!.id, name: name.trim(), fileCount: checked!.fileCount });
      if (failed) setError(failed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [busy, checked, name, submit]);

  return (
    <form data-make-archive="" className={className} onSubmit={(e) => { e.preventDefault(); void go(); }}>
      {header}
      <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <div className={FIELD}>
          <label htmlFor="make-archive-choose" className={LABEL}>{t('onboarding:firstSession.archive.fileLabel')}</label>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate py-1 font-mono text-[15px] text-zinc-900 dark:text-zinc-100">
              {file ? file.name : shot?.file || ''}
            </p>
            <input
              ref={fileRef}
              id="make-archive-choose"
              data-make-archive-file=""
              type="file"
              accept={ARCHIVE_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) void check(chosen);
              }}
            />
            <button
              type="button"
              data-make-archive-check=""
              onClick={choose}
              disabled={state === 'uploading'}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-zinc-100 px-3.5 text-[14px] font-semibold text-zinc-900 disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {file || shot?.file ? t('onboarding:firstSession.archive.chooseAnother') : t('onboarding:firstSession.archive.choose')}
            </button>
          </div>
          <p
            id="make-archive-status"
            role="status"
            data-archive-state={state}
            className={state === 'error' || missing === 'file' ? NEEDED : state === 'ok' ? OK : HINT}
          >
            {state === 'uploading' ? <SpinnerArcIcon className="me-1.5 inline-block h-3.5 w-3.5 animate-spin align-[-2px]" aria-hidden="true" /> : null}
            {missing === 'file' && state !== 'error' ? t('onboarding:firstSession.archive.needed.file') : (status || t('onboarding:firstSession.archive.limits'))}
          </p>
        </div>
        <div className={FIELD}>
          <label htmlFor="make-archive-name" className={LABEL}>{t('onboarding:firstSession.import.nameLabel')}</label>
          <input
            ref={nameRef}
            id="make-archive-name"
            type="text"
            autoComplete="off"
            enterKeyHint="go"
            value={name}
            aria-describedby={missing === 'name' ? 'make-archive-name-hint' : undefined}
            onChange={(e) => { setName(e.target.value); setNameTyped(e.target.value.trim() !== ''); setMissing(null); setError(null); }}
            placeholder={t('onboarding:firstSession.import.namePlaceholder')}
            className={INPUT}
          />
          {missing === 'name' ? <p id="make-archive-name-hint" role="alert" className={NEEDED}>{t('onboarding:firstSession.archive.needed.name')}</p> : null}
        </div>
      </div>
      {allowance}
      {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="grow" />
      <Button
        type="submit"
        disabled={busy || blocked}
        layout="full"
        variant="pillAccent"
        size="pillLg"
        ink="solidLate"
        className="mt-6 flex items-center justify-center disabled:opacity-50"
      >
        {busy ? t('onboarding:firstSession.archive.submitting') : t('onboarding:firstSession.archive.submit')}
      </Button>
      <p className="mt-3 text-center">
        <button type="button" data-make-describe="" onClick={onDescribe} className="inline-flex min-h-[44px] items-center px-2 text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400">
          {t('onboarding:firstSession.import.describeInstead')}
        </button>
      </p>
    </form>
  );
}
