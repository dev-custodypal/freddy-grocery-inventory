# Sheet & Apps Script guide

Reference for the Google Sheet side: tabs, stocktake review, provisioning plan.
For installing the phone app, see the main README.

---

## 1. Create the Sheet (laptop, 5 min)

1. Create a new Google Sheet, name it e.g. **Boat Provisioning**.
2. **Extensions → Apps Script**. Delete the sample code and paste all of `apps-script/Code.gs`. Then **+ → Script**, name it `QrLib`, and paste all of `apps-script/QrLib.gs`. Save.
3. In the function dropdown pick **setup** → **Run**. Approve the permissions
   (if you see "Google hasn't verified this app": *Advanced → Go to … (unsafe)* — it's your own script).
4. Fill in the **Lockers** tab: one locker per row (e.g. `Floor`, `Saloon seat`, `Galley 1`). Put the ones you use most at the top.
5. Copy the **API key** from the execution log (or later: Sheet menu **⚓ Provisioning → Show API key**).

Tabs created:

| Tab | What it is |
|---|---|
| **Items** | One row per product: barcode, name, size, category, **On Hand**, **Min Qty**, **Est Use / Person / Week**, **Locker** |
| **Log** | Every add/remove/stocktake adjustment, timestamped. Drives the usage rates. |
| **Wishlist** | Scanned wishes + auto-added low-stock items. Status Open → Bought when you scan it back in. |
| **Stocktake** | Raw count scans from the phone. |
| **Stocktake Review** | Built on demand: expected vs counted. |
| **Plan** | Provisioning calculator. |
| **Lockers** | The master list of locker names, in the order you want them on the phone. Column A = name, B = notes. |

## 2. Deploy the endpoint (3 min)

1. In Apps Script: **Deploy → New deployment → ⚙ → Web app**.
2. Execute as: **Me**. Who has access: **Anyone**. Deploy, copy the **Web app URL** (ends in `/exec`).
3. Test in a private/incognito browser window: `YOUR_URL?key=YOUR_KEY&action=ping` → should show `"Connected ✓"`.

> Changed the code later? **Deploy → Manage deployments → ✏️ → Version: New version**. The URL stays the same; a plain save does *not* update the live endpoint.

The URL + key together are the password. Don't post them anywhere.

### Already set up an earlier version?
Paste the new `Code.gs` (and add `QrLib.gs`), run **setup** again (it keeps your data and API key, and fills the Lockers tab from lockers already used in Items), then **Deploy → Manage deployments → New version**.

## 4. How you use it

**Unloading groceries** → Add mode. Pick the locker you're stowing into at the top of the app, then scan, set the quantity, scan the next item. The locker is added to the item's locker list if it isn't there already, so the same product can live in several places. Example: milk with bulk stock under the saloon seat and a few in the floor locker → Locker = `Saloon seat, Floor`. Unknown barcodes are looked up on Open Food Facts; if that finds nothing, you type a name once.
Adding an item also ticks it off the wishlist.

**Taking something out** → Use mode. One scan = −1. No locker prompt: the system tracks the total aboard, not which locker it came from. If On Hand drops to **Min Qty**, the item goes on the wishlist automatically (it suggests restocking to 2× Min — adjust in the Wishlist tab).

**"We should buy this"** → Wish mode.

**Moving stock between lockers** (bulk store → quick access): don't scan anything. Moves don't change the total aboard. The system tracks one total per item plus a list of the lockers where it lives.

**Stocktake** (one locker at a time) → Count mode, pick the locker, scan everything in it, set the quantity per product.
Then on the laptop: **⚓ Provisioning → Build stocktake review**.
- 🟥 Red = expected in that locker but not scanned (unticked; tick it if it's really gone).
- 🟨 Yellow = count differs.
- Edit **New On Hand** if needed → **⚓ Provisioning → Apply stocktake review**.

- 🟧 Orange = **partial**: the item also lives in a locker you didn't count this session (e.g. you counted the floor but not the saloon seat). It's unticked, because applying it would wrongly cut the total. Count its other locker too (same day), then rebuild the review.

Practical rule: for items with bulk + quick-access stock, count both lockers in the same session.

**Items with no barcode** (produce, bulk rice, market goods): add a row in **Items** with a made-up code like `RICE-BULK` and edit **On Hand** directly on the laptop.

## 5. Laptop housekeeping (once, then occasionally)

In **Items**, fill in for anything that matters:
- **Locker**: one or more, comma-separated (`Saloon seat, Floor`), using names from the **Lockers** tab. Filled in automatically when you add or count; needed for the stocktake checks

**Lockers tab:** add, rename or reorder lockers here. The phone app picks up the list when it opens, or from Settings → Test connection. A locker name the phone sends that isn't on the list is rejected with a message, so typos can't create phantom lockers. If you rename a locker, also update it in the Items tab's Locker column.
- **Min Qty**: triggers the low-stock wishlist
- **Est Use / Person / Week**: your best guess, used until real data exists
- **Category**: lets you sort the Plan

## 6. Provisioning plan

**⚓ Provisioning → Refresh provisioning plan** (run this whenever new items have been added).

Inputs (yellow, top of **Plan**): voyage crew, voyage weeks, safety buffer, crew aboard while logging, usage window, minimum logged uses before the measured rate is trusted.

For each item:
- **Used in window** = logged removals + unlogged use found by stocktakes (negative adjustments). This means forgotten scans still count.
- **Measured / person / wk** = that ÷ days logged × 7 ÷ crew while logging
- **Rate used** = measured if there are enough data points, otherwise your estimate
- **To buy** = rate × crew × weeks × (1 + buffer) − on hand, rounded up

Sort or filter **To buy > 0** on the laptop and that's your shopping list.
