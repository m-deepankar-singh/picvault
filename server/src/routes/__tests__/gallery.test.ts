import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../app';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let alice: { token: string; userId: string };
let bob: { token: string; userId: string };
let eve: { token: string; userId: string };
let albumId: string;
let secondAlbumId: string;
let photoId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function signup(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: {
      email,
      authHashB64: Buffer.from('ah-' + email).toString('base64'),
      kdfSaltB64: 'a2Rmcw==',
      publicKeyB64: 'cGs=',
      keyBackupB64: 'a2I=',
    },
  });
  return res.json() as { token: string; userId: string };
}

beforeAll(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    blobDir: mkdtempSync(join(tmpdir(), 'picvault-gallery-')),
  });
  alice = await signup('a@g.dev');
  bob = await signup('b@g.dev');
  eve = await signup('e@g.dev');

  const created = await app.inject({
    method: 'POST', url: '/api/albums', headers: auth(alice.token),
    payload: { nameCt: 'ct', wrappedAlbumKeyB64: 'wk-a' },
  });
  albumId = created.json().id;
  await app.inject({
    method: 'POST', url: `/api/albums/${albumId}/members`, headers: auth(alice.token),
    payload: { email: 'b@g.dev', wrappedAlbumKeyB64: 'wk-b' },
  });
  const created2 = await app.inject({
    method: 'POST', url: '/api/albums', headers: auth(alice.token),
    payload: { nameCt: 'ct2', wrappedAlbumKeyB64: 'wk-a2' },
  });
  secondAlbumId = created2.json().id;

  const up = await app.inject({
    method: 'POST', url: `/api/albums/${albumId}/photos`, headers: auth(alice.token),
    payload: {
      photoB64: Buffer.from('photo-ct').toString('base64'),
      thumbB64: Buffer.from('thumb-ct').toString('base64'),
      wrappedPhotoKeyB64: 'wpk', wrappedThumbKeyB64: 'wtk',
    },
  });
  photoId = up.json().id;
});

describe('timeline', () => {
  it('returns member photos only, newest first', async () => {
    const forBob = await app.inject({ url: '/api/timeline', headers: auth(bob.token) });
    expect(forBob.json().map((p: { id: string }) => p.id)).toEqual([photoId]);
    const forEve = await app.inject({ url: '/api/timeline', headers: auth(eve.token) });
    expect(forEve.json()).toEqual([]);
  });
});

describe('notes', () => {
  it('members can add and list; kinds validated; outsiders blocked', async () => {
    const fav = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/notes`, headers: auth(bob.token),
      payload: { kind: 'favorite', bodyCt: '' },
    });
    expect(fav.statusCode).toBe(200);
    const comment = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/notes`, headers: auth(alice.token),
      payload: { kind: 'comment', bodyCt: 'enc-comment' },
    });
    expect(comment.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/notes`, headers: auth(alice.token),
      payload: { kind: 'sql-injection', bodyCt: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const eveTry = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/notes`, headers: auth(eve.token),
      payload: { kind: 'comment', bodyCt: 'x' },
    });
    expect(eveTry.statusCode).toBe(403);

    const list = await app.inject({
      url: `/api/albums/${albumId}/notes?after=0`, headers: auth(bob.token),
    });
    expect(list.json().map((n: { kind: string }) => n.kind)).toEqual(['favorite', 'comment']);
  });
});

describe('copy to album', () => {
  it('copies with re-wrapped keys; requires membership of both albums', async () => {
    const copy = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/copy`, headers: auth(alice.token),
      payload: { toAlbumId: secondAlbumId, wrappedPhotoKeyB64: 'wpk2', wrappedThumbKeyB64: 'wtk2' },
    });
    expect(copy.statusCode).toBe(200);
    expect(copy.json().albumId).toBe(secondAlbumId);

    // Bob is not in the second album → 403
    const bobTry = await app.inject({
      method: 'POST', url: `/api/photos/${photoId}/copy`, headers: auth(bob.token),
      payload: { toAlbumId: secondAlbumId, wrappedPhotoKeyB64: 'x', wrappedThumbKeyB64: 'x' },
    });
    expect(bobTry.statusCode).toBe(403);

    // The copy serves the SAME ciphertext bytes without re-upload
    const copied = copy.json().id as string;
    const dl = await app.inject({ url: `/api/photos/${copied}/blob`, headers: auth(alice.token) });
    expect(Buffer.from(dl.rawPayload)).toEqual(Buffer.from('photo-ct'));
  });
});

describe('video', () => {
  it('uploads chunks, registers, serves chunks to members only', async () => {
    const chunkIds: string[] = [];
    for (const data of ['chunk-0', 'chunk-1']) {
      const res = await app.inject({
        method: 'POST', url: `/api/albums/${albumId}/blobs`, headers: auth(alice.token),
        payload: { dataB64: Buffer.from(data).toString('base64') },
      });
      chunkIds.push(res.json().blobId);
    }
    const reg = await app.inject({
      method: 'POST', url: `/api/albums/${albumId}/videos`, headers: auth(alice.token),
      payload: {
        chunkBlobIds: chunkIds,
        thumbB64: Buffer.from('poster-ct').toString('base64'),
        wrappedVideoKeyB64: 'wvk', wrappedThumbKeyB64: 'wtk',
        durationS: 12,
      },
    });
    expect(reg.statusCode).toBe(200);
    const video = reg.json();
    expect(video.mediaType).toBe('video');
    expect(video.chunkCount).toBe(2);

    const c1 = await app.inject({ url: `/api/photos/${video.id}/chunk/1`, headers: auth(bob.token) });
    expect(Buffer.from(c1.rawPayload)).toEqual(Buffer.from('chunk-1'));
    const evec = await app.inject({ url: `/api/photos/${video.id}/chunk/0`, headers: auth(eve.token) });
    expect(evec.statusCode).toBe(403);
    const oob = await app.inject({ url: `/api/photos/${video.id}/chunk/9`, headers: auth(alice.token) });
    expect(oob.statusCode).toBe(404);
  });
});

describe('nudge', () => {
  it('appends a nudge event visible to the partner', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/albums/${albumId}/nudge`, headers: auth(bob.token),
    });
    expect(res.statusCode).toBe(200);
    const events = await app.inject({
      url: `/api/albums/${albumId}/events?after=0`, headers: auth(alice.token),
    });
    const kinds = events.json().map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('nudge_sent');
  });
});
