import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 8787);

// In production (PICVAULT_STATIC=1 or a built web app present), serve the PWA too.
const distDir = resolve(import.meta.dirname, '../../web/dist');
const serveStatic = process.env.PICVAULT_STATIC !== '0' && existsSync(distDir);

const app = await buildApp({
  dbPath: process.env.PICVAULT_DB ?? './picvault.db',
  blobDir: process.env.PICVAULT_BLOBS ?? './blobs',
  staticDir: serveStatic ? distDir : undefined,
});

if (!process.env.PICVAULT_JWT_SECRET) {
  console.warn('WARNING: PICVAULT_JWT_SECRET is not set — using the dev secret. Set it before real use.');
}

await app.listen({ port, host: '0.0.0.0' });
console.log(`PicVault listening on :${port}${serveStatic ? ' (serving web app + API)' : ' (API only)'}`);
