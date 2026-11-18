/**
 * Boat Provisioning — Google Sheets + Apps Script backend
 *
 * One file. Paste into Extensions → Apps Script, run setup(), then deploy as a Web app.
 * The iPhone Shortcut calls the web app URL with:
 *   ?key=API_KEY&action=lockers   → { ok, lockers: ["Floor", "Saloon seat", ...] }
 *   ?key=API_KEY&action=add|remove|wish|count|ping&code=BARCODE&qty=1&locker=...&session=YYYY-MM-DD&name=...
 * Every response is JSON: { ok, status, message, name, onHand }.
 * Optional &rid=<unique id>: a retried request with the same rid (e.g. from the phone's offline
 * queue after a dropped connection) returns the first reply instead of being applied twice.
 *
 * Needs QrLib.gs (qrcode-generator, MIT) in the same project for the Phone setup QR.
 */

const TABS = {
  ITEMS: 'Items', LOG: 'Log', WISH: 'Wishlist', COUNT: 'Stocktake',
  REVIEW: 'Stocktake Review', PLAN: 'Plan', LOCKERS: 'Lockers'
};

const HEADERS = {
  Items: ['Barcode', 'Name', 'Brand', 'Size', 'Category', 'On Hand', 'Min Qty',
          'Est Use / Person / Week', 'Locker', 'Last Updated', 'Notes'],
  Log: ['Timestamp', 'Barcode', 'Name', 'Action', 'Qty', 'On Hand After', 'Locker', 'Session / Note'],
  Wishlist: ['Added', 'Barcode', 'Name', 'Qty', 'Source', 'Status', 'Closed'],
  Stocktake: ['Timestamp', 'Session', 'Locker', 'Barcode', 'Name', 'Qty'],
  Lockers: ['Locker', 'Notes']
};

// Items column positions (0-based)
const I = { BARCODE: 0, NAME: 1, BRAND: 2, SIZE: 3, CATEGORY: 4, ONHAND: 5, MIN: 6,
            EST: 7, LOCKER: 8, UPDATED: 9, NOTES: 10 };

const ACTIONS = ['add', 'remove', 'wish', 'count'];

/* ───────────────────────── Setup & menu ───────────────────────── */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  // Barcodes (and session dates) must stay text so leading zeros survive.
  ss.getSheetByName(TABS.ITEMS).getRange('A:A').setNumberFormat('@');
  ss.getSheetByName(TABS.LOG).getRange('B:B').setNumberFormat('@');
  ss.getSheetByName(TABS.WISH).getRange('B:B').setNumberFormat('@');
  ss.getSheetByName(TABS.COUNT).getRange('B:B').setNumberFormat('@');
  ss.getSheetByName(TABS.COUNT).getRange('D:D').setNumberFormat('@');

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) {
    props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  }
  seedLockers_();
  buildPlan_();

  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  showApiKey();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚓ Provisioning')
    .addItem('Build stocktake review', 'buildStocktakeReview')
    .addItem('Apply stocktake review', 'applyStocktakeReview')
    .addSeparator()
    .addItem('Refresh provisioning plan', 'refreshPlan')
    .addItem('Fill missing brands', 'fillMissingBrands')
    .addItem('Show API key', 'showApiKey')
    .addItem('Phone setup QR', 'showPhoneSetupQr')
    .addToUi();
}

function showApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  alert_('Your API key (paste into the Shortcut):\n\n' + key);
}

// Shows a QR code the phone app scans to fill in its URL and API key.
// The QR is drawn here in the script (QrLib.gs); the key never goes to a third-party service.
function showPhoneSetupQr() {
  const props = PropertiesService.getScriptProperties();
  let url = props.getProperty('WEB_APP_URL') || '';
  const ui = SpreadsheetApp.getUi();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    const resp = ui.prompt('Phone setup QR',
      'Paste the Web app URL (Deploy → Manage deployments; it ends in /exec):',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    url = resp.getResponseText().trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      return ui.alert('That doesn\'t look like a web app URL. It should start with https://script.google.com/ and end with /exec');
    }
    props.setProperty('WEB_APP_URL', url);
  }
  ui.showModalDialog(HtmlService.createHtmlOutput(setupQrHtml_(url, props.getProperty('API_KEY')))
    .setWidth(420).setHeight(560), 'Phone setup');
}

