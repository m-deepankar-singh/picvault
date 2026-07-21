import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

// Additive-only migrations for databases created before v2. Consistent with
// the append-only rule: columns are only ever added, never dropped.
function migrate(db: Db) {
  const cols = (db.prepare('PRAGMA table_info(photos)').all() as { name: string }[]).map(
    (c) => c.name
  );
  if (!cols.includes('media_type')) {
    db.exec(`ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo'`);
  }
  if (!cols.includes('duration_s')) {
    db.exec('ALTER TABLE photos ADD COLUMN duration_s INTEGER');
  }
  if (!cols.includes('chunk_ids')) {
    db.exec('ALTER TABLE photos ADD COLUMN chunk_ids TEXT');
  }
}
