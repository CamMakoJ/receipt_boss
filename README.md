# Receipt Boss

Self-hosted receipt tracker. Runs on a machine on your LAN, used from phones/computers over HTTPS (LAN or Tailscale).

## Features

- **Accounts.** First visit creates the admin; the admin adds family members. Each user's projects and receipts are private to them.
- **Projects → receipts**, grouped Billable / Non-billable with running totals.
- **Per receipt:** date, vendor, **province**, **category**, description, subtotal, **GST/HST**, **PST/QST**, tip (kept separate), and **up to 12 photos**.
  - **Auto-calculated taxes** from subtotal + the receipt's province (all 13 provinces/territories; HST provinces put the HST in the GST/HST box). Tips are never taxed. Type your own tax amount any time and auto-calc switches off for that receipt.
  - **Category → description:** pick a category (or type your own) and the description fills in with it; edit the description and it stays yours. Blank descriptions default to the category.
- **Photo → crop → read.** Taking or choosing a photo opens a full-screen **crop screen**: the receipt is auto-outlined with four free corners (drag any corner onto the paper's corner — a magnifier shows the exact spot under your finger — or drag an edge/the whole outline; rotate, Reset, Auto). **Done** flattens the outline into an upright rectangle (**perspective correction**, so photos shot at an angle come out straight), then reads the receipt text and **pre-fills** vendor, date, province (from the postal code), category (from the vendor), subtotal, GST/HST, PST/QST and tip. Filled fields are highlighted yellow for you to check; if a figure couldn't be read clearly but the total pins it down, it is filled from the total and called out by name. Reading runs **on your device** (Tesseract in WebAssembly, served by this app) — no image or text is sent anywhere, and it works offline. Household items get date, vendor and price. Switch auto-reading off with the checkbox under the photo buttons; **🔍 Read text** re-runs it on the current photo.
- **Several photos per receipt or item.** Add as many as you need — a long receipt in two halves, or for a household item the receipt *plus* the warranty card *plus* the serial-number sticker. Each photo goes through the crop screen and is read; the first is the **cover** (shown in lists — tap ★ on another to make it the cover), ✕ removes one, tap a thumbnail to view it full screen. Reports get a page per photo (`001_description.jpg`, `001_description_2.jpg`…), the AI check looks at all of them together, and the text of every page is searchable.
- **Quick capture & Inbox.** For a stack of receipts (a day in the field), open **⚡ Quick capture** from the Projects page: choose the project once, then just tap **Capture** for each receipt — no forms. Each photo is auto-cropped (with perspective correction), read in the background, matched to your usual category/billable setting for that store, and saved to your **Inbox** as a *draft*. Drafts are **not** counted in totals, reports, search or duplicate checks until you review them: **Inbox → Review them one by one** opens each with the details pre-filled, **File receipt** files it and jumps to the next. It works offline too — captures are stored on the device the moment you take them and sync when the connection returns.
- **Vendor memory.** Once you've filed a store at least twice with a clear habit (≥60% the same category, ≥70% the same billable/non-billable choice), typing or scanning it pre-fills that — e.g. *Home Depot → Materials, billable* — and says so. Store names are matched without store numbers, case or "Inc/Canada" (*HOME DEPOT #7011* = *Home Depot*). A store-name autocomplete uses your history too, which keeps spelling consistent. It never changes an already-filed receipt, and it never overrides something you chose by hand.
- **Report export** per project (optional date range): PDF (summary, billable and non-billable tables with province & category, then one page per receipt image) + CSV + `receipts/001_description.jpg` — all in one zip, or PDF/CSV separately.
  - *Auto-calculate missing GST/PST* option (on by default): receipts saved with **no** tax get an estimate from their own province, marked `*` in the PDF and "Tax estimated = Yes" in the CSV. Nothing is changed in the database.
- **Invoiced / paid tracking.** Billable receipts are *unbilled → invoiced → paid*. Tap **Select** on the Billable list to mark several at once, or use **Create invoice bundle…**: it marks the unbilled billable receipts in the date range as invoiced under your invoice number and downloads a bundle of just those (PDF titled with the invoice number), so nothing is billed twice. The project summary shows unbilled / invoiced / paid totals; exports can be filtered by status or invoice number, and the CSV has *Billing status* and *Invoice* columns.
- **Duplicate warning.** Saving a receipt with the same date, vendor (or description) and total as one you already entered — in any of your projects — asks before saving. Offline entries that turn out to be duplicates are held at sync time with a *Save anyway* button. Household items are compared by name + date + price.
- **Search & filters.** The Household page (and *Search all receipts* on the Projects page) has a search box plus filters — category, warranty status, store, date range, price range, sort — with removable chips. Search covers names, stores, serial numbers, notes **and the text read from the photo**. It runs on the device, so it is instant and works offline.
- **Local AI (optional).** Connect any OpenAI-compatible server on your network (see *Local AI* below) for a second-opinion check of work receipts and for **✨ Ask** search.
- **Household items & warranties** (TV, fridge, laptop…): item, purchase date, price, vendor, serial, receipt photo, and warranty length (months/years, or unknown). Shows warranty end date and groups into *ending soon (90 days) / under warranty / unknown / expired*. Shared by everyone on the server. CSV export.
- **Backups** of everything (database, accounts, all images) to a local folder, another folder, and/or **Google Drive**; scheduled or on demand; optionally **encrypted with a passphrase** (AES-256).
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

`npm install` also copies the OCR engine and English model into `public/vendor/tesseract/` (~15 MB, git-ignored; the browser downloads only ~7 MB of it, once, on the first scan and caches it). If that step was skipped, run `node scripts/vendor-ocr.js`; without it the app still works, just without auto-reading.

Open the URL, create the admin account, then add family under **⚙ Settings → Users**. A sample systemd unit is in `deploy/receipt-boss.service`.

## Local AI (optional)

Any server that speaks the OpenAI chat API works — **Ollama**, **LM Studio**, **llama.cpp**, **vLLM** — on this machine or another one on your network. Configure it in **⚙ Settings → Local AI** (admin): server address, model name, tick *vision* if the model can look at images, **Test connection**. Requests go only to the address you enter. The API key (if any) is write-only in the UI and is left out of backups.

Example with Ollama (a vision model so it can look at the receipt photo; a text-only model also works — it then reads the text scanned from the photo):
```bash
ollama pull qwen2.5vl:7b            # or: llama3.2-vision, gemma3, ...   text-only: qwen2.5:7b
# Settings → address http://localhost:11434/v1 → model qwen2.5vl:7b → tick "can look at images"
```

**What it does**
- **Double-check of work receipts.** After you save a receipt (automatically, or **✨ Check now** on the receipt), the model reads the receipt *without seeing what you typed*, and the app compares its reading with your entry. Differences show up as ⚠ on the project list and in a card on the receipt, with a one-tap **Use $84.75** to fix a field. Plain rules add notes (date in the future, taxes that don't match the province's standard rate). Checks run one at a time in the background, so saving is never blocked; if the AI server is down the receipt is simply marked "couldn't be checked".
- **✨ Ask search.** Type a sentence — *the fridge from Home Depot last year under $2000* — and tap ✨ Ask. The model turns it into the same filters you can set by hand (including synonyms like *refrigerator*); they appear as chips you can remove. It never sees your data beyond the list of categories and store names used to ground the request.

The model only *reads* and *translates*; matching amounts, dates and filtering are done by ordinary code. Small local models still misread sometimes — treat ⚠ as "take a look", and a clean ✓ as a second opinion, not a guarantee. Slow models: raise the timeout in settings. The first check after loading a model can take a while.

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

Each backup is `receipt-boss-backup-YYYYMMDD-HHMMSS.zip` (`.zip.enc` when encrypted — see below). Retention ("copies to keep") is applied locally, in the extra folder, and on Drive — only to files with that exact name pattern. Login sessions are never included. The status line in Settings shows the last result, including upload errors. **Download backup** gives you a fresh zip on the spot. You can also set a *folder on the server* (a NAS, or a Google-Drive-for-desktop folder) instead of / in addition to rclone.

### Encrypting backups

Receipts hold personal and financial details, so you may not want readable copies sitting in Google Drive. In **Settings → Backup** tick **Encrypt backups with a passphrase** and enter one (10+ characters). From then on every backup — the local copy, the extra folder, the Drive upload and **Download backup** — is **AES-256-GCM** encrypted (key derived from your passphrase with scrypt; a wrong passphrase, a damaged file or tampering is always detected). Nothing readable leaves the server.

- **Do not lose the passphrase.** There is no recovery: without it, encrypted backups cannot be opened. Keep it in your password manager.
- **Verify now, not during a disaster.** Once an encrypted backup exists, **Verify I can decrypt** (under the backup settings) checks your passphrase against the newest one.
- **Where the passphrase lives.** It is stored on the server so scheduled backups can run unattended, and it is **never included in a backup** or shown in the UI. That protects backups *at rest elsewhere* (Drive, a NAS, a lost USB stick); it does not protect against someone who already controls the server itself.
- Prefer not to keep the key on the server at all? Leave this off and use rclone's own `crypt` remote for the Drive copy instead (`rclone config` → *crypt*).

**Restore** (stop the server first):
```bash
DATA_DIR=/var/lib/receipt-boss node scripts/restore.js receipt-boss-backup-20261117-020000.zip
# encrypted: it asks for the passphrase (or set RB_BACKUP_PASSPHRASE for a non-interactive run)
DATA_DIR=/var/lib/receipt-boss node scripts/restore.js receipt-boss-backup-20261117-020000.zip.enc
```
Current data is moved to `pre-restore-<timestamp>/` inside `DATA_DIR`, not deleted.

## Offline behaviour

Open the app once while online. Then, offline you can browse what you've already viewed and **add receipts and household items** (queued, shown as "Waiting to sync"). You can't edit/delete existing records, create projects, change settings or export until you're back online. Queued items are tied to the signed-in user. Syncing is idempotent (no duplicates on retry). Receipt numbers are assigned by the server when a receipt syncs. **Quick capture works offline** (the reading happens on the device); captures wait on the device and arrive in the Inbox when the connection returns.

## Notes & limits

- **Drafts and numbering.** A quick-capture draft has no receipt number (it shows as a draft) and takes the next number for its project only when you file it, so deleting drafts never leaves gaps. Quick capture does not keep the uncropped original — if the automatic crop looks wrong in the list, delete that draft and re-shoot with *Let me adjust the crop* ticked.
- **Photos:** up to 12 per receipt/item. The AI check sends up to the first 4 photos of a receipt.

- **Duplicate matching** is exact: same day, same vendor text (case-insensitive) and same total to the cent. Near-misses are not flagged.

- **Perspective correction needs all four corners of the receipt in the photo.** If the paper runs off the edge of the frame, the outline's corners there are guesses and the straightening will be slightly off — retake with the whole receipt visible (very long receipts: shoot in two halves, or crop to the part you need).
- **Receipt reading is best-effort.** It is English-only, works best on a flat, well-lit, tightly cropped photo, and can't read handwriting (a handwritten tip is entered by hand). It sometimes misreads a digit — that's why filled fields are highlighted, and why it never saves anything for you. The first scan on a device takes a few seconds longer while the engine loads.

- **Tax rates** live in `server/tax.js` (current standard rates; NS is 14% HST). Auto-calc applies the *standard* rate to the whole subtotal — it doesn't know about exemptions (e.g. BC PST on restaurant meals, zero-rated groceries). Override the amounts when a receipt shows something different; the printed receipt always wins.
- Money is stored as integer cents. Receipt numbers are per project and never reused.
- One photo per receipt/item. Photos are re-encoded as JPEG in the browser (max 2200 px).
- Security: passwords are scrypt-hashed; sessions are 30-day `HttpOnly`/`SameSite=Lax` cookies (`Secure` over HTTPS); repeated failed logins are throttled; state-changing requests require a custom header. Admin-only: users and backups. Admins can't read other users' receipts through the app, but anyone with access to the server's `DATA_DIR` can.
- Household items are deliberately shared across accounts.

## Tests

```bash
npm test    # needs poppler-utils (pdftotext, pdfimages) and unzip
```
