// Keep the primary exposure, its colour profile and its EXIF orientation.
// iPhone and Ultra HDR JPEGs can carry a second image that boosts highlights.
export async function galleryJpegBase(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return file;
  const parts = [];
  let start = 0;
  let hasGainMapContainer = false;
  let pos = 2;
  while (pos < bytes.length) {
    const markerStart = bytes.indexOf(0xff, pos);
    if (markerStart < 0) break;
    pos = markerStart + 1;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) {
      if (!hasGainMapContainer) return file;
      parts.push(bytes.subarray(start, pos));
      return new Blob(parts, { type: 'image/jpeg' });
    }
    if (marker === 1) continue;
    const length = bytes[pos] * 256 + bytes[pos + 1];
    if (!(length >= 2) || pos + length > bytes.length) break;
    if (marker === 0xe2 || marker === 0xe1) {
      const prefix = String.fromCharCode(...bytes.subarray(pos + 2, Math.min(pos + length, pos + 64)));
      const mpf = marker === 0xe2 && prefix.startsWith('MPF\0');
      const gainMetadata = marker === 0xe2 && prefix.startsWith('urn:iso:std:iso:ts:21496');
      const xmp = marker === 0xe1 && prefix.startsWith('http://ns.adobe.com/');
      if (mpf || gainMetadata || xmp) {
        parts.push(bytes.subarray(start, markerStart));
        start = pos + length;
        hasGainMapContainer ||= mpf || gainMetadata;
      }
    }
    pos += length;
    // Ordinary JPEGs do not need a scan through the compressed pixels.
    if (marker === 0xda && !hasGainMapContainer) return file;
  }
  return file;
}

export async function prepareGalleryPhoto(file) {
  const source = file.type === 'image/jpeg' ? await galleryJpegBase(file) : file;
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = type => new Promise(resolve => canvas.toBlob(resolve, type, 0.93));
    let photo = await encode('image/webp');
    if (photo?.type === 'image/png' && file.type === 'image/jpeg') photo = await encode('image/jpeg');
    if (!photo || photo.size > 10485760 || !['image/webp', 'image/jpeg', 'image/png'].includes(photo.type)) {
      throw new Error('Não foi possível preparar a fotografia para a galeria.');
    }
    return photo;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
