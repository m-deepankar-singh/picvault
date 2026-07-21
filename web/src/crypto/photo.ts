import { getSodium, toB64, fromB64 } from './sodium';
import { wrapWithKey, unwrapWithKey } from './keys';

// Each photo gets its own random key so members added later can be granted
// history by re-wrapping keys, never by re-encrypting blobs.
export async function encryptPhoto(
  plain: Uint8Array,
  albumKey: Uint8Array
): Promise<{ blob: Uint8Array; wrappedPhotoKeyB64: string }> {
  const sodium = await getSodium();
  const photoKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(plain, nonce, photoKey);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce);
  blob.set(ct, nonce.length);
  const wrappedPhotoKeyB64 = await wrapWithKey(photoKey, albumKey);
  return { blob, wrappedPhotoKeyB64 };
}

export async function decryptPhoto(
  blob: Uint8Array,
  wrappedPhotoKeyB64: string,
  albumKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const photoKey = await unwrapWithKey(wrappedPhotoKeyB64, albumKey);
  const nonce = blob.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ct = blob.slice(sodium.crypto_secretbox_NONCEBYTES);
  return sodium.crypto_secretbox_open_easy(ct, nonce, photoKey);
}

// Video: one random key per clip; each 4 MB chunk is sealed independently
// (own nonce), so playback can decrypt incrementally.
export const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;

export async function encryptVideo(
  plain: Uint8Array,
  albumKey: Uint8Array
): Promise<{ chunks: Uint8Array[]; wrappedVideoKeyB64: string }> {
  const sodium = await getSodium();
  const videoKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < plain.length; off += VIDEO_CHUNK_SIZE) {
    const part = plain.subarray(off, Math.min(off + VIDEO_CHUNK_SIZE, plain.length));
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(part, nonce, videoKey);
    const chunk = new Uint8Array(nonce.length + ct.length);
    chunk.set(nonce);
    chunk.set(ct, nonce.length);
    chunks.push(chunk);
  }
  const wrappedVideoKeyB64 = await wrapWithKey(videoKey, albumKey);
  return { chunks, wrappedVideoKeyB64 };
}

export async function decryptVideoChunk(
  chunk: Uint8Array,
  wrappedVideoKeyB64: string,
  albumKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const videoKey = await unwrapWithKey(wrappedVideoKeyB64, albumKey);
  const nonce = chunk.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ct = chunk.slice(sodium.crypto_secretbox_NONCEBYTES);
  return sodium.crypto_secretbox_open_easy(ct, nonce, videoKey);
}

export async function b64OfBytes(bytes: Uint8Array): Promise<string> {
  return toB64(bytes);
}

export async function bytesOfB64(b64: string): Promise<Uint8Array> {
  return fromB64(b64);
}
