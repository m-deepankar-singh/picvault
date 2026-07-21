import { getSodium, toB64, fromB64 } from './sodium';

// One password, split into two independent secrets (Bitwarden/Proton-style):
// Argon2id stretches the password into 64 bytes; the first 32 stay on the
// device as the master key, the last 32 are sent to the server as the auth
// hash. The server can never reconstruct the master key from the auth hash.
export async function deriveFromPassword(
  password: string,
  saltB64: string
): Promise<{ authHashB64: string; masterKey: Uint8Array }> {
  const sodium = await getSodium();
  const salt = await fromB64(saltB64);
  const stretched = sodium.crypto_pwhash(
    64,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const masterKey = stretched.slice(0, 32);
  const authHashB64 = await toB64(stretched.slice(32, 64));
  return { authHashB64, masterKey };
}

export async function newSalt(): Promise<string> {
  const sodium = await getSodium();
  return toB64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
}

export async function generateIdentityKeypair(): Promise<{
  publicKeyB64: string;
  privateKey: Uint8Array;
}> {
  const sodium = await getSodium();
  const pair = sodium.crypto_box_keypair();
  return { publicKeyB64: await toB64(pair.publicKey), privateKey: pair.privateKey };
}

async function secretboxSeal(plain: Uint8Array, key: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(plain, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return toB64(out);
}

async function secretboxOpen(sealedB64: string, key: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  const sealed = await fromB64(sealedB64);
  const nonce = sealed.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ct = sealed.slice(sodium.crypto_secretbox_NONCEBYTES);
  return sodium.crypto_secretbox_open_easy(ct, nonce, key);
}

export const encryptPrivateKeyBackup = (privateKey: Uint8Array, masterKey: Uint8Array) =>
  secretboxSeal(privateKey, masterKey);

export const decryptPrivateKeyBackup = (backupB64: string, masterKey: Uint8Array) =>
  secretboxOpen(backupB64, masterKey);

export async function newAlbumKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

// Sealed box: only the recipient's private key can unwrap; the server relays
// this blob but learns nothing.
export async function wrapAlbumKey(
  albumKey: Uint8Array,
  recipientPublicKeyB64: string
): Promise<string> {
  const sodium = await getSodium();
  const pub = await fromB64(recipientPublicKeyB64);
  return toB64(sodium.crypto_box_seal(albumKey, pub));
}

export async function unwrapAlbumKey(
  wrappedB64: string,
  publicKeyB64: string,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const pub = await fromB64(publicKeyB64);
  const wrapped = await fromB64(wrappedB64);
  return sodium.crypto_box_seal_open(wrapped, pub, privateKey);
}

// Symmetric wrap used for per-photo keys under the album key.
export const wrapWithKey = secretboxSeal;
export const unwrapWithKey = secretboxOpen;
