import { wrapWithKey, unwrapWithKey, unwrapAlbumKey } from './crypto/keys';
import { getSodium } from './crypto/sodium';
import { api } from './api';
import { cacheAlbumKey } from './vault';

export type AlbumKind = 'normal' | 'spicy';

export interface AlbumInfo {
  id: string;
  name: string;
  kind: AlbumKind;
  key: Uint8Array;
  createdAt: string;
}

// The album's kind is encrypted together with its name, so the server can
// never tell which albums are spicy — that stays between the two of you.
export async function encryptMeta(
  name: string,
  kind: AlbumKind,
  albumKey: Uint8Array
): Promise<string> {
  const sodium = await getSodium();
  return wrapWithKey(sodium.from_string(JSON.stringify({ n: name, k: kind })), albumKey);
}

export async function decryptMeta(
  nameCt: string,
  albumKey: Uint8Array
): Promise<{ name: string; kind: AlbumKind }> {
  const sodium = await getSodium();
  try {
    const raw = sodium.to_string(await unwrapWithKey(nameCt, albumKey));
    try {
      const parsed = JSON.parse(raw) as { n?: string; k?: string };
      if (parsed && typeof parsed.n === 'string') {
        return { name: parsed.n, kind: parsed.k === 'spicy' ? 'spicy' : 'normal' };
      }
    } catch {
      /* older albums encrypted the bare name */
    }
    return { name: raw, kind: 'normal' };
  } catch {
    return { name: '(cannot decrypt)', kind: 'normal' };
  }
}

// Fetch every album, unwrap its key (caching it), decrypt its metadata.
export async function loadAlbumInfos(
  publicKeyB64: string,
  privateKey: Uint8Array
): Promise<AlbumInfo[]> {
  const list = await api.albums();
  return Promise.all(
    list.map(async (a) => {
      const key = await unwrapAlbumKey(a.wrappedAlbumKeyB64, publicKeyB64, privateKey);
      cacheAlbumKey(a.id, key);
      const meta = await decryptMeta(a.nameCt, key);
      return { id: a.id, key, createdAt: a.createdAt, ...meta };
    })
  );
}
