import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../app';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let blobDir: string;

async function signup(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: {
      email,
      authHashB64: Buffer.from('authhash-' + email).toString('base64'),
      kdfSaltB64: Buffer.from('salt-' + email).toString('base64'),
      publicKeyB64: Buffer.from('pubkey-' + email).toString('base64'),
      keyBackupB64: Buffer.from('backup-' + email).toString('base64'),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; userId: string };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), 'picvault-blobs-'));
  app = await buildApp({ dbPath: ':memory:', blobDir });
});

describe('auth', () => {
  it('signs up, rejects duplicates, logs in with correct authHash only', async () => {
    const alice = await signup('alice@test.dev');
    expect(alice.token).toBeTruthy();

    const dup = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: {
        email: 'alice@test.dev',
        authHashB64: 'x', kdfSaltB64: 'x', publicKeyB64: 'x', keyBackupB64: 'x',
      },
    });
    expect(dup.statusCode).toBe(409);

    const good = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: {
        email: 'alice@test.dev',
        authHashB64: Buffer.from('authhash-alice@test.dev').toString('base64'),
      },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().keyBackupB64).toBe(Buffer.from('backup-alice@test.dev').toString('base64'));

    const bad = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'alice@test.dev', authHashB64: Buffer.from('wrong').toString('base64') },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('serves a salt for unknown emails too (no user enumeration)', async () => {
    const known = await app.inject({ url: '/api/salt?email=alice@test.dev' });
    const unknown = await app.inject({ url: '/api/salt?email=ghost@test.dev' });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().kdfSaltB64).toBeTruthy();
  });
});

describe('albums + photos', () => {
  it('runs the full share flow with membership enforcement', async () => {
    const alice = await signup('a@share.dev');
    const bob = await signup('b@share.dev');
    const eve = await signup('e@share.dev');

    // Alice creates an album
    const created = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: auth(alice.token),
      payload: { nameCt: 'enc-name', wrappedAlbumKeyB64: 'wk-alice' },
    });
    expect(created.statusCode).toBe(200);
    const albumId = created.json().id as string;

    // Eve (not a member) cannot see it or add herself
    const eveGet = await app.inject({ url: `/api/albums/${albumId}`, headers: auth(eve.token) });
    expect(eveGet.statusCode).toBe(403);
    const eveAdd = await app.inject({
      method: 'POST',
      url: `/api/albums/${albumId}/members`,
      headers: auth(eve.token),
      payload: { email: 'e@share.dev', wrappedAlbumKeyB64: 'wk-eve' },
    });
    expect(eveAdd.statusCode).toBe(403);

    // Alice fetches Bob's public key and adds him
    const pk = await app.inject({
      url: '/api/users/pubkey?email=b@share.dev',
      headers: auth(alice.token),
    });
    expect(pk.statusCode).toBe(200);
    const add = await app.inject({
      method: 'POST',
      url: `/api/albums/${albumId}/members`,
      headers: auth(alice.token),
      payload: { email: 'b@share.dev', wrappedAlbumKeyB64: 'wk-bob' },
    });
    expect(add.statusCode).toBe(200);

    // Bob sees the album with HIS wrapped key
    const bobAlbums = await app.inject({ url: '/api/albums', headers: auth(bob.token) });
    expect(bobAlbums.json()[0].wrappedAlbumKeyB64).toBe('wk-bob');

    // Alice uploads a "photo" (any bytes — server must treat as opaque)
    const fakeCiphertext = Buffer.from('THIS-IS-CIPHERTEXT-'.repeat(10));
    const up = await app.inject({
      method: 'POST',
      url: `/api/albums/${albumId}/photos`,
      headers: auth(alice.token),
      payload: {
        photoB64: fakeCiphertext.toString('base64'),
        thumbB64: Buffer.from('thumb-ct').toString('base64'),
        wrappedPhotoKeyB64: 'wpk',
        wrappedThumbKeyB64: 'wtk',
      },
    });
    expect(up.statusCode).toBe(200);
    const photoId = up.json().id as string;

    // Bob can download; bytes round-trip exactly
    const dl = await app.inject({ url: `/api/photos/${photoId}/blob`, headers: auth(bob.token) });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload)).toEqual(fakeCiphertext);

    // Eve cannot; anonymous cannot
    const eveDl = await app.inject({ url: `/api/photos/${photoId}/blob`, headers: auth(eve.token) });
    expect(eveDl.statusCode).toBe(403);
    const anonDl = await app.inject({ url: `/api/photos/${photoId}/blob` });
    expect(anonDl.statusCode).toBe(401);

    // Event chain recorded the history
    const events = await app.inject({
      url: `/api/albums/${albumId}/events?after=0`,
      headers: auth(alice.token),
    });
    expect(events.json().map((e: { kind: string }) => e.kind)).toEqual([
      'album_created',
      'member_added',
      'photo_added',
    ]);

    // Blobs on disk are exactly the ciphertext the client sent — the server
    // stored no plaintext derivative anywhere.
    const files = readdirSync(blobDir).map((f) => readFileSync(join(blobDir, f)));
    expect(files.some((b) => b.equals(fakeCiphertext))).toBe(true);
  });
});
