import Fastify from 'fastify';
import cors from '@fastify/cors';
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { DiskBlobStore, type BlobStore } from './blobs/store';
import { verifyToken } from './auth/session';
import { registerAuthRoutes } from './routes/auth';
import { registerAlbumRoutes } from './routes/albums';
import { registerPhotoRoutes } from './routes/photos';
import { registerGalleryRoutes } from './routes/gallery';
import { registerRtc } from './rtc/signal';
import type { Repos } from './db/repos';

declare module 'fastify' {
  interface FastifyInstance {
    repos: Repos;
  }
}

export interface AppOptions {
  dbPath: string;
  blobDir?: string;
  blobStore?: BlobStore;
  /** Absolute path to the built web app (web/dist). When set, the API also
   *  serves the PWA so one process (and one HTTPS tunnel) covers everything. */
  staticDir?: string;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ bodyLimit: 40 * 1024 * 1024, logger: false });
  await app.register(cors, { origin: true });

  const repos = makeRepos(openDb(opts.dbPath));
  const blobs = opts.blobStore ?? new DiskBlobStore(opts.blobDir ?? './blobs');

  // Bearer-token auth for everything except signup/login/salt.
  app.addHook('preHandler', async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const userId = await verifyToken(auth.slice(7));
      if (userId) (req as { userId?: string }).userId = userId;
    }
  });

  app.decorate('repos', repos);

  registerAuthRoutes(app, repos);
  registerAlbumRoutes(app, repos);
  registerPhotoRoutes(app, repos, blobs);
  registerGalleryRoutes(app, repos, blobs);
  await registerRtc(app, repos);

  if (opts.staticDir) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: opts.staticDir });
    // SPA fallback: any non-API path serves the app shell
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
