# Deploying PicVault on a Windows laptop (with a friend abroad)

The setup: your old Windows laptop runs PicVault; Tailscale gives you and your
friend a private encrypted tunnel to it from anywhere in the world, with real
HTTPS (required for camera, PWA install, and Together mode). The laptop is
never exposed to the public internet.

## 1. Prepare the laptop

1. Install **Node.js LTS** → https://nodejs.org (choose 64-bit Windows installer).
2. Copy the whole `picvault` folder to the laptop (e.g. `C:\picvault`), or push
   the project to a private Git repo and clone it there.
3. In a terminal (PowerShell) on the laptop:
   ```powershell
   cd C:\picvault
   npm install
   npm run build -w web        # builds the app the server will serve
   ```
4. Create the secret the login tokens are signed with (once):
   ```powershell
   [System.Environment]::SetEnvironmentVariable('PICVAULT_JWT_SECRET', [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 })), 'Machine')
   ```
5. Test run:
   ```powershell
   npm run start -w server
   ```
   You should see `PicVault listening on :8787 (serving web app + API)`.
   Open http://localhost:8787 on the laptop — the app should load. Stop with Ctrl+C.

## 2. Keep it running (auto-start on boot)

Task Scheduler, once:
```powershell
schtasks /Create /TN "PicVault" /SC ONSTART /RU SYSTEM ^
  /TR "cmd /c cd /d C:\picvault\server && npm run start"
schtasks /Run /TN "PicVault"
```

Power settings — the laptop must not sleep:
- Settings → System → Power: **Never sleep when plugged in**.
- Bonus of laptops-as-servers: the battery is a free UPS. Keep it plugged in.
- Optional: close-lid action → "Do nothing".

## 3. Tailscale (the private tunnel)

1. On the laptop: install Tailscale → https://tailscale.com/download, sign in
   (Google/Microsoft/GitHub account works), right-click tray icon → note the
   machine name.
2. Enable HTTPS + expose the app to your tailnet only:
   ```powershell
   tailscale serve --bg 8787
   ```
   This prints your app's private URL, like
   `https://laptop-name.tail1234.ts.net` — with a real certificate,
   reachable only by devices in your tailnet.
   (If it asks you to enable HTTPS/MagicDNS first, do so in the admin console
   link it prints — one click.)
3. **Your phone:** install the Tailscale app, sign in with the same account,
   toggle it on. Open the URL from step 2 in the browser → PicVault loads.
   Use "Add to Home Screen" to install it as an app.
4. **Your friend (different country — this is the built-in path):**
   - They create their own free Tailscale account and install the app on their phone.
   - You open https://login.tailscale.com/admin/machines, click the laptop →
     **Share** → send them the link. They accept.
   - The laptop now appears in *their* Tailscale app; same URL works for them.
   - Distance doesn't matter: Tailscale connects your devices directly over
     the internet, encrypted end-to-end (WireGuard).

## 4. Why Together mode just works

The WebRTC config deliberately has no STUN/TURN server. Over Tailscale both
phones have direct addresses to each other (100.x.y.z), so the peer-to-peer
video connects through the tunnel with zero third parties involved.

## 5. Backups (the no-delete promise needs them)

On EC2 this was S3 Object Lock; on a laptop, the guarantee is the app (no
delete paths, enforced by tests) plus copies. Schedule a mirror to a second
drive or USB stick (adjust `E:`):

```powershell
schtasks /Create /TN "PicVault Backup" /SC DAILY /ST 03:00 /RU SYSTEM ^
  /TR "robocopy C:\picvault\server E:\picvault-backup picvault.db* /XO & robocopy C:\picvault\server\blobs E:\picvault-backup\blobs /E /XO"
```

Everything in the backup is ciphertext — a stolen USB stick reveals nothing.

## 6. Updating the app later

```powershell
cd C:\picvault
git pull            # or copy the new files over
npm install
npm run build -w web
schtasks /End /TN "PicVault" & schtasks /Run /TN "PicVault"
```

## Threat-model notes, honestly

- Photos, names, captions, comments: encrypted on the phones; the laptop
  stores ciphertext only. Whoever steals the laptop learns how many photos
  exist and when they were added — never what's in them.
- The laptop is not reachable from the public internet at all; only the two
  Tailscale identities you approved can even see the port.
- Tailscale coordinates connections but cannot read traffic (WireGuard keys
  never leave your devices). If you ever want zero third parties, the same
  setup works with self-hosted Headscale.
- The no-delete rule is app-enforced here. The laptop's owner (you) could
  always destroy the disk itself — that was true of any self-hosted option.
