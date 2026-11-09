'use strict';

import { useId, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';

// Images in an email template. An admin uploads a file (POST
// /api/admin/email-images, src/routes/email-images.js), which Homeroom keeps
// and serves at a public https address a mail client can load, or pastes an
// https address of their own. Either way the template holds an ordinary
// <img> with that address, an alt text and an optional width, which the
// server's check (src/services/mail/html-safety.js) requires to be https and
// to carry an alt.
//
// The Visual tab puts the image in its own paragraph after the block being
// edited (ImagePanel); the HTML tab puts the tag at the cursor (UploadImageButton).

export const MAX_IMAGE_BYTES = 1024 * 1024;
const UPLOAD_URL = '/api/admin/email-images';
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
// Fills a narrow mail column without overflowing it, and drops the border old
// clients draw around a linked image.
export const IMAGE_STYLE = 'display:block;max-width:100%;height:auto;border:0';
const MAX_WIDTH = 2000;

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ImageFields { src: string; alt: string; width: string }

/** Why `src` cannot be an image's address, or null. */
export function imageProblem(src: string): string | null {
  if (/^https:\/\/[^\s"<>]+$/i.test(src.trim())) return null;
  return 'Upload an image, or use a web address that starts with https://.';
}

/** Why `width` cannot be an image's width, or null. Empty means its own width. */
export function widthProblem(width: string): string | null {
  const w = width.trim();
  if (!w) return null;
  if (/^\d+$/.test(w) && Number(w) >= 1 && Number(w) <= MAX_WIDTH) return null;
  return `Give the width as a whole number of pixels, from 1 to ${MAX_WIDTH}, or leave it empty.`;
}

/** The <img> a template holds. */
export function imageTag({ src, alt, width }: ImageFields): string {
  const w = width.trim() ? ` width="${Number(width.trim())}"` : '';
  return `<img src="${escapeAttr(src.trim())}" alt="${escapeAttr(alt.trim())}"${w} style="${IMAGE_STYLE}">`;
}

/** The image as the Visual tab inserts it: its own paragraph, so the blocks around it stay as they were. */
export const imageSnippet = (fields: ImageFields) => `<p>${imageTag(fields)}</p>`;

/** `source` with `text` in place of the range from `start` to `end`. */
export function insertAt(source: string, start: number, end: number, text: string): string {
  const a = Math.max(0, Math.min(start, source.length));
  const b = Math.max(a, Math.min(end, source.length));
  return source.slice(0, a) + text + source.slice(b);
}

export type UploadResult = { ok: true; url: string } | { ok: false; error: string };
export type Uploader = (file: File, onProgress: (percent: number) => void) => Promise<UploadResult>;

function refusal(status: number, body: any): string {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  if (status === 0) return 'Could not reach the platform. Nothing was uploaded; try again.';
  if (status === 403) return 'Uploading images needs full admin access.';
  if (status === 413) return 'The image must be 1 MB or smaller.';
  return 'The image could not be uploaded. Try again.';
}

/**
 * Sends `file` as the request body, reporting progress as a percentage. Never
 * throws. A file over 1 MB is refused here, before it is sent.
 */
export const uploadImage: Uploader = (file, onProgress) => {
  if (file.size > MAX_IMAGE_BYTES) return Promise.resolve({ ok: false, error: 'The image must be 1 MB or smaller.' });
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${UPLOAD_URL}?filename=${encodeURIComponent(file.name || '')}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && ev.total) onProgress(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      if (xhr.status === 201 && body && typeof body.url === 'string') resolve({ ok: true, url: body.url });
      else resolve({ ok: false, error: refusal(xhr.status, body) });
    };
    xhr.onerror = () => resolve({ ok: false, error: refusal(0, null) });
    xhr.send(file);
  });
};

const NOTICE = 'rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300';
const HINT = 'text-zinc-500 dark:text-zinc-400';

/** Upload progress, or the refusal, as one line under the control. */
function UploadStatus({ progress, error }: { progress: number | null; error: string | null }) {
  return (
    <>
      {progress != null ? <p role="status" className={`text-xs ${HINT}`}>{`Uploading… ${progress}%`}</p> : null}
      {error ? <p role="alert" className={NOTICE}>{error}</p> : null}
    </>
  );
}

