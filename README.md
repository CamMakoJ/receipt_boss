# Receipt Boss

Self-hosted receipt tracker for projects. Runs on your own machine, reachable from your phone over Tailscale.

- **Projects** with receipts grouped into **Billable** / **Non-billable**, with running totals.
- Each receipt tracks **subtotal, GST, PST and tip** separately (total = sum). Per-project GST/PST rates give an "Auto GST/PST" button; you can always override the amounts to match the printed receipt.
- Add receipts from **phone (camera) or desktop**. Photos are resized/converted to JPEG in the browser.
- **Works offline**: the app is a PWA. Receipts added with no connection are saved on the device and sync automatically when the server is reachable again.
- **Export** a project (optionally date-ranged) as a zip:
  ```
  Project-Name_receipts/
    report.pdf      summary + billable/non-billable tables + one page per receipt image
    report.csv      one row per receipt (opens cleanly in Excel)
    receipts/001_Lumber-for-deck.jpg   <- receipt number + description
  ```
  PDF and CSV are also available on their own.

## Run

Requires Node 22.13+. No database server and no native modules (uses Node's built-in SQLite).

```bash
npm install
npm start            # http://127.0.0.1:3000
```

| env var    | default     | meaning                                   |
|------------|-------------|-------------------------------------------|
| `PORT`     | `3000`      |                                           |
| `HOST`     | `127.0.0.1` | use `0.0.0.0` to expose on your LAN       |
| `DATA_DIR` | `./data`    | SQLite DB (`receipts.db`) + `images/`     |

**Back up `DATA_DIR`** – that is everything.

## Phone access via Tailscale

Offline mode and "install to home screen" need HTTPS, and `tailscale serve` provides that:

```bash
npm start &
tailscale serve --bg 3000      # https://<machine>.<tailnet>.ts.net
```

Open that URL on your phone (signed in to the tailnet) and choose *Add to Home Screen*. The server listens only on localhost by default, so it is reachable only through Tailscale. There is no login: anyone on your tailnet can use it, so don't expose it publicly (e.g. Tailscale Funnel).

Open the app once while online so the app shell and project list get cached.

## Offline behaviour

| Offline you can… | Offline you can't… |
|---|---|
| open the app, browse projects and receipts you've already viewed | create/edit/delete projects |
| add new receipts (queued on the device; shown as "Waiting to sync") | edit/delete existing receipts |
| | export (needs the server) |

Receipt numbers are assigned by the server when a queued receipt syncs. Syncing is idempotent, so a retry never duplicates a receipt.

## Notes

- Money is stored as integer cents.
- Receipt numbers are per project and are never reused after deleting a receipt.
- One image per receipt.

## Tests

```bash
npm test    # needs poppler-utils (pdftotext) and unzip for the export checks
```
