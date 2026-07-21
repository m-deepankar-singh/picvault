import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './index';

// Repositories are append-only by design: no repo exposes a delete or
// destructive-update method, mirroring the product guarantee that shared
// photos can never be removed.

export interface UserRow {
  id: string;
  email: string;
  auth_hash: string;
  auth_salt: string;
  kdf_salt: string;
  public_key: string;
  key_backup: string;
  created_at: string;
}

export interface AlbumRow {
  id: string;
  name_ct: string;
  created_by: string;
  created_at: string;
}

export interface MembershipRow {
  album_id: string;
  user_id: string;
  wrapped_album_key: string;
  added_at: string;
}

export interface PhotoRow {
  id: string;
  album_id: string;
  blob_id: string;
  thumb_blob_id: string;
  wrapped_photo_key: string;
  wrapped_thumb_key: string;
  uploaded_by: string;
  media_type: 'photo' | 'video';
  duration_s: number | null;
  chunk_ids: string | null;
  created_at: string;
}

export interface NoteRow {
  id: number;
  photo_id: string;
  album_id: string;
  author_id: string;
  kind: string;
  body_ct: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  album_id: string;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export function makeRepos(db: Db) {
  const users = {
    create(u: Omit<UserRow, 'id' | 'created_at'>): UserRow {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO users (id, email, auth_hash, auth_salt, kdf_salt, public_key, key_backup)
         VALUES (@id, @email, @auth_hash, @auth_salt, @kdf_salt, @public_key, @key_backup)`
      ).run({ id, ...u });
      return this.getById(id)!;
    },
    getByEmail(email: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    },
    getById(id: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    },
  };

  const events = {
    append(albumId: string, kind: string, payload: string): EventRow {
      const last = db
        .prepare('SELECT hash FROM album_events WHERE album_id = ? ORDER BY id DESC LIMIT 1')
        .get(albumId) as { hash: string } | undefined;
      const prevHash = last?.hash ?? 'genesis';
      const hash = createHash('sha256')
        .update(`${prevHash}|${kind}|${payload}`)
        .digest('hex');
      const info = db
        .prepare(
          `INSERT INTO album_events (album_id, kind, payload, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(albumId, kind, payload, prevHash, hash);
      return db
        .prepare('SELECT * FROM album_events WHERE id = ?')
        .get(info.lastInsertRowid) as EventRow;
    },
    listSince(albumId: string, afterId: number): EventRow[] {
      return db
        .prepare('SELECT * FROM album_events WHERE album_id = ? AND id > ? ORDER BY id')
        .all(albumId, afterId) as EventRow[];
    },
  };

  const albums = {
    create(nameCt: string, createdBy: string, wrappedAlbumKey: string): AlbumRow {
      const id = randomUUID();
      const tx = db.transaction(() => {
        db.prepare(
          'INSERT INTO albums (id, name_ct, created_by) VALUES (?, ?, ?)'
        ).run(id, nameCt, createdBy);
        db.prepare(
          'INSERT INTO memberships (album_id, user_id, wrapped_album_key) VALUES (?, ?, ?)'
        ).run(id, createdBy, wrappedAlbumKey);
        events.append(id, 'album_created', JSON.stringify({ albumId: id, by: createdBy }));
      });
      tx();
      return db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as AlbumRow;
    },
    get(id: string): AlbumRow | undefined {
      return db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as AlbumRow | undefined;
    },
    listForUser(userId: string): (AlbumRow & { wrapped_album_key: string })[] {
      return db
        .prepare(
          `SELECT a.*, m.wrapped_album_key FROM albums a
           JOIN memberships m ON m.album_id = a.id
           WHERE m.user_id = ? ORDER BY a.created_at DESC`
        )
        .all(userId) as (AlbumRow & { wrapped_album_key: string })[];
    },
  };

  const memberships = {
    add(albumId: string, userId: string, wrappedAlbumKey: string): void {
      const tx = db.transaction(() => {
        db.prepare(
          'INSERT INTO memberships (album_id, user_id, wrapped_album_key) VALUES (?, ?, ?)'
        ).run(albumId, userId, wrappedAlbumKey);
        events.append(albumId, 'member_added', JSON.stringify({ albumId, userId }));
      });
      tx();
    },
    get(albumId: string, userId: string): MembershipRow | undefined {
      return db
        .prepare('SELECT * FROM memberships WHERE album_id = ? AND user_id = ?')
        .get(albumId, userId) as MembershipRow | undefined;
    },
    listMembers(albumId: string): (MembershipRow & { email: string; public_key: string })[] {
      return db
        .prepare(
          `SELECT m.*, u.email, u.public_key FROM memberships m
           JOIN users u ON u.id = m.user_id WHERE m.album_id = ? ORDER BY m.added_at`
        )
        .all(albumId) as (MembershipRow & { email: string; public_key: string })[];
    },
  };

  const photos = {
    add(p: Omit<PhotoRow, 'id' | 'created_at'>): PhotoRow {
      const id = randomUUID();
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO photos (id, album_id, blob_id, thumb_blob_id, wrapped_photo_key, wrapped_thumb_key, uploaded_by, media_type, duration_s, chunk_ids)
           VALUES (@id, @album_id, @blob_id, @thumb_blob_id, @wrapped_photo_key, @wrapped_thumb_key, @uploaded_by, @media_type, @duration_s, @chunk_ids)`
        ).run({ id, ...p });
        events.append(
          p.album_id,
          'photo_added',
          JSON.stringify({ photoId: id, by: p.uploaded_by })
        );
      });
      tx();
      return db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow;
    },
    get(id: string): PhotoRow | undefined {
      return db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
    },
    listForAlbum(albumId: string): PhotoRow[] {
      return db
        .prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY created_at')
        .all(albumId) as PhotoRow[];
    },
    listForUser(userId: string, offset: number, limit: number): PhotoRow[] {
      return db
        .prepare(
          `SELECT p.* FROM photos p
           JOIN memberships m ON m.album_id = p.album_id
           WHERE m.user_id = ?
           ORDER BY p.created_at DESC, p.id DESC
           LIMIT ? OFFSET ?`
        )
        .all(userId, limit, offset) as PhotoRow[];
    },
  };

  const notes = {
    add(n: Omit<NoteRow, 'id' | 'created_at'>): NoteRow {
      const tx = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO photo_notes (photo_id, album_id, author_id, kind, body_ct)
             VALUES (@photo_id, @album_id, @author_id, @kind, @body_ct)`
          )
          .run(n);
        events.append(
          n.album_id,
          'note_added',
          JSON.stringify({ noteId: Number(info.lastInsertRowid), kind: n.kind })
        );
        return info.lastInsertRowid;
      });
      const rowid = tx();
      return db.prepare('SELECT * FROM photo_notes WHERE id = ?').get(rowid) as NoteRow;
    },
    listForAlbum(albumId: string, afterId: number): NoteRow[] {
      return db
        .prepare('SELECT * FROM photo_notes WHERE album_id = ? AND id > ? ORDER BY id')
        .all(albumId, afterId) as NoteRow[];
    },
  };

  return { users, albums, memberships, photos, notes, events };
}

export type Repos = ReturnType<typeof makeRepos>;
