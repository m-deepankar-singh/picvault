import type { FastifyInstance } from 'fastify';
import type { AddMemberRequest, CreateAlbumRequest } from '@picvault/shared/src/api-types';
import type { Repos } from '../db/repos';

function requireUser(req: unknown): string | null {
  const userId = (req as { userId?: string }).userId;
  return userId ?? null;
}

export function registerAlbumRoutes(app: FastifyInstance, repos: Repos) {
  app.post<{ Body: CreateAlbumRequest }>('/api/albums', async (req, reply) => {
    const userId = requireUser(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const { nameCt, wrappedAlbumKeyB64 } = req.body ?? {};
    if (!nameCt || !wrappedAlbumKeyB64) return reply.code(400).send({ error: 'missing fields' });
    const album = repos.albums.create(nameCt, userId, wrappedAlbumKeyB64);
    return {
      id: album.id,
      nameCt: album.name_ct,
      wrappedAlbumKeyB64,
      createdAt: album.created_at,
    };
  });

  app.get('/api/albums', async (req, reply) => {
    const userId = requireUser(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    return repos.albums.listForUser(userId).map((a) => ({
      id: a.id,
      nameCt: a.name_ct,
      wrappedAlbumKeyB64: a.wrapped_album_key,
      createdAt: a.created_at,
    }));
  });

  app.get<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    const userId = requireUser(req);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const membership = repos.memberships.get(req.params.id, userId);
    if (!membership) return reply.code(403).send({ error: 'not a member' });
    const album = repos.albums.get(req.params.id)!;
    return {
      id: album.id,
      nameCt: album.name_ct,
      wrappedAlbumKeyB64: membership.wrapped_album_key,
      createdAt: album.created_at,
      members: repos.memberships.listMembers(album.id).map((m) => ({
        userId: m.user_id,
        email: m.email,
        publicKeyB64: m.public_key,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: AddMemberRequest }>(
    '/api/albums/:id/members',
    async (req, reply) => {
      const userId = requireUser(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      if (!repos.memberships.get(req.params.id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const { email, wrappedAlbumKeyB64 } = req.body ?? {};
      if (!email || !wrappedAlbumKeyB64) return reply.code(400).send({ error: 'missing fields' });
      const invitee = repos.users.getByEmail(email);
      if (!invitee) return reply.code(404).send({ error: 'no such user' });
      if (repos.memberships.get(req.params.id, invitee.id)) {
        return reply.code(409).send({ error: 'already a member' });
      }
      repos.memberships.add(req.params.id, invitee.id, wrappedAlbumKeyB64);
      return { ok: true };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/albums/:id/events',
    async (req, reply) => {
      const userId = requireUser(req);
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      if (!repos.memberships.get(req.params.id, userId)) {
        return reply.code(403).send({ error: 'not a member' });
      }
      const after = Number(req.query.after ?? 0);
      return repos.events.listSince(req.params.id, Number.isFinite(after) ? after : 0).map((e) => ({
        id: e.id,
        albumId: e.album_id,
        kind: e.kind,
        payload: e.payload,
        prevHash: e.prev_hash,
        hash: e.hash,
        createdAt: e.created_at,
      }));
    }
  );
}
