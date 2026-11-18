# Galley Scan — Freddy grocery inventory

A phone web app (PWA) that scans grocery barcodes into a Google Sheet. Four modes:

| Mode | What a scan does |
|---|---|
| **Add** | Stow items: pick the locker, scan, set quantity |
| **Use** | Take one out. One scan = −1, nothing else to tap |
| **Wish** | Put it on the shopping wishlist |
| **Count** | Stocktake: pick the locker, scan everything in it |

The Google Sheet does the rest on the laptop: stocktake review, provisioning plan, wishlist.
Unknown barcodes are looked up on Open Food Facts; if not found, the app asks for a name once.
No connection? Scans are queued on the phone and sent when Starlink is back.

```
index.html, app.js, styles.css   the app
sw.js, manifest.webmanifest      offline + home screen install
vendor/                          barcode reader (barcode-detector 3.2.4 + zxing-wasm, MIT)
apps-script/Code.gs              Google Sheet backend
apps-script/QrLib.gs             QR generator for the phone setup code (qrcode-generator 2.0.4, MIT)
docs/SHEET-GUIDE.md              the Sheet's tabs, stocktake review, provisioning plan
tests/                           backend tests: node tests/harness.js apps-script/QrLib.gs apps-script/Code.gs
```

---

## 1. Update the Google Sheet backend (laptop)

1. Open the Sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this repo.
3. **+ → Script**, name it `QrLib`, paste all of `apps-script/QrLib.gs`. Save.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** Keep *Execute as: Me* and *Who has access: Anyone*. The URL stays the same.
5. Reload the Sheet so the **⚓ Provisioning** menu picks up **Phone setup QR**.

New to this? Do the one-time setup in [docs/SHEET-GUIDE.md](docs/SHEET-GUIDE.md) sections 1–2 first.

## 2. Publish the app (GitHub Pages)

1. Merge this branch into `main` (or, for a trial, point Pages at this branch).
2. GitHub → repo **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, branch `main`, folder `/ (root)`. Save.
3. After a minute the app is at **https://dev-custodypal.github.io/freddy-grocery-inventory/**

GitHub Pages on a free account needs a **public** repo. That's fine: no keys or URLs are in the code. They live only on the phone.

## 3. Install on the iPhone

1. On the XR, open the Pages URL in **Safari** (not Chrome; only Safari can add web apps to the Home Screen).
2. **Share → Add to Home Screen → Add**. Open **Galley** from the Home Screen from now on.
3. The app opens **Settings** on first run. On the laptop: **⚓ Provisioning → Phone setup QR** (first time it asks for the web app URL ending in `/exec`).
4. On the phone: **Scan setup code**, point at the laptop screen. It saves the URL and key and tests the connection.
5. Allow camera access when asked.

Install from the Home Screen icon *before* scanning the setup code: iOS keeps the Home Screen app's storage separate from Safari's.

## 4. Using it

- Tap the camera area to start. Hold a barcode inside the frame. It beeps when read.
- A barcode reads once, then must leave the frame before it can count again. In **Use** mode, take one can away and bring the next.
- **⌨︎ Type a code** for items without a barcode: use your own code like `RICE-BULK`.
- **Recent** shows the last 30 scans. *Name it* appears for unknown barcodes scanned while offline.
- **⏳ N queued** means scans are waiting for a connection. Tap it to send now. They also go automatically.
- If a scan is retried after a dropped connection, the Sheet only applies it once.

## 5. Updating the app later

1. Change the files, and bump `VERSION` in **both** `app.js` and `sw.js`.
2. Push to `main`. The phone picks up the new version the next time the app opens while online. It may take two launches.

If the backend (`Code.gs`) changes: paste it in and **Deploy → Manage deployments → New version**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Google sent a web page, not data" | URL must end in `/exec`; deployment access must be **Anyone** (not "Anyone with Google account"). |
| "Wrong API key" | Re-scan the setup code. |
| Camera never starts | iOS Settings → Safari → Camera → Allow. Then close and reopen the app. |
| Asks for camera permission every launch | Known iOS behaviour for Home Screen web apps on some versions. Tap Allow. |
| Locker list empty | Fill the **Lockers** tab in the Sheet, then Settings → Test connection. |
| New QR after a redeploy shows the old URL | In Apps Script run `resetWebAppUrl`, then Phone setup QR again. |