function setupQrHtml_(url, key) {
  const qr = qrcode(0, 'M');
  qr.addData(JSON.stringify({ t: 'freddy-grocery', u: url, k: key }));
  qr.make();
  const esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  return '<div style="font-family:sans-serif;text-align:center">' +
    qr.createSvgTag({ cellSize: 5, margin: 4 }) +
    '<p>On the phone: <b>Settings → Scan setup code</b></p>' +
    '<p style="font-size:11px;color:#666;word-break:break-all">' + esc(url) + '</p>' +
    '<p style="font-size:11px;color:#666">Wrong URL after a redeploy? Run ' +
    '<code>resetWebAppUrl</code> from the script editor, then open this again.</p></div>';
}

function resetWebAppUrl() {
  PropertiesService.getScriptProperties().deleteProperty('WEB_APP_URL');
  alert_('Web app URL cleared. Open Phone setup QR to enter it again.');
}

/* ───────────────────────── Web endpoint ───────────────────────── */

function doGet(e) { return handle_((e && e.parameter) || {}); }

function doPost(e) {
  const p = Object.assign({}, (e && e.parameter) || {});
  if (e && e.postData && e.postData.contents) {
    try { Object.assign(p, JSON.parse(e.postData.contents)); } catch (err) { /* form-encoded; ignore */ }
  }
  return handle_(p);
}

