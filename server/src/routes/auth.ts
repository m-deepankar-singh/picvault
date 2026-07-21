import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { LoginRequest, SignupRequest } from '@picvault/shared/src/api-types';
import type { Repos } from '../db/repos';
import { issueToken } from '../auth/session';

// The client never sends its password — only the Argon2id-derived authHash.
// We stretch that once more with scrypt so a database leak still reveals
// nothing usable for login.
function hashAuth(authHashB64: string, salt: string): string {
  return scryptSync(authHashB64, salt, 32).toString('base64');
}

// Unknown emails get a deterministic fake salt so responses don't reveal
// which addresses have accounts.
function fakeSalt(email: string): string {
  return createHash('sha256')
    .update(`picvault-fake-salt:${email}:${process.env.PICVAULT_JWT_SECRET ?? 'dev'}`)
    .digest()
    .subarray(0, 16)
    .toString('base64');
}

export function registerAuthRoutes(app: FastifyInstance, repos: Repos) {
  app.post<{ Body: SignupRequest }>('/api/signup', async (req, reply) => {
    const { email, authHashB64, kdfSaltB64, publicKeyB64, keyBackupB64 } = req.body ?? {};
    if (!email || !authHashB64 || !kdfSaltB64 || !publicKeyB64 || !keyBackupB64) {
      return reply.code(400).send({ error: 'missing fields' });
    }
    if (repos.users.getByEmail(email)) {
      return reply.code(409).send({ error: 'email already registered' });
    }
    const authSalt = randomBytes(16).toString('base64');
    const user = repos.users.create({
      email,
      auth_hash: hashAuth(authHashB64, authSalt),
      auth_salt: authSalt,
      kdf_salt: kdfSaltB64,
      public_key: publicKeyB64,
      key_backup: keyBackupB64,
    });
    const token = await issueToken(user.id);
    return {
      token,
      userId: user.id,
      email: user.email,
      kdfSaltB64: user.kdf_salt,
      keyBackupB64: user.key_backup,
      publicKeyB64: user.public_key,
    };
  });

  app.get<{ Querystring: { email?: string } }>('/api/salt', async (req, reply) => {
    const email = req.query.email;
    if (!email) return reply.code(400).send({ error: 'email required' });
    const user = repos.users.getByEmail(email);
    return { kdfSaltB64: user ? user.kdf_salt : fakeSalt(email) };
  });

  app.post<{ Body: LoginRequest }>('/api/login', async (req, reply) => {
    const { email, authHashB64 } = req.body ?? {};
    if (!email || !authHashB64) return reply.code(400).send({ error: 'missing fields' });
    const user = repos.users.getByEmail(email);
    if (!user) return reply.code(401).send({ error: 'invalid credentials' });
    const candidate = Buffer.from(hashAuth(authHashB64, user.auth_salt), 'base64');
    const stored = Buffer.from(user.auth_hash, 'base64');
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const token = await issueToken(user.id);
    return {
      token,
      userId: user.id,
      email: user.email,
      kdfSaltB64: user.kdf_salt,
      keyBackupB64: user.key_backup,
      publicKeyB64: user.public_key,
    };
  });

  app.get('/api/me', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const user = repos.users.getById(userId);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { userId: user.id, email: user.email, publicKeyB64: user.public_key };
  });

  app.get<{ Querystring: { email?: string } }>('/api/users/pubkey', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const email = req.query.email;
    if (!email) return reply.code(400).send({ error: 'email required' });
    const user = repos.users.getByEmail(email);
    if (!user) return reply.code(404).send({ error: 'no such user' });
    return { userId: user.id, publicKeyB64: user.public_key };
  });
}