/**
 * The Visual tab's image panel: upload a file or paste an https address,
 * then alt text and width. `onInsert` gets the fields once they are good.
 * `initial` sets where it starts, for a render test.
 */
export function ImagePanel({ onInsert, onCancel, upload = uploadImage, initial }: {
  onInsert: (fields: ImageFields) => void;
  onCancel: () => void;
  upload?: Uploader;
  initial?: Partial<ImageFields & { progress: number | null; error: string | null }>;
}) {
  const [fields, setFields] = useState<ImageFields>({ src: initial?.src ?? '', alt: initial?.alt ?? '', width: initial?.width ?? '' });
  const [progress, setProgress] = useState<number | null>(initial?.progress ?? null);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const altHint = useId();
  const uploading = progress != null;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    const result = await upload(file, setProgress);
    setProgress(null);
    if (result.ok) setFields((f) => ({ ...f, src: result.url }));
    else setError(result.error);
  };

  const add = () => {
    const problem = imageProblem(fields.src) || widthProblem(fields.width);
    if (problem) { setError(problem); return; }
    setError(null);
    onInsert(fields);
  };

  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-2" role="group" aria-label="Add an image">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs min-w-0">
          <span className={HINT}>Upload an image (PNG, JPEG, GIF or WebP, up to 1 MB)</span>
          <input className="mt-1 block text-xs" type="file" accept={ACCEPT} disabled={uploading}
            onChange={(ev) => { void choose(ev.target.files ? ev.target.files[0] : undefined); ev.target.value = ''; }} />
        </label>
        <label className="text-xs min-w-0 flex-1">
          <span className={HINT}>Or its web address</span>
          <input className={`${AdminUI.input} mt-1`} type="url" placeholder="https://" value={fields.src} disabled={uploading}
            onChange={(ev) => setFields({ ...fields, src: ev.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs min-w-0 flex-1">
          <span className={HINT}>Alt text</span>
          <input className={`${AdminUI.input} mt-1`} value={fields.alt} aria-describedby={altHint}
            onChange={(ev) => setFields({ ...fields, alt: ev.target.value })} />
        </label>
        <label className="text-xs w-28">
          <span className={HINT}>Width in pixels</span>
          <input className={`${AdminUI.input} mt-1`} inputMode="numeric" placeholder="Its own" value={fields.width}
            onChange={(ev) => setFields({ ...fields, width: ev.target.value })} />
        </label>
        <div className="flex gap-2">
          <button type="button" className={AdminUI.btn.primarySm} disabled={uploading || !fields.src.trim()} onClick={add}>Add image</button>
          <button type="button" className={AdminUI.btn.outlineSm} onClick={onCancel}>Cancel</button>
        </div>
      </div>
      <p id={altHint} className={`text-xs ${HINT}`}>
        Alt text is what readers see when images are off. Leave it empty for an image that is only decoration.
      </p>
      <UploadStatus progress={progress} error={error} />
    </div>
  );
}

/**
 * The HTML tab's Upload image button: uploads a file and hands its <img> to
 * `onTag`, which puts it at the cursor. Its alt is empty until the admin
 * writes one in the HTML.
 */
export function UploadImageButton({ onTag, upload = uploadImage, initial }: {
  onTag: (tag: string) => void;
  upload?: Uploader;
  initial?: { progress?: number | null; error?: string | null };
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<number | null>(initial?.progress ?? null);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const uploading = progress != null;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    const result = await upload(file, setProgress);
    setProgress(null);
    if (result.ok) onTag(imageTag({ src: result.url, alt: '', width: '' }));
    else setError(result.error);
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={AdminUI.btn.outlineSm} disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload image'}
        </button>
        <span className={`text-xs ${HINT}`}>Puts an image at the cursor. Write what it shows in its alt.</span>
        <input ref={input} className="hidden" type="file" accept={ACCEPT} aria-label="Image file to upload" tabIndex={-1}
          onChange={(ev) => { void choose(ev.target.files ? ev.target.files[0] : undefined); ev.target.value = ''; }} />
      </div>
      <UploadStatus progress={progress} error={error} />
    </div>
  );
}