function handle_(p) {
  let out;
  const lock = LockService.getScriptLock();
  try {
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || String(p.key || '') !== key) {
      out = { ok: false, status: 'denied', message: 'Wrong or missing API key' };
    } else {
      lock.waitLock(20000);
      const cache = CacheService.getScriptCache();
      const rid = String(p.rid || '').slice(0, 64);
      const seen = rid ? cache.get('rid:' + rid) : null;
      if (seen) {
        out = JSON.parse(seen);
        out.duplicate = true;
      } else {
        out = route_(p);
        if (rid) cache.put('rid:' + rid, JSON.stringify(out), 21600); // 6 hours
      }
    }
  } catch (err) {
    out = { ok: false, status: 'error', message: 'Error: ' + err.message };
  } finally {
    try { lock.releaseLock(); } catch (e2) { /* not held */ }
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(p) {
  const action = String(p.action || '').toLowerCase().trim();
  if (action === 'ping') return { ok: true, status: 'ok', message: 'Connected ✓' };
  if (action === 'lockers') {
    const list = lockerList_();
    return { ok: true, status: 'ok', lockers: list, message: list.length + ' lockers' };
  }
  if (ACTIONS.indexOf(action) < 0) return { ok: false, status: 'error', message: 'Unknown action: ' + action };

  const code = normalize_(p.code);
  if (!code) return { ok: false, status: 'error', message: 'No barcode received' };
  const qty = Math.max(1, Math.round(Number(p.qty) || 1));
  const locker = String(p.locker || '').trim();
  const name = String(p.name || '').trim();

  if (locker && !isKnownLocker_(locker)) {
    return { ok: false, status: 'error',
             message: 'Locker "' + locker + '" is not in the Lockers tab. Add it there first.' };
  }
  const ctx = getItem_(code, name, locker);
  if (!ctx) {
    return { ok: false, status: 'unknown', code: code,
             message: 'New barcode ' + code + ' — not in the database. Enter a name.' };
  }
  switch (action) {
    case 'add':    return doAdd_(ctx, qty, locker);
    case 'remove': return doRemove_(ctx, qty);
    case 'wish':   return doWish_(ctx, qty);
    case 'count':  return doCount_(ctx, qty, locker, p.session);
  }
}

/* ───────────────────────── Actions ───────────────────────── */

function doAdd_(ctx, qty, locker) {
  const onHand = num_(ctx.values[I.ONHAND]) + qty;
  setOnHand_(ctx, onHand);
  const moved = setLocker_(ctx, locker);
  log_(ctx, 'add', qty, onHand, '');
  const closed = closeWishes_(ctx.code);
  return ok_(ctx, onHand, '+' + qty + ' ' + label_(ctx) + ' → ' + onHand + ' aboard' +
             (closed ? ' · ticked off wishlist' : '') +
             (moved ? ' · now also stored in ' + locker : ''));
}

function doRemove_(ctx, qty) {
  const before = num_(ctx.values[I.ONHAND]);
  const onHand = Math.max(0, before - qty);
  setOnHand_(ctx, onHand);
  // Log the requested qty: it was used, even if the inventory count was wrong.
  log_(ctx, 'remove', qty, onHand, before < qty ? 'count was short' : '');
  let msg = '−' + qty + ' ' + label_(ctx) + ' → ' + onHand + ' left';
  if (before < qty) msg += ' (count was off — check at next stocktake)';

  const min = num_(ctx.values[I.MIN]);
  if (min > 0 && onHand <= min && openWishRow_(ctx.code) < 0) {
    addWish_(ctx, Math.max(1, 2 * min - onHand), 'auto: low stock');
    msg += ' · LOW, added to wishlist';
  }
  return ok_(ctx, onHand, msg);
}

function doWish_(ctx, qty) {
  const sh = sheet_(TABS.WISH);
  const r = openWishRow_(ctx.code);
  let total = qty;
  if (r > 0) {
    total = num_(sh.getRange(r, 4).getValue()) + qty;
    sh.getRange(r, 4).setValue(total);
  } else {
    addWish_(ctx, qty, 'scan');
  }
  return ok_(ctx, num_(ctx.values[I.ONHAND]),
             '★ ' + label_(ctx) + ' on wishlist (' + total + ') · ' + num_(ctx.values[I.ONHAND]) + ' aboard');
}

function doCount_(ctx, qty, locker, session) {
  session = String(session || '').trim() ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const sh = sheet_(TABS.COUNT);
  appendText_(sh, [new Date(), session, locker, ctx.code, ctx.values[I.NAME], qty], [2, 4]);

  setLocker_(ctx, locker);
  // Running total for this item in this session
  let total = 0;
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, 1, n, 6).getValues().forEach(function (r) {
      if (String(r[1]) === session && normalize_(r[3]) === ctx.code) total += num_(r[5]);
    });
  }
  return ok_(ctx, num_(ctx.values[I.ONHAND]),
             '✓ ' + label_(ctx) + ': ' + total + ' counted' + (locker ? ' (' + locker + ')' : ''));
}

/* ───────────────────────── Items ───────────────────────── */

function getItem_(code, name, locker) {
  const sh = sheet_(TABS.ITEMS);
  const row = findRow_(sh, code);
  if (row > 0) {
    return { sh: sh, row: row, code: code, isNew: false,
             values: sh.getRange(row, 1, 1, HEADERS.Items.length).getValues()[0] };
  }
  if (name) return createItem_(sh, code, name, '', '', locker);
  const off = lookupOFF_(code);
  if (off) return createItem_(sh, code, off.name, off.brand, off.size, locker);
  return null;
}

function createItem_(sh, code, name, brand, size, locker) {
  const values = [code, name, brand || '', size || '', '', 0, 0, '', locker || '', new Date(), ''];
  const row = appendText_(sh, values, [1]);
  return { sh: sh, row: row, code: code, values: values, isNew: true };
}

function findRow_(sh, code) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const codes = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < n; i++) if (normalize_(codes[i][0]) === code) return i + 2;
  return -1;
}

function setOnHand_(ctx, v) {
  ctx.sh.getRange(ctx.row, I.ONHAND + 1).setValue(v);
  ctx.sh.getRange(ctx.row, I.UPDATED + 1).setValue(new Date());
  ctx.values[I.ONHAND] = v;
}

