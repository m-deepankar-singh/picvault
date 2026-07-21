# PicVault — Project Context & Handoff

Last updated: 2026-07-22. This file is the resume point for a fresh session.
Read this first, then `git log` and the specs under `docs/superpowers/`.

## What PicVault is

A **privacy-first, end-to-end-encrypted photo & video sharing PWA for two people**
(1:1, with small-group support latent in the schema). Runs in the phone browser —
**no app install**, **phone-only** (desktops get a refusal screen). Self-hosted;
the server only ever stores **ciphertext** and minimal metadata and can never
decrypt anything.

Repo: https://github.com/m-deepankar-singh/picvault (private, branch `main`).

## Hard rules (never violate these)

1. **E2EE by construction** — all crypto lives in `web/src/crypto/`. No plaintext
   photo/video bytes or unwrapped keys ever reach the server.
2. **No-delete / append-only** — there are NO delete HTTP routes, NO `DELETE FROM`
   SQL, and repositories expose no delete methods. Enforced by an automated guard
   test (`server/src/db/__tests__/repos.test.ts` → "no-delete guarantee"). "Move"
   is implemented as **copy** (re-wrap keys, same blobs).
3. **No export/download of originals** — ever, for either person.
4. **No external services** — no CDN fonts, no third-party STUN/TURN, no cloud ML.
   Everything is self-contained.
5. **Metadata hygiene** — EXIF stripped client-side (canvas re-encode) before
   encryption. Album name AND its kind (normal/after-dark) are encrypted together,
   so the server cannot tell a spicy album from any other.

## Architecture

npm-workspaces monorepo, Node 24 + TypeScript throughout.

- `shared/` — API request/response types shared by both sides.
- `server/` — Fastify 5 API. **better-sqlite3** (dev; behind a thin `Db` type,
  Postgres-swappable later), **DiskBlobStore** (dev; S3-swappable). **jose** JWTs
  (HS256, 7d, secret from `PICVAULT_JWT_SECRET`). Also serves the built web app in
  production (`@fastify/static`) so ONE process = whole deployment.
- `web/` — Vite + React 18 PWA. **libsodium-wrappers-sumo** for crypto, **idb**
  for the device vault.

### Crypto design (`web/src/crypto/`)
- Password → Argon2id → 64 bytes, split: first 32 = master key (stays on device),
  last 32 = auth hash (sent to server, which scrypt-rehashes it). Server can never
  reconstruct the master key. (Bitwarden/Proton pattern.)
- Identity: X25519 keypair per user. Private key in IndexedDB; a copy encrypted
  with the master key is stored server-side for multi-device recovery.
- Album key: random XChaCha20/secretbox key, sealed-box-wrapped per member's
  public key.
- Per-photo & per-video keys: random, wrapped under the album key. Lets you add
  members / copy to albums by re-wrapping, never re-encrypting blobs.
- Video: chunked into 4 MB pieces, each secretbox-sealed independently, streamed
  back via MediaSource on playback.
- Safety numbers (`safety.ts`): per-pair hash of both pubkeys for out-of-band
  MITM verification.

### Server routes (all `/api/...`)
- `auth.ts` — signup, login, salt (no user-enumeration), me, users/pubkey.
- `albums.ts` — create/list/get album, add member, list events (append-only hash
  chain), nudge.
- `photos.ts` — upload photo, list album photos, serve blob/thumb (member-only).
- `gallery.ts` — timeline, notes (favorite/caption/comment/reaction — kind is
  plaintext for counts, body is ciphertext), copy-to-album, video upload
  (blobs + register), chunk serving.
- `rtc/signal.ts` — WebRTC signaling over WebSocket for "Together" capture.
  Relays opaque SDP/ICE between album members only; video is P2P (DTLS-SRTP),
  server never sees frames. In-memory rooms, nothing persisted.

### DB tables
users, albums, memberships, photos (+ media_type/duration_s/chunk_ids),
photo_notes, album_events (hash-chained). Additive-only `migrate()` in
`server/src/db/index.ts` for schema upgrades.

## Features built (all tested & verified in-browser)

- Auth: single adaptive form (no separate signup) — unknown email creates a vault
  silently, wrong password on existing vault says so.
- Albums: two sections — **Everyday** and collapsible **After dark** (own dark UI,
  content veiled until revealed / hold-to-view).
- Timeline tab: all photos across albums, grouped by day, paged, after-dark hidden
  unless opted in for the session.
