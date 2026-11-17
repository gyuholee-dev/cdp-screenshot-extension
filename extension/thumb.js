// The thumbnail of a history entry: the card shows this small image instead of the whole shot (a shot
// can be 2560×16384px: decoding that for every card slows the panel down). Its size is limited by the
// number of pixels, not by width or height, so a tall shot gets a narrow thumbnail and a wide one a
// wide one, and each takes about the same memory.
export const THUMB_MAX_PIXELS = 500000;

/** Pure: the thumbnail's size for an image of `width`×`height`: same proportions, at most `maxPixels` pixels, never larger than the image. */
export function thumbSize(width, height, maxPixels = THUMB_MAX_PIXELS) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

/** A WebP thumbnail of `blob` (an image of `width`×`height`px). */
export async function makeThumb(blob, width, height) {
  const size = thumbSize(width, height);
  const bmp = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } finally {
    bmp.close();
  }
}
