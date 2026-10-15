import { t } from './i18n/runtime';

/** Same browser decode / canvas re-encode pattern as profile photos, preserving the full illustration and transparency. */
export async function prepareIllustration(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error(t('core:illustration.error.type'));
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t('core:illustration.error.unreadable')));
      img.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(t('core:illustration.error.noSize'));
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t('core:illustration.error.noCanvas'));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    // Repaint from the original at every size; retain alpha for brand artwork.
    while (blob && blob.size > 1024 * 1024 && canvas.width > 64 && canvas.height > 64) {
      canvas.width = Math.max(1, Math.floor(canvas.width / 2));
      canvas.height = Math.max(1, Math.floor(canvas.height / 2));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    }
    if (!blob || blob.size > 1024 * 1024) throw new Error(t('core:illustration.error.tooLarge'));
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
