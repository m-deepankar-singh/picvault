import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../index';
import { makeRepos } from '../repos';

function freshRepos() {
  return makeRepos(openDb(':memory:'));
}

function makeUser(repos: ReturnType<typeof freshRepos>, email: string) {
  return repos.users.create({
    email,
    auth_hash: 'ah',
    auth_salt: 'as',
    kdf_salt: 'ks',
    public_key: 'pk-' + email,
    key_backup: 'kb',
  });
}

describe('repos', () => {
  it('creates users and albums with creator membership + genesis event', () => {
    const repos = freshRepos();
    const alice = makeUser(repos, 'alice@example.com');
    const album = repos.albums.create('name-ct', alice.id, 'wrapped-for-alice');
    expect(repos.memberships.get(album.id, alice.id)?.wrapped_album_key).toBe(
      'wrapped-for-alice'
    );
    const evts = repos.events.listSince(album.id, 0);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.kind).toBe('album_created');
    expect(evts[0]!.prev_hash).toBe('genesis');
  });

  it('maintains a verifiable hash chain across mutations', () => {
    const repos = freshRepos();
    const alice = makeUser(repos, 'a@x.com');
    const bob = makeUser(repos, 'b@x.com');
    const album = repos.albums.create('ct', alice.id, 'wk-a');
    repos.memberships.add(album.id, bob.id, 'wk-b');
    repos.photos.add({
      album_id: album.id,
      blob_id: 'blob1',
      thumb_blob_id: 'thumb1',
      wrapped_photo_key: 'wpk',
      wrapped_thumb_key: 'wtk',
      uploaded_by: alice.id,
      media_type: 'photo',
      duration_s: null,
      chunk_ids: null,
    });
    const evts = repos.events.listSince(album.id, 0);
    expect(evts.map((e) => e.kind)).toEqual(['album_created', 'member_added', 'photo_added']);
    // verify the chain exactly as a client would
    let prev = 'genesis';
    for (const e of evts) {
      expect(e.prev_hash).toBe(prev);
      const expected = createHash('sha256')
        .update(`${e.prev_hash}|${e.kind}|${e.payload}`)
        .digest('hex');
      expect(e.hash).toBe(expected);
      prev = e.hash;
    }
  });

  it('lists albums only for members', () => {
    const repos = freshRepos();
    const alice = makeUser(repos, 'a@x.com');
    const bob = makeUser(repos, 'b@x.com');
    const album = repos.albums.create('ct', alice.id, 'wk-a');
    expect(repos.albums.listForUser(alice.id)).toHaveLength(1);
    expect(repos.albums.listForUser(bob.id)).toHaveLength(0);
    repos.memberships.add(album.id, bob.id, 'wk-b');
    expect(repos.albums.listForUser(bob.id)).toHaveLength(1);
  });
});

describe('no-delete guarantee', () => {
  it('server source contains no DELETE statement or route', () => {
    const srcDir = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__') walk(p);
        } else if (/\.(ts|sql)$/.test(name)) {
          const text = readFileSync(p, 'utf8');
          // No SQL deletes anywhere; no delete methods on the persistence
          // layers (db, blobs, routes). In-memory structures elsewhere
          // (e.g. rtc signaling rooms) may clean themselves up.
          const persistent = /[\\/](db|blobs|routes)[\\/]/.test(p);
          if (/DELETE\s+FROM/i.test(text) || (persistent && /\.delete\s*\(/.test(text))) {
            offenders.push(p);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
