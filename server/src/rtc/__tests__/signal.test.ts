import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp } from '../../app';
import { issueToken } from '../../auth/session';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let base: string;

function connect(token: string, album: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/api/rtc?token=${token}&album=${album}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<{ type: string; payload?: unknown }> {
  return new Promise((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
  );
}

beforeAll(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    blobDir: mkdtempSync(join(tmpdir(), 'picvault-rtc-')),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
});

describe('rtc signaling', () => {
  it('relays offer/answer/ice between album members and rejects outsiders', async () => {
    const mk = (email: string) =>
      app.repos.users.create({
        email,
        auth_hash: 'x', auth_salt: 'x', kdf_salt: 'x',
        public_key: 'pk-' + email, key_backup: 'kb',
      });
    const alice = mk('a@rtc.dev');
    const bob = mk('b@rtc.dev');
    const eve = mk('e@rtc.dev');
    const album = app.repos.albums.create('ct', alice.id, 'wk-a');
    app.repos.memberships.add(album.id, bob.id, 'wk-b');

    const [tokA, tokB, tokE] = await Promise.all([
      issueToken(alice.id), issueToken(bob.id), issueToken(eve.id),
    ]);

    // Eve is not a member → socket closes with 4401
    const eveClosed = new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/api/rtc?token=${tokE}&album=${album.id}`);
      ws.on('close', (code) => resolve(code));
    });
    expect(await eveClosed).toBe(4401);

    // Alice joins, then Bob joins → Alice hears peer-joined
    const wsA = await connect(tokA, album.id);
    const joined = nextMessage(wsA);
    const wsB = await connect(tokB, album.id);
    expect((await joined).type).toBe('peer-joined');

    // Alice's offer reaches Bob, Bob's answer reaches Alice, ice both ways
    const offerAtB = nextMessage(wsB);
    wsA.send(JSON.stringify({ type: 'offer', payload: { sdp: 'fake-offer' } }));
    expect(await offerAtB).toEqual({ type: 'offer', payload: { sdp: 'fake-offer' } });

    const answerAtA = nextMessage(wsA);
    wsB.send(JSON.stringify({ type: 'answer', payload: { sdp: 'fake-answer' } }));
    expect(await answerAtA).toEqual({ type: 'answer', payload: { sdp: 'fake-answer' } });

    const iceAtB = nextMessage(wsB);
    wsA.send(JSON.stringify({ type: 'ice', payload: { candidate: 'c1' } }));
    expect((await iceAtB).type).toBe('ice');

    // junk and non-signal types are not relayed; peer-left arrives on close
    wsA.send('not-json');
    wsA.send(JSON.stringify({ type: 'evil', payload: 'x' }));
    const leftAtB = nextMessage(wsB);
    wsA.close();
    expect((await leftAtB).type).toBe('peer-left');
    wsB.close();
  });
});
