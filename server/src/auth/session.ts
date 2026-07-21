import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(
  process.env.PICVAULT_JWT_SECRET ?? 'dev-only-secret-change-on-ec2'
);

export async function issueToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
