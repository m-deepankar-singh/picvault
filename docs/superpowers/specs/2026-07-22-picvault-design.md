# PicVault — Design Spec

**Date:** 2026-07-22
**Status:** Approved pending user review
**What:** An end-to-end-encrypted photo sharing web app (PWA) for iOS and Android browsers. Two signed-in users (or a small group) share photos into append-only shared albums. The server stores only ciphertext.

## Requirements (as agreed)

1. Works on iOS and Android **without installing an app** → browser-based PWA.
2. **Privacy is the main thing** → end-to-end encryption; the server can never see photo content.
3. Sharing model: **1:1 and small private groups**; both sender and receiver **sign in**.
4. Shared photos are **permanent**: no user, member, or API path can delete them (append-only albums).
5. **Screenshot / save deterrence** (true blocking is impossible on the web platform — see §7): block save/long-press/drag, viewer-identifying watermark, blur on focus loss, optional view-once.
6. Backend is **self-hosted on AWS EC2**, minimal and auditable.

## Non-goals

- Public feeds, followers, discovery, or link-sharing to non-users.
- Server-side image processing of any kind (impossible by design — server sees ciphertext).
- Native/store apps (crypto design ports to React Native later if ever needed).

## Architecture

```
Browser (iOS Safari / Android Chrome)          EC2 instance
┌─────────────────────────┐                   ┌───────────────────────────┐
│ React + TS PWA          │       HTTPS       │ Caddy (auto-TLS)          │
│ ├─ UI layer             │ ────────────────► │  └─ API (Go, ~10 routes)  │
│ ├─ Crypto module        │                   │      ├─ Postgres          │
│ │   (libsodium.js)      │   presigned PUT/  │      └─ presigned URLs ──►│ S3 bucket
│ └─ Local vault          │   GET (ciphertext)│                           │ (Object Lock)
│    (IndexedDB)          │ ────────────────────────────────────────────► │
└─────────────────────────┘                   └───────────────────────────┘
```

The server is deliberately dumb: it authenticates users, stores encrypted blobs and wrapped keys, and routes them between album members. It cannot decrypt anything.

## Cryptography

- **Password split (Bitwarden/Proton-style):** the user's password is run through Argon2id, then HKDF-split into an *auth hash* (sent to server for login) and a *master key* (never leaves the device). Server never holds anything that can decrypt.
- **Identity keys:** X25519 keypair generated in-browser at signup. Private key lives in IndexedDB; a copy encrypted with the master key is stored server-side so logging in on a new device recovers it.
- **Album keys:** each album gets a random XChaCha20-Poly1305 key, wrapped per-member with libsodium sealed boxes (recipient's public key), stored server-side as opaque blobs.
- **Photos:** each photo gets its own random key; full image + client-generated thumbnail are encrypted with it; the per-photo key is wrapped by the album key. New members can be granted history without re-encrypting blobs.
- **Verification:** per-pair "safety number" (hash over both public keys) shown in the UI for out-of-band comparison, defeating server key-substitution MITM.
- **Metadata hygiene:** EXIF (GPS, device, timestamps) stripped client-side *before* encryption, by default. Filenames replaced with random IDs. Server learns only album membership, ciphertext sizes, and upload times.

## The no-delete guarantee

- The API has **no delete endpoints**; its Postgres role has no `DELETE` grant on photo/album/event tables.
- S3 bucket uses **Object Lock in compliance mode** — objects cannot be removed even by the AWS account root until retention expires.
- Each album maintains an **append-only hash chain** of events (photo added, member added); any member's client verifies the chain, so silent removal or reordering is detectable.
- **Open decision (legal):** a literally-forever store conflicts with GDPR erasure rights and unlawful-content takedown duties. Recommendation: keep the user-facing guarantee absolute, but set Object Lock retention to a finite window (e.g. 5 years, renewable) so the operator retains a slow legal-compliance path. To be decided before launch.

## Backend (EC2)

- **API:** Go, single static binary. Routes: signup, login, get/put encrypted key backup, create album, invite member, accept invite, request presigned upload, register photo event, list album events, request presigned download, SSE event stream.
- **Postgres** (on the instance via Docker, or RDS later): `users`, `public_keys`, `key_backups`, `albums`, `memberships`, `wrapped_album_keys`, `photos`, `album_events`.
- **S3:** ciphertext only, written/read via short-lived presigned URLs so image bytes never transit the API process. Object Lock enabled at bucket creation.
- **Realtime:** SSE stream for new-photo events; Web Push for notifications (iOS requires PWA added to home screen, Safari 16.4+).
- **Deployment:** Docker Compose (caddy + api + postgres) on one EC2 instance; Caddy terminates TLS. IAM instance role scoped to the one bucket. Logs minimal; no long-term IP retention beyond rate limiting.

## Client (PWA)

- **React + TypeScript + Vite**, installable to home screen but fully functional in a plain tab.
- **Crypto module:** isolated wrapper around libsodium.js exposing a small typed API (`encryptPhoto`, `wrapAlbumKey`, `verifySafetyNumber`, …). UI code never touches primitives. Unit-tested against libsodium known-answer vectors.
- **Local vault:** IndexedDB for the unwrapped private key (per device), album keys, and decrypted-thumbnail cache.
- **Capture:** `<input type="file" accept="image/*" capture>` for camera/gallery on both platforms.

## Screenshot & save deterrence (§7)

Platform truth: browsers cannot block OS screenshots or screen recording on either platform; iOS forbids blocking even natively. Design is therefore *deterrence + attribution*:

- Photos rendered to `<canvas>` from short-lived blob URLs — no stable URL, no `<img>` long-press "Save image", context menu and drag suppressed.
- **Viewer watermark:** every rendered photo is overlaid with the viewing user's name/ID (subtle, tiled) — any leaked screenshot identifies the leaker.
- Content blurred when the tab/app loses focus (`visibilitychange`) and when screen capture is detected via `getDisplayMedia` heuristics where available.
- Optional per-photo **view-once / timed view** flag set by the sender.
- These are deterrents, not guarantees; the UI copy must not overclaim (no "screenshot-proof" claims).

## Known limitation (documented honestly)

Web-delivered E2EE means the server ships the JavaScript; a compromised server could ship key-leaking code. Mitigations: open-source client, reproducible builds, strict CSP, Subresource Integrity. Full closure of this gap requires an installed app — the crypto design ports cleanly to React Native if that day comes.

## Testing

- Crypto module: known-answer vector tests; round-trip encrypt/decrypt property tests.
- API: integration tests including an explicit "no path deletes data" suite (attempt deletes via every route and raw SQL role check).
- End-to-end: Playwright with two browser contexts (sender + receiver) covering signup → album → share → receive → verify hash chain.
- Manual matrix: iOS Safari and Android Chrome — storage eviction, home-screen install, Web Push.

## Build order (high level)

1. Crypto module + tests (no UI, no server).
2. Go API + Postgres schema + S3 presigning; no-delete test suite.
3. PWA auth + key backup/restore flows.
4. Albums, sharing, upload/download pipeline.
5. Deterrence layer, watermarking, SSE/push.
6. Deployment hardening on EC2 (Object Lock, CSP, backups).
