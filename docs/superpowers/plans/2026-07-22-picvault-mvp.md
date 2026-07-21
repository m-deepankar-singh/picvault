# PicVault MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working end-to-end-encrypted photo-sharing PWA: two users sign up, form a shared album, share photos that the server only ever sees as ciphertext, with append-only (no-delete) storage and screenshot/save deterrence.

**Architecture:** npm-workspaces monorepo. `web` is a Vite React TS PWA holding all crypto (libsodium-wrappers-sumo); `server` is a Fastify TS API with better-sqlite3 behind repository interfaces (Postgres later on EC2) and a disk `BlobStore` (S3 + Object Lock later). Server stores only ciphertext, wrapped keys, and membership metadata.

**Tech Stack:** Node 24, TypeScript, Fastify 5, better-sqlite3, jose (JWT), Vite + React 18, libsodium-wrappers-sumo, idb, vitest, Playwright.

## Global Constraints

- E2EE: no plaintext photo bytes or unwrapped keys may ever reach the server. Enforced by construction: crypto lives only in `web/src/crypto/`.
- No-delete: no DELETE HTTP routes; no `DELETE FROM` SQL anywhere in `server/src/`; repositories expose no delete methods.
- EXIF stripped client-side before encryption (re-encode via canvas).
- Deterrence UI: photos render to `<canvas>` only, viewer-name watermark, blur on `visibilitychange`, context-menu/drag suppressed. No "screenshot-proof" copy anywhere.
- Git commits are DEFERRED at user request — skip all commit steps until the user says otherwise.
- Deviation from spec (approved rationale): API is Node/TS not Go (Go not installed); dev DB is SQLite and dev blob store is local disk, both behind interfaces (`Db`, `BlobStore`) mirroring the Postgres/S3 production shapes.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (workspaces root), `tsconfig.base.json`
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`
- Create: `web/` via `npm create vite@latest web -- --template react-ts`
- Create: `shared/package.json`, `shared/src/api-types.ts`

**Interfaces:**
- Produces: `shared/src/api-types.ts` exporting all request/response types used by both sides (defined per-task below and appended as tasks progress).

Steps: init root `package.json` with `"workspaces": ["server", "web", "shared"]`; install dev deps (`typescript`, `vitest`); server deps (`fastify`, `better-sqlite3`, `jose`, `@fastify/cors`); web deps (`libsodium-wrappers-sumo`, `idb`). Verify `npx vitest --version` runs in both packages and `npm run dev` boots Vite.

### Task 2: Crypto module (web/src/crypto) — TDD

**Files:**
- Create: `web/src/crypto/keys.ts`, `web/src/crypto/photo.ts`, `web/src/crypto/safety.ts`, `web/src/crypto/sodium.ts`
- Test: `web/src/crypto/__tests__/crypto.test.ts`

**Interfaces (Produces):**
```ts
// keys.ts
deriveFromPassword(password: string, saltB64: string): Promise<{ authHashB64: string; masterKey: Uint8Array }>
newSalt(): Promise<string>                       // 16-byte b64
generateIdentityKeypair(): Promise<{ publicKeyB64: string; privateKey: Uint8Array }>
encryptPrivateKeyBackup(privateKey: Uint8Array, masterKey: Uint8Array): Promise<string>   // b64(nonce|ct)
decryptPrivateKeyBackup(backupB64: string, masterKey: Uint8Array): Promise<Uint8Array>
newAlbumKey(): Promise<Uint8Array>               // 32 bytes
wrapAlbumKey(albumKey: Uint8Array, recipientPublicKeyB64: string): Promise<string>        // sealed box b64
unwrapAlbumKey(wrappedB64: string, publicKeyB64: string, privateKey: Uint8Array): Promise<Uint8Array>
// photo.ts
encryptPhoto(plain: Uint8Array, albumKey: Uint8Array): Promise<{ blob: Uint8Array; wrappedPhotoKeyB64: string }>
decryptPhoto(blob: Uint8Array, wrappedPhotoKeyB64: string, albumKey: Uint8Array): Promise<Uint8Array>
// safety.ts
safetyNumber(pubA_B64: string, pubB_B64: string): Promise<string>  // 12 groups of 5 digits, order-independent
```
Password split: `crypto_pwhash` (Argon2id, MODERATE) → 64 bytes; first 32 = master key (kept), last 32 = authHash (sent). Photo: random 32-byte key + `crypto_secretbox`; photo key wrapped with albumKey via secretbox. Tests: round-trips for every pair, wrong-key failures throw, safety number symmetric, authHash ≠ masterKey.

### Task 3: Server DB + repositories — TDD

**Files:**
- Create: `server/src/db/schema.sql`, `server/src/db/index.ts`, `server/src/db/repos.ts`
- Test: `server/src/db/__tests__/repos.test.ts`

Tables: `users(id, email UNIQUE, auth_hash, kdf_salt, public_key, key_backup, created_at)`, `albums(id, name_ct, created_by, created_at)`, `memberships(album_id, user_id, wrapped_album_key, added_at, PRIMARY KEY(album_id,user_id))`, `photos(id, album_id, blob_id, wrapped_photo_key, thumb_blob_id, wrapped_thumb_key, uploaded_by, created_at)`, `album_events(id INTEGER PRIMARY KEY AUTOINCREMENT, album_id, kind, payload, prev_hash, hash, created_at)`.

**Interfaces (Produces):** `Repos` object with `users.create/getByEmail/getById/setKeyBackup`, `albums.create/listForUser/get`, `memberships.add/get/listMembers`, `photos.add/listForAlbum/get`, `events.append(albumId, kind, payload) → {hash}` (computes sha256(prev_hash|kind|payload) chain), `events.listSince(albumId, afterId)`. **No delete methods.** Test: chain hashes link; a `DELETE FROM` grep of `server/src` returns nothing.

### Task 4: Auth + key backup API — TDD

**Files:**
- Create: `server/src/routes/auth.ts`, `server/src/auth/session.ts`, `server/src/app.ts` (buildApp for tests)
- Test: `server/src/routes/__tests__/auth.test.ts`

Routes: `POST /api/signup {email, authHashB64, kdfSaltB64, publicKeyB64, keyBackupB64}`; `POST /api/login {email, authHashB64} → {token, kdfSaltB64, keyBackupB64, userId}` — server stores argon2id-rehash of authHash (via `crypto.scrypt` acceptable for MVP: store `scrypt(authHashB64, serverSalt)`); `GET /api/salt?email=` → kdfSaltB64 (needed pre-login to derive authHash). JWT (jose, HS256, secret from env, 7d). `GET /api/me`. Tests with `app.inject`.

### Task 5: Albums, invites, wrapped keys API — TDD

**Files:**
- Create: `server/src/routes/albums.ts`
- Test: `server/src/routes/__tests__/albums.test.ts`

Routes: `POST /api/albums {nameCt, wrappedAlbumKeyB64}`; `GET /api/albums`; `POST /api/albums/:id/members {email, wrappedAlbumKeyB64}` (only existing member may add; client fetched the invitee's public key via `GET /api/users/pubkey?email=` and wrapped the album key for them); `GET /api/albums/:id` → members with public keys + caller's wrapped key. Every mutation appends an `album_events` row. Tests: non-member 403, event chain grows.

### Task 6: Photo upload/download API + BlobStore — TDD

**Files:**
- Create: `server/src/blobs/store.ts` (`interface BlobStore { put(id, bytes): Promise<void>; get(id): Promise<Uint8Array> }` + `DiskBlobStore(dir)`) 
- Create: `server/src/routes/photos.ts`
- Test: `server/src/routes/__tests__/photos.test.ts`

Routes: `POST /api/albums/:id/photos` (raw body ×2 via multipart: photo blob + thumb blob + wrapped keys) → photo record + event; `GET /api/photos/:id/blob`, `GET /api/photos/:id/thumb` (member-only); `GET /api/albums/:id/events?after=`. Body limit 25 MB. No delete route. Production note in code comment: swap DiskBlobStore for S3 presigned flow on EC2.

### Task 7: Web vault + auth screens

**Files:**
- Create: `web/src/vault.ts` (idb: stores `privateKey`, `masterKey`—session only in memory, albumKeys cache), `web/src/api.ts` (typed fetch client), `web/src/screens/Auth.tsx`, `web/src/App.tsx` routing (signed-out → Auth, else Albums)

Signup flow: newSalt → deriveFromPassword → generateIdentityKeypair → encryptPrivateKeyBackup → POST /signup → store keys in vault. Login flow: GET salt → derive → POST login → decrypt backup → vault. Manual verification step (browser) since UI; logic functions unit-tested where practical.

### Task 8: Albums + share/upload + gallery with deterrence

**Files:**
- Create: `web/src/screens/Albums.tsx`, `web/src/screens/AlbumView.tsx`, `web/src/photo-pipeline.ts`, `web/src/components/SecureImage.tsx`, `web/src/components/SafetyNumber.tsx`

`photo-pipeline.ts`: file → `createImageBitmap` → draw to canvas (this strips EXIF) → full JPEG (max 2560px) + thumb (max 400px) → `encryptPhoto` each → upload. `SecureImage`: decrypts to ImageBitmap, draws to `<canvas>`, tiles semi-transparent watermark `viewer email · date` at 30°; `oncontextmenu`/`dragstart` prevented; document-level `visibilitychange` toggles CSS blur class on gallery root. Album view polls `GET events?after=` every 5s (SSE upgrade later).

### Task 9: PWA + deterrence polish

**Files:**
- Create: `web/public/manifest.webmanifest`, `web/src/sw.ts` (vite-plugin-pwa), global CSS (`user-select:none` on media, `-webkit-touch-callout:none`)

### Task 10: End-to-end proof

**Files:**
- Create: `e2e/share-flow.spec.ts` (Playwright, two browser contexts)

Alice signs up, creates album, uploads fixture photo; adds Bob; Bob logs in, sees photo, pixels match fixture after decrypt; direct fetch of blob URL without auth → 401; blob bytes on disk do not contain JPEG magic bytes (proof of encryption at rest). Also: grep guard test that `server/src` contains no DELETE route or SQL.

## Self-review notes

- Spec coverage: EC2/S3/Postgres/Caddy deployment and Web Push/SSE are deliberately post-MVP; interfaces (`Db`-shaped repos, `BlobStore`, polling→SSE) leave clean seams. All other spec sections map to tasks above.
- Types consistent: all B64-suffixed strings are base64; keys are `Uint8Array`.
