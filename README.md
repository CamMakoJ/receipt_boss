# Receipt Boss

Self-hosted receipt tracker. Runs on a machine on your LAN, used from phones/computers over HTTPS (LAN or Tailscale).

## Features

- **Accounts.** First visit creates the admin; the admin adds family members. Each user's projects and receipts are private to them.
- **Projects → receipts**, grouped Billable / Non-billable with running totals.
- **Per receipt:** date, vendor, **province**, **category**, description, subtotal, **GST/HST**, **PST/QST**, tip (kept separate), photo.
  - **Auto-calculated taxes** from subtotal + the receipt's province (all 13 provinces/territories; HST provinces put the HST in the GST/HST box). Tips are never taxed. Type your own tax amount any time and auto-calc switches off for that receipt.
  - **Category → description:** pick a category (or type your own) and the description fills in with it; edit the description and it stays yours. Blank descriptions default to the category.
- **Report export** per project (optional date range): PDF (summary, billable and non-billable tables with province & category, then one page per receipt image) + CSV + `receipts/001_description.jpg` — all in one zip, or PDF/CSV separately.
  - *Auto-calculate missing GST/PST* option (on by default): receipts saved with **no** tax get an estimate from their own province, marked `*` in the PDF and "Tax estimated = Yes" in the CSV. Nothing is changed in the database.
- **Household items & warranties** (TV, fridge, laptop…): item, purchase date, price, vendor, serial, receipt photo, and warranty length (months/years, or unknown). Shows warranty end date and groups into *ending soon (90 days) / under warranty / unknown / expired*. Shared by everyone on the server. CSV export.
- **Backups** of everything (database, accounts, all images) to a local folder, another folder, and/or **Google Drive**; scheduled or on demand.
- **Offline**: installable PWA. Receipts and household items added with no connection are saved on the device and sync automatically.

## Run

Requires Node 22.13+ (no database server, no native modules).

```bash
npm install
HOST=0.0.0.0 TLS_CERT=... TLS_KEY=... npm start
```

| env var | default | meaning |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | listen address |
| `TLS_CERT`, `TLS_KEY` | – | PEM files; enables HTTPS (re-read every 12 h, so renewals need no restart) |
| `DATA_DIR` | `./data` | database + images + local backups |
| `TRUST_PROXY` | – | `1` if behind a reverse proxy that terminates TLS (so cookies get `Secure`) |
| `RCLONE_BIN` | `rclone` | path to rclone |

Open the URL, create the admin account, then add family under **⚙ Settings → Users**. A sample systemd unit is in `deploy/receipt-boss.service`.

## HTTPS on your LAN

The phone **camera, offline mode and "install app"** only work on HTTPS, and passwords shouldn't cross the network in clear text, so the server warns loudly if you run it without TLS. Pick one:

**A. `tailscale cert` (no CA to install).** In the Tailscale admin console enable MagicDNS + HTTPS certificates, then on the server:
```bash
sudo tailscale cert --cert-file data/tls/cert.pem --key-file data/tls/key.pem  <machine>.<tailnet>.ts.net
TLS_CERT=data/tls/cert.pem TLS_KEY=data/tls/key.pem npm start
```
Browse to `https://<machine>.<tailnet>.ts.net:3000`. Re-run the cert command monthly (cron). That name resolves to the machine's Tailscale address; to use the same name on the LAN, point it at the LAN IP in your router/Pi-hole DNS — the certificate stays valid.

**B. Your own LAN name + private CA.**
```bash
scripts/make-cert.sh receipts.home.lan 192.168.1.50      # writes data/tls/{cert,key,ca}.pem
```
Install `data/tls/ca.pem` on each phone/computer and mark it trusted (iOS: install profile, then *Settings → General → About → Certificate Trust Settings*; Android: *Security → Install a certificate → CA*). The certificate lasts 397 days; re-run to renew.

**C. Reverse proxy** (Caddy/nginx/Traefik) that terminates TLS, with `TRUST_PROXY=1`.

## Backup to Google Drive

The app never holds Google credentials. It uses [rclone](https://rclone.org), which you configure once on the server.

1. Install rclone (`sudo apt install rclone` or https://rclone.org/install/).
2. As the user that runs Receipt Boss: `rclone config` → **n** (new) → name `gdrive` → storage **drive** →
   client_id/secret: ideally create your own (https://rclone.org/drive/#making-your-own-client-id; the shared one is heavily rate-limited) →
   scope **3 / `drive.file`** (rclone can only see files it created — enough for backups) → on a headless server answer **n** to "auto config" and run `rclone authorize "drive"` on a computer with a browser, pasting the token back.
3. Check: `rclone lsd gdrive:`
4. In **Settings → Backup**: set *Google Drive remote* to `gdrive:ReceiptBoss`, tick *Back up automatically*, pick the interval and number of copies, **Save**, then **Back up now**.

Each backup is `receipt-boss-backup-YYYYMMDD-HHMMSS.zip`. Retention ("copies to keep") is applied locally, in the extra folder, and on Drive — only to files with that exact name pattern. Login sessions are never included. The status line in Settings shows the last result, including upload errors. **Download backup** gives you a fresh zip on the spot. You can also set a *folder on the server* (a NAS, or a Google-Drive-for-desktop folder) instead of / in addition to rclone.

**Restore** (stop the server first):
```bash
DATA_DIR=/var/lib/receipt-boss node scripts/restore.js receipt-boss-backup-20261117-020000.zip
```
Current data is moved to `pre-restore-<timestamp>/` inside `DATA_DIR`, not deleted.

## Offline behaviour

Open the app once while online. Then, offline you can browse what you've already viewed and **add receipts and household items** (queued, shown as "Waiting to sync"). You can't edit/delete existing records, create projects, change settings or export until you're back online. Queued items are tied to the signed-in user. Syncing is idempotent (no duplicates on retry). Receipt numbers are assigned by the server when a receipt syncs.

## Notes & limits

- **Tax rates** live in `server/tax.js` (current standard rates; NS is 14% HST). Auto-calc applies the *standard* rate to the whole subtotal — it doesn't know about exemptions (e.g. BC PST on restaurant meals, zero-rated groceries). Override the amounts when a receipt shows something different; the printed receipt always wins.
- Money is stored as integer cents. Receipt numbers are per project and never reused.
- One photo per receipt/item. Photos are re-encoded as JPEG in the browser (max 2200 px).
- Security: passwords are scrypt-hashed; sessions are 30-day `HttpOnly`/`SameSite=Lax` cookies (`Secure` over HTTPS); repeated failed logins are throttled; state-changing requests require a custom header. Admin-only: users and backups. Admins can't read other users' receipts through the app, but anyone with access to the server's `DATA_DIR` can.
- Household items are deliberately shared across accounts.

## Tests

```bash
npm test    # needs poppler-utils (pdftotext, pdfimages) and unzip
```
