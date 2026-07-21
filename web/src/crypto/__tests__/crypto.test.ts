import { describe, it, expect } from 'vitest';
import {
  deriveFromPassword,
  newSalt,
  generateIdentityKeypair,
  encryptPrivateKeyBackup,
  decryptPrivateKeyBackup,
  newAlbumKey,
  wrapAlbumKey,
  unwrapAlbumKey,
} from '../keys';
import { encryptPhoto, decryptPhoto } from '../photo';
import { safetyNumber } from '../safety';

describe('password split', () => {
  it('derives a distinct master key and auth hash, deterministically per salt', async () => {
    const salt = await newSalt();
    const a = await deriveFromPassword('hunter2 correct horse', salt);
    const b = await deriveFromPassword('hunter2 correct horse', salt);
    expect(a.authHashB64).toBe(b.authHashB64);
    expect(Buffer.from(a.masterKey)).toEqual(Buffer.from(b.masterKey));
    // auth hash must not equal master key
    expect(a.authHashB64).not.toBe(Buffer.from(a.masterKey).toString('base64'));
    // different salt → different everything
    const c = await deriveFromPassword('hunter2 correct horse', await newSalt());
    expect(c.authHashB64).not.toBe(a.authHashB64);
  });
});

describe('key backup', () => {
  it('round-trips the private key under the master key', async () => {
    const salt = await newSalt();
    const { masterKey } = await deriveFromPassword('pw', salt);
    const { privateKey } = await generateIdentityKeypair();
    const backup = await encryptPrivateKeyBackup(privateKey, masterKey);
    const restored = await decryptPrivateKeyBackup(backup, masterKey);
    expect(Buffer.from(restored)).toEqual(Buffer.from(privateKey));
  });

  it('fails with the wrong master key', async () => {
    const salt = await newSalt();
    const { masterKey } = await deriveFromPassword('pw', salt);
    const { masterKey: wrong } = await deriveFromPassword('other', salt);
    const { privateKey } = await generateIdentityKeypair();
    const backup = await encryptPrivateKeyBackup(privateKey, masterKey);
    await expect(decryptPrivateKeyBackup(backup, wrong)).rejects.toThrow();
  });
});

describe('album key wrapping', () => {
  it('only the recipient can unwrap', async () => {
    const alice = await generateIdentityKeypair();
    const mallory = await generateIdentityKeypair();
    const albumKey = await newAlbumKey();
    const wrapped = await wrapAlbumKey(albumKey, alice.publicKeyB64);
    const unwrapped = await unwrapAlbumKey(wrapped, alice.publicKeyB64, alice.privateKey);
    expect(Buffer.from(unwrapped)).toEqual(Buffer.from(albumKey));
    await expect(
      unwrapAlbumKey(wrapped, mallory.publicKeyB64, mallory.privateKey)
    ).rejects.toThrow();
  });
});

describe('photo encryption', () => {
  it('round-trips bytes and produces ciphertext unlike the plaintext', async () => {
    const albumKey = await newAlbumKey();
    const plain = new Uint8Array(4096).map((_, i) => i % 251);
    const { blob, wrappedPhotoKeyB64 } = await encryptPhoto(plain, albumKey);
    expect(Buffer.from(blob).includes(Buffer.from(plain.slice(0, 64)))).toBe(false);
    const out = await decryptPhoto(blob, wrappedPhotoKeyB64, albumKey);
    expect(Buffer.from(out)).toEqual(Buffer.from(plain));
  });

  it('fails to decrypt with a different album key', async () => {
    const k1 = await newAlbumKey();
    const k2 = await newAlbumKey();
    const { blob, wrappedPhotoKeyB64 } = await encryptPhoto(new Uint8Array([1, 2, 3]), k1);
    await expect(decryptPhoto(blob, wrappedPhotoKeyB64, k2)).rejects.toThrow();
  });
});

describe('safety number', () => {
  it('is symmetric and formatted as 12 groups of 5 digits', async () => {
    const a = await generateIdentityKeypair();
    const b = await generateIdentityKeypair();
    const ab = await safetyNumber(a.publicKeyB64, b.publicKeyB64);
    const ba = await safetyNumber(b.publicKeyB64, a.publicKeyB64);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^(\d{5} ){11}\d{5}$/);
    const c = await generateIdentityKeypair();
    expect(await safetyNumber(a.publicKeyB64, c.publicKeyB64)).not.toBe(ab);
  });
});
