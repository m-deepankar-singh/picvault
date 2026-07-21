import { openDB, type IDBPDatabase } from 'idb';

// Device vault. The private key persists in IndexedDB (this device only);
// album keys are cached in memory per session. Nothing here is ever sent
// to the server unencrypted.

interface Session {
  token: string;
  userId: string;
  email: string;
  publicKeyB64: string;
}

let db: Promise<IDBPDatabase> | null = null;
const albumKeys = new Map<string, Uint8Array>();

function vaultDb() {
  if (!db) {
    db = openDB('picvault', 1, {
      upgrade(d) {
        d.createObjectStore('kv');
      },
    });
  }
  return db;
}

export async function saveSession(s: Session, privateKey: Uint8Array): Promise<void> {
  const d = await vaultDb();
  await d.put('kv', s, 'session');
  await d.put('kv', privateKey, 'privateKey');
}

export async function loadSession(): Promise<{ session: Session; privateKey: Uint8Array } | null> {
  const d = await vaultDb();
  const session = (await d.get('kv', 'session')) as Session | undefined;
  const privateKey = (await d.get('kv', 'privateKey')) as Uint8Array | undefined;
  if (!session || !privateKey) return null;
  return { session, privateKey };
}

export async function clearSession(): Promise<void> {
  const d = await vaultDb();
  await d.clear('kv');
  albumKeys.clear();
}

export function cacheAlbumKey(albumId: string, key: Uint8Array): void {
  albumKeys.set(albumId, key);
}

export function getCachedAlbumKey(albumId: string): Uint8Array | undefined {
  return albumKeys.get(albumId);
}
