import { encryptPhoto, encryptVideo } from './crypto/photo';
import { toB64 } from './crypto/sodium';
import { api } from './api';

// Re-encoding through a canvas strips ALL metadata (EXIF GPS, device model,
// timestamps) before anything is encrypted or uploaded.
async function reencode(file: File, maxDim: number, quality: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality)
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// Encrypt a recorded clip into independent chunks, upload them, register.
export async function shareVideo(
  video: File,
  poster: File,
  durationS: number,
  albumId: string,
  albumKey: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const bytes = new Uint8Array(await video.arrayBuffer());
  const { chunks, wrappedVideoKeyB64 } = await encryptVideo(bytes, albumKey);
  const chunkBlobIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { blobId } = await api.uploadBlob(albumId, await toB64(chunks[i]!));
    chunkBlobIds.push(blobId);
    onProgress?.(i + 1, chunks.length);
  }
  const posterSmall = await reencode(poster, 400, 0.7);
  const encThumb = await encryptPhoto(posterSmall, albumKey);
  await api.registerVideo(albumId, {
    chunkBlobIds,
    thumbB64: await toB64(encThumb.blob),
    wrappedVideoKeyB64,
    wrappedThumbKeyB64: encThumb.wrappedPhotoKeyB64,
    durationS,
  });
}

export async function shareFile(file: File, albumId: string, albumKey: Uint8Array): Promise<void> {
  const [full, thumb] = await Promise.all([
    reencode(file, 2560, 0.85),
    reencode(file, 400, 0.7),
  ]);
  const encFull = await encryptPhoto(full, albumKey);
  const encThumb = await encryptPhoto(thumb, albumKey);
  await api.uploadPhoto(albumId, {
    photoB64: await toB64(encFull.blob),
    thumbB64: await toB64(encThumb.blob),
    wrappedPhotoKeyB64: encFull.wrappedPhotoKeyB64,
    wrappedThumbKeyB64: encThumb.wrappedPhotoKeyB64,
  });
}
