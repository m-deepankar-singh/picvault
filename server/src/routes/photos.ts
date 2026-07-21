import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UploadPhotoRequest } from '@picvault/shared/src/api-types';
import type { Repos } from '../db/repos';
import type { BlobStore } from '../blobs/store';

// MVP transport: JSON with base64 blobs through the API. On EC2 this becomes
// S3 presigned PUT/GET so ciphertext bytes never transit the API process.
export function registerPhotoRoutes(app: FastifyInstance, repos: Repos, blobs: BlobStore) {
  app.post<{ Params: { id: string }; Body: UploadPhotoRequest }>(
    '/api/albums/:id/photos',
    async (req, reply) => {
      const userId = (req as { userId?: string }).userId;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      if (!repos.memberships.get(req.params.id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const { photoB64, thumbB64, wrappedPhotoKeyB64, wrappedThumbKeyB64 } = req.body ?? {};
      if (!photoB64 || !thumbB64 || !wrappedPhotoKeyB64 || !wrappedThumbKeyB64) {
        return reply.code(400).send({ error: 'missing fields' });
      }
      const blobId = randomUUID();
      const thumbBlobId = randomUUID();
      await blobs.put(blobId, Buffer.from(photoB64, 'base64'));
      await blobs.put(thumbBlobId, Buffer.from(thumbB64, 'base64'));
      const photo = repos.photos.add({
        album_id: req.params.id,
        blob_id: blobId,
        thumb_blob_id: thumbBlobId,
        wrapped_photo_key: wrappedPhotoKeyB64,
        wrapped_thumb_key: wrappedThumbKeyB64,
        uploaded_by: userId,
        media_type: 'photo',
        duration_s: null,
        chunk_ids: null,
      });
      return {
        id: photo.id,
        albumId: photo.album_id,
        wrappedPhotoKeyB64,
        wrappedThumbKeyB64,
        uploadedBy: photo.uploaded_by,
        createdAt: photo.created_at,
      };
    }
  );

  app.get<{ Params: { id: string } }>('/api/albums/:id/photos', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    if (!repos.memberships.get(req.params.id, userId)) {
      return reply.code(403).send({ error: 'not a member' });
    }
    return repos.photos.listForAlbum(req.params.id).map((p) => ({
      id: p.id,
      albumId: p.album_id,
      wrappedPhotoKeyB64: p.wrapped_photo_key,
      wrappedThumbKeyB64: p.wrapped_thumb_key,
      uploadedBy: p.uploaded_by,
      mediaType: p.media_type,
      durationS: p.duration_s,
      chunkCount: p.chunk_ids ? (JSON.parse(p.chunk_ids) as string[]).length : 0,
      createdAt: p.created_at,
    }));
  });

  const serveBlob = (which: 'blob_id' | 'thumb_blob_id') =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = (req as { userId?: string }).userId;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const photoId = req.params.id;
      const photo = repos.photos.get(photoId);
      if (!photo) return reply.code(404).send({ error: 'not found' });
      if (!repos.memberships.get(photo.album_id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const bytes = await blobs.get(photo[which]);
      reply.header('content-type', 'application/octet-stream');
      reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(bytes));
    };

  app.get<{ Params: { id: string } }>('/api/photos/:id/blob', serveBlob('blob_id'));
  app.get<{ Params: { id: string } }>('/api/photos/:id/thumb', serveBlob('thumb_blob_id'));
}