- Viewer: swipe between items, double-tap zoom, uploader/date footer, favorites
  (append-only toggle), editable captions, comments, emoji reactions — all
  encrypted. **Hold-to-view guard** on after-dark media (blurred except while a
  finger is held — the web's answer to "no screenshot API exists").
- Filters (all/mine/theirs/favorites), video ▶ and favorite ♥ tile badges.
- Multi-select upload with progress + per-file retry.
- Add-to-album (copy via key re-wrap).
- Encrypted video: in-app record (60s cap) or file, chunked upload, decrypted
  playback.
- Camera: solo capture (in-album + from albums screen with album picker), self-
  timer, rule-of-thirds grid, flip, video mode. **Together** (two-phone WebRTC
  live capture with side-by-side / overlay alignment + countdown).
- "Us" layer: Memories ("from our archive"), both-of-you streak counter, photo
  requests ("Ask them for a photo" → banner → opens camera).
- Phone-only gate (desktops refused; dev mode exempt).

### UI direction
Editorial / private-magazine: serif mastheads (Charter/Georgia, no font CDNs),
small-caps eyebrows, dotted table-of-contents album list, edge-to-edge masonry
grid, subtle fade/drift motion (no springy). Follows system light/dark. After-dark
albums force their own aubergine theme. (History: user rejected sleek, pastel/
cutesy-with-bunny-mascot before landing on editorial. Do NOT bring back the bunny
or pastels.)

## Test status
- server: 13 tests pass (`cd server && npx vitest run`).
- web: 7 crypto tests pass (`cd web && npx vitest run`).
- Both typecheck clean (`npx tsc --noEmit` in each).
- Full suite from root: `npm test`.
- Browser-pane screenshots/clicks are flaky in this environment; verification was
  done via `javascript_tool` injected events. On a real phone it behaves normally.

## Known platform limits (told to user, don't re-litigate)
- Web apps CANNOT detect screenshots or block them (iOS blocks even natively).
  Mitigation shipped: hold-to-view + watermark + blur-on-tab-switch + no-save.
  True blocking/detection would require a Capacitor wrapper (Android FLAG_SECURE /
  iOS detect-and-notify) — reverses no-install, on the shelf.
- WebRTC config has NO STUN/TURN on purpose (won't point a privacy app at Google).
  Same-network / Tailscale-tailnet P2P works; internet-wide needs self-hosted
  coturn.

## Deployment — DECIDED: EC2

User is deploying to **EC2** (moved off "old laptop" idea). `DEPLOY.md` currently
documents the Windows-laptop + Tailscale path — **needs an EC2/Ubuntu rewrite**.

**Recommended instance:** `t4g.micro` (ARM/Graviton, 1 GB) ~$6-7/mo, OR free-tier
`t3.micro` for first 12 months. 20-30 GB gp3 (grow live later; disk is the real
constraint since nothing is deleted). Region between the two users (they're in
different countries) for Together-mode latency. Skip ALB/RDS/NAT.

**Recommended access:** Tailscale on the instance (no inbound ports, invisible to
internet, friend gets a share invite, Together works over tailnet). Alternative:
Elastic IP + domain + Caddy (Let's Encrypt) on 443 + coturn for Together.

### NEXT STEPS (pick up here)
1. Rewrite/add EC2 deploy steps: Ubuntu 24.04, install Node LTS, clone repo,
   `npm install && npm run build -w web`, set `PICVAULT_JWT_SECRET`, run under a
   **systemd** unit (replaces the Windows Task Scheduler section), Tailscale
   install (`curl -fsSL https://tailscale.com/install.sh | sh`) + `tailscale serve
   --bg 8787` + share invite for the friend.
2. Backups: nightly copy of `server/picvault.db*` + `server/blobs/` to a second
   EBS volume or S3 (all ciphertext). This replaces the S3-Object-Lock layer from
   the original spec that no-delete relied on for hardware enforcement.
3. Optional later phase (in v2 spec, not built): content-free web push
   notifications, offline cache, self-hosted coturn for cross-NAT Together.

## Run locally
- `npm install` at root.
- Dev: `npm run dev:server` (:8787) and `npm run dev:web` (:5173, proxies /api).
- Prod single-process: `npm run build -w web` then `npm run start -w server`
  (serves app + API on :8787; set `PICVAULT_JWT_SECRET`).
- Test users seeded during this session's dev DB: alice@test.dev /
  alice-super-secret-42, bob@test.dev / bob-super-secret-99 (dev DB only; not in
  git — `*.db` is gitignored).

## Docs
- `docs/superpowers/specs/2026-07-22-picvault-design.md` — v1 spec.
- `docs/superpowers/specs/2026-07-22-picvault-gallery-v2-design.md` — v2 gallery.
- `docs/superpowers/plans/2026-07-22-picvault-mvp.md` — MVP build plan.
- `DEPLOY.md` — deploy guide (currently Windows-laptop; rewrite for EC2).
