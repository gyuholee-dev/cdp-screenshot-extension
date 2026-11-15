// Clipboard write from the panel (an extension page: secure context). The browser only allows it
// while the panel document has focus, e.g. right after a click in it.

/** Clipboards take PNG for images: convert other formats. */
export async function toPngBlob(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function copyImage(blob) {
  const png = await toPngBlob(blob);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
