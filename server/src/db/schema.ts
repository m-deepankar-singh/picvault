// Append-only schema. There is intentionally no DELETE anywhere in this
// codebase; in production the Postgres role additionally lacks the DELETE
// grant and S3 Object Lock makes blobs immutable.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,        -- scrypt(client authHash, server salt)
  auth_salt TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,         -- client Argon2id salt (public)
  public_key TEXT NOT NULL,
  key_backup TEXT NOT NULL,       -- private key encrypted with client master key
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  name_ct TEXT NOT NULL,          -- encrypted album name
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  album_id TEXT NOT NULL REFERENCES albums(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  wrapped_album_key TEXT NOT NULL, -- album key sealed to this member's public key
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (album_id, user_id)
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id),
  blob_id TEXT NOT NULL,
  thumb_blob_id TEXT NOT NULL,
  wrapped_photo_key TEXT NOT NULL,
  wrapped_thumb_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  media_type TEXT NOT NULL DEFAULT 'photo',  -- 'photo' | 'video'
  duration_s INTEGER,                        -- video only
  chunk_ids TEXT,                            -- video only: JSON array of blob ids
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interactions. kind is plaintext (accepted leak: counts only); body_ct is
-- encrypted under the album key — the server never learns what was said.
CREATE TABLE IF NOT EXISTS photo_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  album_id TEXT NOT NULL REFERENCES albums(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,        -- caption | comment | reaction | favorite
  body_ct TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_album ON photo_notes(album_id, id);

CREATE TABLE IF NOT EXISTS album_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id TEXT NOT NULL REFERENCES albums(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_album ON album_events(album_id, id);
`;