// Items can live in several lockers (e.g. bulk under the saloon seat, quick-access in the floor).
// The Locker column holds a comma-separated list. Returns true if this locker was newly added.
function lockersOf_(v) {
  return String(v || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(String);
}

function setLocker_(ctx, locker) {
  locker = String(locker || '').trim();
  if (!locker) return false;
  const list = lockersOf_(ctx.values[I.LOCKER]);
  if (list.some(function (l) { return l.toLowerCase() === locker.toLowerCase(); })) return false;
  list.push(locker);
  const joined = list.join(', ');
  ctx.sh.getRange(ctx.row, I.LOCKER + 1).setValue(joined);
  ctx.values[I.LOCKER] = joined;
  return list.length > 1;
}

/* ───────────────────────── Lockers ───────────────────────── */

// Lockers tab, column A, in sheet order (so you control the order on the phone).
function lockerList_() {
  const sh = sheet_(TABS.LOCKERS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const seen = {};
  return sh.getRange(2, 1, n, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (l) {
      if (!l || seen[l.toLowerCase()]) return false;
      seen[l.toLowerCase()] = true;
      return true;
    });
}

function isKnownLocker_(locker) {
  const list = lockerList_();
  if (!list.length) return true; // no list set up yet: accept anything
  const l = locker.toLowerCase();
  return list.some(function (x) { return x.toLowerCase() === l; });
}

// On setup: if the Lockers tab is empty, fill it from lockers already used in Items.
function seedLockers_() {
  const sh = sheet_(TABS.LOCKERS);
  if (sh.getLastRow() > 1) return;
  const seen = {};
  const found = [];
  itemsData_().forEach(function (it) {
    lockersOf_(it[I.LOCKER]).forEach(function (l) {
      if (!seen[l.toLowerCase()]) { seen[l.toLowerCase()] = true; found.push([l, '']); }
    });
  });
  if (found.length) {
    ensureRows_(sh, found.length + 1);
    sh.getRange(2, 1, found.length, 2).setValues(found);
  }
}

function itemsData_() {
  const sh = sheet_(TABS.ITEMS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, HEADERS.Items.length).getValues()
    .filter(function (r) { return normalize_(r[I.BARCODE]); });
}

function lookupOFF_(code) {
  if (!/^\d{8,14}$/.test(code)) return null;
  try {
    const res = UrlFetchApp.fetch(
      'https://world.openfoodfacts.org/api/v2/product/' + code + '.json?fields=product_name,brands,brand_owner,quantity',
      { muteHttpExceptions: true, headers: { 'User-Agent': 'BoatProvisioning/1.0 (personal use)' } });
    if (res.getResponseCode() !== 200) return null;
    const d = JSON.parse(res.getContentText());
    if (d.status !== 1 || !d.product || !d.product.product_name) return null;
    // brands is crowd-sourced; brand_owner (often from USDA data) is the fallback
    const brand = String(d.product.brands || '').split(',')[0].trim() ||
                  String(d.product.brand_owner || '').trim();
    return { name: d.product.product_name, brand: brand, size: d.product.quantity || '' };
  } catch (err) {
    return null;
  }
}

/* ───────────────────────── Log & wishlist ───────────────────────── */

function log_(ctx, action, qty, after, note) {
  appendText_(sheet_(TABS.LOG),
    [new Date(), ctx.code, ctx.values[I.NAME], action, qty, after, ctx.values[I.LOCKER] || '', note || ''], [2]);
}

function openWishRow_(code) {
  const sh = sheet_(TABS.WISH);
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const v = sh.getRange(2, 1, n, 7).getValues();
  for (let i = 0; i < n; i++) {
    if (normalize_(v[i][1]) === code && String(v[i][5]) === 'Open') return i + 2;
  }
  return -1;
}

function addWish_(ctx, qty, source) {
  appendText_(sheet_(TABS.WISH), [new Date(), ctx.code, describe_(ctx.values), qty, source, 'Open', ''], [2]);
}

function closeWishes_(code) {
  const sh = sheet_(TABS.WISH);
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const v = sh.getRange(2, 1, n, 7).getValues();
  let closed = 0;
  for (let i = 0; i < n; i++) {
    if (normalize_(v[i][1]) === code && String(v[i][5]) === 'Open') {
      sh.getRange(i + 2, 6, 1, 2).setValues([['Bought', new Date()]]);
      closed++;
    }
  }
  return closed;
}

/* ───────────────────────── Stocktake (laptop) ───────────────────────── */

function buildStocktakeReview() {
  const st = sheet_(TABS.COUNT);
  const n = st.getLastRow() - 1;
  if (n < 1) return alert_('No stocktake scans yet.');
  const rows = st.getRange(2, 1, n, 6).getValues();
  const latest = String(rows[rows.length - 1][1]);

  let session = latest;
  try {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.prompt('Stocktake review', 'Session to review (blank = latest: ' + latest + ')',
                           ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    session = resp.getResponseText().trim() || latest;
  } catch (err) { /* run from editor: use latest */ }

  const counts = {};
  const lockers = {};
  rows.forEach(function (r) {
    if (String(r[1]) !== session) return;
    const c = normalize_(r[3]);
    counts[c] = (counts[c] || 0) + num_(r[5]);
    if (String(r[2]).trim()) lockers[String(r[2]).trim().toLowerCase()] = true;
  });
  if (!Object.keys(counts).length) return alert_('No scans found for session ' + session);

  const out = [];
  itemsData_().forEach(function (it) {
    const code = normalize_(it[I.BARCODE]);
    const scanned = Object.prototype.hasOwnProperty.call(counts, code);
    const homes = lockersOf_(it[I.LOCKER]);
    const counted_in = homes.filter(function (l) { return lockers[l.toLowerCase()] === true; });
    const missed = homes.filter(function (l) { return lockers[l.toLowerCase()] !== true; });
    if (!scanned && !counted_in.length) return;
    const expected = num_(it[I.ONHAND]);
    const counted = scanned ? counts[code] : 0;
    let status, apply;
    if (missed.length) {
      // Stored in lockers this session didn't cover: the count is partial, don't apply blindly.
      status = 'PARTIAL — not counted: ' + missed.join(', ');
      apply = false;
    } else if (!scanned) {
      status = 'NOT FOUND — check';
      apply = false;
    } else {
      status = counted === expected ? 'OK' : 'Different';
      apply = true;
    }
    out.push([session, it[I.LOCKER], code, it[I.NAME], expected, counted, counted - expected,
              status, apply, counted]);
  });
  const rank = function (r) {
    const st = String(r[7]);
    return st.indexOf('NOT FOUND') === 0 ? 0 : st.indexOf('PARTIAL') === 0 ? 1 : st === 'Different' ? 2 : 3;
  };
  out.sort(function (a, b) { return rank(a) - rank(b) || Math.abs(b[6]) - Math.abs(a[6]); });

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(TABS.REVIEW) || ss.insertSheet(TABS.REVIEW);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), 10).clearDataValidations();
  const hdr = ['Session', 'Locker', 'Barcode', 'Name', 'Expected', 'Counted', 'Difference',
               'Status', 'Apply?', 'New On Hand'];
  sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (out.length) {
    ensureRows_(sh, out.length + 1);
    sh.getRange(2, 1, out.length, 1).setNumberFormat('@');
    sh.getRange(2, 3, out.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, out.length, hdr.length).setValues(out);
    sh.getRange(2, 9, out.length, 1).insertCheckboxes();
    out.forEach(function (r, i) {
      const st = String(r[7]);
      const color = st === 'OK' ? null : st === 'Different' ? '#fff4cc' :
                    st.indexOf('PARTIAL') === 0 ? '#ffe3c2' : '#ffd6d6';
      if (color) sh.getRange(i + 2, 1, 1, hdr.length).setBackground(color);
    });
  }
  ss.setActiveSheet(sh);
  alert_('Review built for ' + session + ': ' + out.length + ' items.\n\n' +
         'Red = expected but not scanned (unticked).\n' +
         'Orange = also stored in a locker you didn\'t count this session (unticked).\n' +
         'Yellow = count differs.\nEdit "New On Hand" if needed, then Provisioning → Apply stocktake review.');
}

function applyStocktakeReview() {
  const ss = SpreadsheetApp.getActive();
  const rv = ss.getSheetByName(TABS.REVIEW);
  if (!rv || rv.getLastRow() < 2) return alert_('Build a stocktake review first.');
  const n = rv.getLastRow() - 1;
  const rows = rv.getRange(2, 1, n, 10).getValues();
  const items = sheet_(TABS.ITEMS);
  let applied = 0;
  rows.forEach(function (r, i) {
    if (r[8] !== true || String(r[7]) === 'Applied') return;
    const code = normalize_(r[2]);
    const row = findRow_(items, code);
    if (row < 0) return;
    const ctx = { sh: items, row: row, code: code,
                  values: items.getRange(row, 1, 1, HEADERS.Items.length).getValues()[0] };
    const before = num_(ctx.values[I.ONHAND]);
    const after = Math.max(0, num_(r[9]));
    setOnHand_(ctx, after);
    log_(ctx, 'stocktake', after - before, after, 'session ' + r[0]);
    rv.getRange(i + 2, 8, 1, 2).setValues([['Applied', false]]);
    rv.getRange(i + 2, 1, 1, 10).setBackground('#e6f4ea');
    applied++;
  });
  alert_('Applied ' + applied + ' counts to Items.');
}

/* ───────────────────────── Product details (laptop) ───────────────────────── */

// Re-queries Open Food Facts for items with an empty Brand (e.g. added before brand_owner was used).
function fillMissingBrands() {
  const sh = sheet_(TABS.ITEMS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return alert_('No items yet.');
  const v = sh.getRange(2, 1, n, HEADERS.Items.length).getValues();
  let filled = 0, missing = 0;
  v.forEach(function (r, i) {
    if (String(r[I.BRAND]).trim()) return;
    const off = lookupOFF_(normalize_(r[I.BARCODE]));
    if (off && off.brand) {
      sh.getRange(i + 2, I.BRAND + 1).setValue(off.brand);
      if (!String(r[I.SIZE]).trim() && off.size) sh.getRange(i + 2, I.SIZE + 1).setValue(off.size);
      filled++;
    } else {
      missing++;
    }
  });
  alert_('Filled ' + filled + ' brands. ' + missing + ' items have no brand in Open Food Facts — type those in by hand.');
}

/* ───────────────────────── Provisioning plan (laptop) ───────────────────────── */

function refreshPlan() {
  buildPlan_();
  alert_('Plan refreshed with all items.');
}

function buildPlan_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(TABS.PLAN);
  if (!sh) sh = ss.insertSheet(TABS.PLAN);
  if (!String(sh.getRange('A1').getValue())) {
    sh.getRange('A1:B6').setValues([
      ['Voyage crew', 4],
      ['Voyage weeks', 12],
      ['Safety buffer', 0.2],
      ['Crew aboard while logging', 4],
      ['Usage window (days)', 60],
      ['Min logged uses to trust measured rate', 3]
    ]);
    sh.getRange('B3').setNumberFormat('0%');
    sh.getRange('A7').setValue('Days of logging used (auto)');
    sh.getRange('A1:A7').setFontWeight('bold');
    sh.getRange('B1:B6').setBackground('#fff4cc');
  }
  // Effective window: never longer than you've actually been logging.
  sh.getRange('B7').setFormula('=IF(COUNT(Log!$A:$A)=0,$B$5,MAX(1,MIN($B$5,NOW()-MIN(Log!$A:$A))))')
    .setNumberFormat('0');

  const hdr = ['Name', 'Barcode', 'Category', 'Locker', 'On Hand', 'Used in window',
               'Measured / person / wk', 'Estimate / person / wk', 'Rate used',
               'Needed for voyage', 'To buy'];
  const last = Math.max(sh.getLastRow(), 9);
  sh.getRange(9, 1, last - 8, hdr.length).clearContent().setBackground(null);
  sh.getRange(9, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');

  const items = itemsData_();
  if (!items.length) return;
  ensureRows_(sh, 9 + items.length);
  const rows = items.map(function (it, i) {
    const r = 10 + i;
    const b = '$B' + r;
    const m = 'MATCH(' + b + ',Items!$A:$A,0)';
    const win = 'Log!$A:$A,">="&(NOW()-$B$7)';
    return [
      it[I.NAME],
      normalize_(it[I.BARCODE]),
      '=IFERROR(INDEX(Items!$E:$E,' + m + '),"")',
      '=IFERROR(INDEX(Items!$I:$I,' + m + '),"")',
      '=IFERROR(N(INDEX(Items!$F:$F,' + m + ')),0)',
      // logged removals + unlogged use found by stocktakes (negative adjustments)
      '=SUMIFS(Log!$E:$E,Log!$B:$B,' + b + ',Log!$D:$D,"remove",' + win + ')' +
        '-SUMIFS(Log!$E:$E,Log!$B:$B,' + b + ',Log!$D:$D,"stocktake",Log!$E:$E,"<0",' + win + ')',
      '=IF(AND($B$4>0,$B$7>0),F' + r + '/$B$7*7/$B$4,0)',
      '=IFERROR(N(INDEX(Items!$H:$H,' + m + ')),0)',
      '=IF(F' + r + '>=$B$6,G' + r + ',H' + r + ')',
      '=I' + r + '*$B$1*$B$2*(1+$B$3)',
      '=MAX(0,CEILING(J' + r + '-E' + r + ',1))'
    ];
  });
  sh.getRange(10, 2, rows.length, 1).setNumberFormat('@');
  sh.getRange(10, 1, rows.length, hdr.length).setValues(rows);
  sh.getRange(10, 7, rows.length, 4).setNumberFormat('0.0');
  sh.getRange(10, 11, rows.length, 1).setFontWeight('bold');
}

/* ───────────────────────── Helpers ───────────────────────── */

function normalize_(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return s.length === 12 ? '0' + s : s; // UPC-A → EAN-13
  return s.toUpperCase(); // manual codes like RICE-5KG
}

function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }

function label_(ctx) {
  return (ctx.isNew ? '[NEW] ' : '') + describe_(ctx.values);
}

// "Brand Name Size", skipping the brand when the name already contains it.
function describe_(values) {
  const name = String(values[I.NAME] || '').trim();
  const brand = String(values[I.BRAND] || '').trim();
  const size = String(values[I.SIZE] || '').trim();
  // Skip the brand if the product name already contains it ("Barilla Penne")
  const showBrand = brand && name.toLowerCase().indexOf(brand.toLowerCase()) < 0;
  return (showBrand ? brand + ' ' : '') + name + (size ? ' ' + size : '');
}

function ok_(ctx, onHand, message) {
  return { ok: true, status: ctx.isNew ? 'created' : 'ok', message: message,
           name: ctx.values[I.NAME], onHand: onHand };
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run setup()');
  return sh;
}

function ensureRows_(sh, needed) {
  const max = sh.getMaxRows();
  if (needed > max) sh.insertRowsAfter(max, needed - max + 200);
}

// Append a row, forcing the given 1-based columns to plain text first.
function appendText_(sh, values, textCols) {
  const r = sh.getLastRow() + 1;
  ensureRows_(sh, r);
  textCols.forEach(function (c) { sh.getRange(r, c).setNumberFormat('@'); });
  sh.getRange(r, 1, 1, values.length).setValues([values]);
  return r;
}

function alert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (err) { Logger.log(msg); }
}
