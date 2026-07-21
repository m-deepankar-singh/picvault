# PicVault v2 — Full Gallery Design Spec

**Date:** 2026-07-22
**Status:** Awaiting user approval
**Scope (user-selected):** A Core gallery + B Capture & media (incl. video now) + C the "us" layer. Export: never, for anyone. Notifications: content-free pings, deferred to a later phase. E2EE, append-only, and no-external-services rules all carry over from v1.

## Ground rules (unchanged from v1)

- Server sees only ciphertext and minimal metadata; all new fields that carry meaning (captions, comments, reactions, tags, album kinds) are encrypted under the album key.
- Append-only: nothing gets a delete path. This turns "move photo" into **copy** — a photo can appear in more albums, never fewer. The UI says "Add to album", not "Move".
- No export/download of originals — ever, for either person. The only paths out of ciphertext are the canvas viewer and the encrypted blob store.
- No external services: no CDN fonts, no third-party STUN, no cloud ML.

## Data model additions

```
photo_notes (id, photo_id, album_id, author_id, kind, body_ct, created_at)
  kind ∈ {caption, comment, reaction, favorite}   -- kind is plaintext; body_ct is sealed
media: photos table gains media_type ('photo'|'video') and duration_s (int, video only)
album_events gains kinds: note_added, nudge_sent
```

- `body_ct` is encrypted client-side with the album key (favorites use an empty body). The server learns *that* interaction happened, never what was said. `kind` stays plaintext so the server can return counts cheaply; accepted leak: "N comments exist," same class as blob sizes.
- Copy-to-album: new `photos` row pointing at the **same blob ids**, with the per-photo key unwrapped from the source album key and re-wrapped under the target album key on the client. No re-upload, no re-encryption of blobs.

## Feature design

### A. Core gallery
1. **Timeline** — `GET /api/timeline?after=` returns the caller's photo records across all albums, newest-first, paginated. Client decrypts thumbs and groups by day headers (serif dates, editorial style). After-dark albums' photos appear **only as veiled tiles** unless the timeline is switched to "include after dark" for the session.
2. **Viewer upgrades** — full-screen pager: swipe left/right (pointer events + CSS transform), pinch-zoom and double-tap zoom (transform-origin math, canvas stays the render surface), photo metadata footer (date, uploader, caption).
3. **Favorites** — heart on any photo (a `favorite` note). Filter chip "Favorites" in album and timeline.
4. **Captions & comments** — one caption (editable by uploader; edits append a new caption note, latest wins) + threaded-flat comments below the viewer. Both encrypted.
5. **Filters** — by uploader (you/them), favorites-only, date range. All client-side over decrypted metadata.
6. **Add-to-album** (copy) — from the viewer, pick a destination album; client re-wraps keys.

### B. Capture & media
7. **Multi-select upload** — `<input multiple>`; sequential encrypt+upload with a progress strip (n of m); failures retry individually without losing the batch.
8. **Video** — record via MediaRecorder (webm/mp4, camera modal gains a record button with a 60s cap) or pick a file. Encryption: the file is split into **4 MB chunks**, each chunk sealed with the per-video key (chunk index in the nonce derivation); chunks upload sequentially with progress; a manifest (chunk count, sizes, duration) is encrypted alongside. Playback: chunks fetch → decrypt → assemble into a MediaSource buffer; nothing plaintext ever hits disk. Poster frame = encrypted thumb like photos. Server change: `POST /api/albums/:id/videos` accepting chunked parts + manifest, body limit per chunk.
9. **Camera niceties** — 3s/10s self-timer, rule-of-thirds grid overlay, torch toggle where supported (`ImageCapture`), and the same flip/mirror behavior as v1.

### C. The "us" layer
10. **Memories** — client-side: on open, look for photos taken 1/6/12 months ago this week; show a serif "From our archive" card on the albums screen. Pure client computation, zero server involvement.
11. **Streaks** — consecutive days where both partners contributed at least one item; computed client-side from event timestamps; a small mono counter in the masthead. No server counters.
12. **Reactions** — long-press a photo → small emoji row (❤️ 😂 😮 🥺 🔥); stored as encrypted notes; rendered as a tiny cluster on tiles.
13. **Photo requests** — "ask for a photo" button: appends an encrypted `nudge_sent` event; partner sees a banner "They'd love a photo right now" via the existing 5s poll (later: the content-free push ping). Accepting opens the camera straight into the chosen album.

## Later phase (recorded, not in this round)
- Content-free web push ("PicVault — something new"), offline cache, EC2+TLS deploy with S3 Object Lock and self-hosted coturn for Together-over-internet.

## Build order
1. Timeline + viewer pager/zoom (pure client + one read endpoint)
2. Notes API (favorites, captions, comments, reactions) + UI
3. Multi-upload + camera niceties
4. Add-to-album copy flow
5. Video (chunked pipeline, capture, playback)
6. Memories, streaks, photo requests
Each step lands fully tested (unit + API integration) before the next; no-delete guard test extends to the new tables.
