import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { verifyToken } from '../auth/session';
import type { Repos } from '../db/repos';

// WebRTC signaling for "together" captures. The server only relays opaque
// SDP/ICE envelopes between members of the same album; the video itself
// flows peer-to-peer, end-to-end encrypted by WebRTC (DTLS-SRTP), and never
// touches this server. Rooms live in memory only — nothing is persisted.

interface RoomPeer {
  userId: string;
  socket: WebSocket;
}

const rooms = new Map<string, Map<string, RoomPeer>>();

export async function registerRtc(app: FastifyInstance, repos: Repos) {
  await app.register(websocket);

  app.get<{ Querystring: { token?: string; album?: string } }>(
    '/api/rtc',
    { websocket: true },
    async (socket, req) => {
      const { token, album } = req.query;
      const userId = token ? await verifyToken(token) : null;
      if (!userId || !album || !repos.memberships.get(album, userId)) {
        socket.close(4401, 'unauthorized');
        return;
      }

      let room = rooms.get(album);
      if (!room) {
        room = new Map();
        rooms.set(album, room);
      }
      // one connection per user per album; replace stale ones
      room.get(userId)?.socket.close(4000, 'replaced');
      room.set(userId, { userId, socket });

      const broadcast = (from: string, data: string) => {
        for (const peer of room!.values()) {
          if (peer.userId !== from && peer.socket.readyState === peer.socket.OPEN) {
            peer.socket.send(data);
          }
        }
      };

      broadcast(userId, JSON.stringify({ type: 'peer-joined' }));

      socket.on('message', (raw: Buffer) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
          broadcast(userId, JSON.stringify(msg));
        }
      });

      socket.on('close', () => {
        if (room!.get(userId)?.socket === socket) {
          room!.delete(userId);
          broadcast(userId, JSON.stringify({ type: 'peer-left' }));
          if (room!.size === 0) rooms.delete(album);
        }
      });
    }
  );
}
