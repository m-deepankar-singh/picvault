import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Repos, PhotoRow } from '../db/repos';
import type { BlobStore } from '../blobs/store';

function photoOut(p: PhotoRow) {
  return {
    id: p.id,
    albumId: p.album_id,
    wrappedPhotoKeyB64: p.wrapped_photo_key,
    wrappedThumbKeyB64: p.wrapped_thumb_key,
    uploadedBy: p.uploaded_by,
    mediaType: p.media_type,
    durationS: p.duration_s,
    chunkCount: p.chunk_ids ? (JSON.parse(p.chunk_ids) as string[]).length : 0,
    createdAt: p.created_at,
  };
}

export function registerGalleryRoutes(app: FastifyInstance, repos: Repos, blobs: BlobStore) {
  const userOf = (req: unknown) => (req as { userId?: string }).userId ?? null;

  // Timeline: the caller's photos across every album they belong to.
  app.get<{ Querystring: { offset?: string; limit?: string } }>(
    '/api/timeline',
    async (req, reply) => {
      const userId = userOf(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100) || 100));
      return repos.photos.listForUser(userId, offset, limit).map(photoOut);
    }
  );

  // Interactions: favorites, captions, comments, reactions.
  const NOTE_KINDS = new Set(['caption', 'comment', 'reaction', 'favorite']);
  app.post<{ Params: { id: string }; Body: { kind?: string; bodyCt?: string } }>(
    '/api/photos/:id/notes',
    async (req, reply) => {
      const userId = userOf(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const photo = repos.photos.get(req.params.id);
      if (!photo) return reply.code(404).send({ error: 'not found' });
      if (!repos.memberships.get(photo.album_id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const { kind, bodyCt } = req.body ?? {};
      if (!kind || !NOTE_KINDS.has(kind) || typeof bodyCt !== 'string') {
        return reply.code(400).send({ error: 'bad note' });
      }
      const note = repos.notes.add({
        photo_id: photo.id,
        album_id: photo.album_id,
        author_id: userId,
        kind,
        body_ct: bodyCt,
      });
      return {
        id: note.id,
        photoId: note.photo_id,
        authorId: note.author_id,
        kind: note.kind,
        bodyCt: note.body_ct,
        createdAt: note.created_at,
      };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/albums/:id/notes',
    async (req, reply) => {
      const userId = userOf(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      if (!repos.memberships.get(req.params.id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const after = Number(req.query.after ?? 0) || 0;
      return repos.notes.listForAlbum(req.params.id, after).map((n) => ({
        id: n.id,
        photoId: n.photo_id,
        authorId: n.author_id,
        kind: n.kind,
        bodyCt: n.body_ct,
        createdAt: n.created_at,
      }));
    }
  );

  // Add-to-album: a COPY (nothing can leave an album under the no-delete
  // rule). Same blobs, keys re-wrapped client-side for the target album.
  app.post<{
    Params: { id: string };
    Body: { toAlbumId?: string; wrappedPhotoKeyB64?: string; wrappedThumbKeyB64?: string };
  }>('/api/photos/:id/copy', async (req, reply) => {
    const userId = userOf(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const photo = repos.photos.get(req.params.id);
    if (!photo) return reply.code(404).send({ error: 'not found' });
    const { toAlbumId, wrappedPhotoKeyB64, wrappedThumbKeyB64 } = req.body ?? {};
    if (!toAlbumId || !wrappedPhotoKeyB64 || !wrappedThumbKeyB64) {
      return reply.code(400).send({ error: 'missing fields' });
    }
    if (
      !repos.memberships.get(photo.album_id, userId) ||
      !repos.memberships.get(toAlbumId, userId)
    ) {
      return reply.code(403).send({ error: 'not a member' });
    }
    const copy = repos.photos.add({
      album_id: toAlbumId,
      blob_id: photo.blob_id,
      thumb_blob_id: photo.thumb_blob_id,
      wrapped_photo_key: wrappedPhotoKeyB64,
      wrapped_thumb_key: wrappedThumbKeyB64,
      uploaded_by: userId,
      media_type: photo.media_type,
      duration_s: photo.duration_s,
      chunk_ids: photo.chunk_ids,
    });
    return photoOut(copy);
  });

  // Video upload: opaque ciphertext chunks, then a record tying them together.
  app.post<{ Params: { id: string }; Body: { dataB64?: string } }>(
    '/api/albums/:id/blobs',
    async (req, reply) => {
      const userId = userOf(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      if (!repos.memberships.get(req.params.id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      if (!req.body?.dataB64) return reply.code(400).send({ error: 'missing data' });
      const blobId = randomUUID();
      await blobs.put(blobId, Buffer.from(req.body.dataB64, 'base64'));
      return { blobId };
    }
  );

  app.post<{
    Params: { id: string };
    Body: {
      chunkBlobIds?: string[];
      thumbB64?: string;
      wrappedVideoKeyB64?: string;
      wrappedThumbKeyB64?: string;
      durationS?: number;
    };
  }>('/api/albums/:id/videos', async (req, reply) => {
    const userId = userOf(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    if (!repos.memberships.get(req.params.id, userId)) {
      return reply.code(403).send({ error: 'not a member' });
    }
    const { chunkBlobIds, thumbB64, wrappedVideoKeyB64, wrappedThumbKeyB64, durationS } =
      req.body ?? {};
    if (
      !Array.isArray(chunkBlobIds) ||
      chunkBlobIds.length === 0 ||
      chunkBlobIds.length > 64 ||
      !thumbB64 ||
      !wrappedVideoKeyB64 ||
      !wrappedThumbKeyB64
    ) {
      return reply.code(400).send({ error: 'bad video' });
    }
    const thumbBlobId = randomUUID();
    await blobs.put(thumbBlobId, Buffer.from(thumbB64, 'base64'));
    const video = repos.photos.add({
      album_id: req.params.id,
      blob_id: chunkBlobIds[0]!,
      thumb_blob_id: thumbBlobId,
      wrapped_photo_key: wrappedVideoKeyB64,
      wrapped_thumb_key: wrappedThumbKeyB64,
      uploaded_by: userId,
      media_type: 'video',
      duration_s: Math.min(600, Math.max(0, Number(durationS) || 0)),
      chunk_ids: JSON.stringify(chunkBlobIds),
    });
    return photoOut(video);
  });

  app.get<{ Params: { id: string; n: string } }>(
    '/api/photos/:id/chunk/:n',
    async (req, reply) => {
      const userId = userOf(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const photo = repos.photos.get(req.params.id);
      if (!photo || !photo.chunk_ids) return reply.code(404).send({ error: 'not found' });
      if (!repos.memberships.get(photo.album_id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const ids = JSON.parse(photo.chunk_ids) as string[];
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 0 || n >= ids.length) {
        return reply.code(404).send({ error: 'no such chunk' });
      }
      const bytes = await blobs.get(ids[n]!);
      reply.header('content-type', 'application/octet-stream');
      reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(bytes));
    }
  );

  // Photo request: an encrypted-payload-free nudge in the event chain.
  app.post<{ Params: { id: string } }>('/api/albums/:id/nudge', async (req, reply) => {
    const userId = userOf(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    if (!repos.memberships.get(req.params.id, userId)) {
      return reply.code(403).send({ error: 'not a member' });
    }
    repos.events.append(req.params.id, 'nudge_sent', JSON.stringify({ by: userId }));
    return { ok: true };
  });
}
