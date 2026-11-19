// Galley Scan — barcode scanner PWA for the Freddy grocery inventory.
// Talks to the Google Apps Script web app (apps-script/Code.gs) with plain GET requests.

import { BarcodeDetector, prepareZXingModule } from './vendor/barcode.js';

const VERSION = '0.1.0';

/* ───────────── small helpers ───────────── */

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd, local time

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('fgi.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('fgi.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
  },
};

// Same rule as the server: 12-digit UPC-A becomes 13-digit EAN-13.
function normalize(code) {
  const s = String(code || '').trim();
  if (/^\d+$/.test(s)) return s.length === 12 ? '0' + s : s;
  return s.toUpperCase();
}

const ACTION_TAG = { add: 'ADD', remove: 'USE', wish: 'WISH', count: 'COUNT' };
const ACTION_VERB = { add: 'Add', remove: 'Use', wish: 'Wishlist', count: 'Count' };

/* ───────────── state ───────────── */

const state = {
  mode: store.get('mode', 'add'),
  locker: store.get('locker', ''),
  lockers: store.get('lockers', []),
  setup: false,          // scanning a setup QR instead of products
  sheetOpen: false,
};
let recent = store.get('recent', []);
const names = store.get('names', {});

const settings = () => store.get('settings', { url: '', key: '' });
const configured = () => { const s = settings(); return !!(s.url && s.key); };

/* ───────────── server ───────────── */

class ServerError extends Error {}

async function api(params, timeoutMs = 20000) {
  const s = settings();
  if (!s.url || !s.key) throw new ServerError('Not set up yet — open Settings');
  const qs = Object.entries({ key: s.key, ...params })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(v))
    .join('&');
  const url = s.url + (s.url.includes('?') ? '&' : '?') + qs;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new ServerError('Google sent a web page, not data. Check the URL ends in /exec and the deployment is set to "Anyone".');
  }
  if (data.status === 'denied') throw new ServerError('Wrong API key — check Settings');
  return data;
}
// Anything thrown that is NOT a ServerError (fetch TypeError, timeout) means "no connection": queue it.

const reqParams = (r) => ({ action: r.action, code: r.code, qty: r.qty, locker: r.locker,
  session: r.session, name: r.name, rid: r.rid });

/* ───────────── recent list ───────────── */

function saveRecent() { store.set('recent', recent.slice(0, 30)); }

function upsertRecent(entry) {
  const i = recent.findIndex((e) => e.id === entry.id);
  if (i >= 0) recent[i] = { ...recent[i], ...entry };
  else recent.unshift(entry);
  recent = recent.slice(0, 30);
  saveRecent();
  renderRecent();
}

function describe(req) {
  const n = names[normalize(req.code)] || req.name || req.code;
  return `${ACTION_VERB[req.action]} ${req.qty > 1 ? req.qty + ' × ' : ''}${n}`;
}

function renderRecent() {
  const ul = $('recentList');
  ul.replaceChildren();
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Scans will show up here.';
    ul.append(li);
    return;
  }
  for (const e of recent) {
    const li = document.createElement('li');
    li.className = e.status;
    const tag = document.createElement('span');
    tag.className = 'tag ' + e.action;
    tag.textContent = ACTION_TAG[e.action] || e.action;
    const mid = document.createElement('div');
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = e.msg;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ({ queued: ' · waiting for connection', sending: ' · sending…', unknown: ' · needs a name', error: ' · failed' }[e.status] || '');
    mid.append(msg, meta);
    const right = document.createElement('div');
    if (e.status === 'unknown' && e.req) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Name it';
      b.onclick = () => askName(e.req);
      right.append(b);
    }
    li.append(tag, mid, right);
    ul.append(li);
  }
}

/* ───────────── sending, queue ───────────── */

function enqueue(req) {
  const q = store.get('queue', []);
  if (!q.some((x) => x.rid === req.rid)) q.push(req);
  store.set('queue', q);
  renderQueue();
}
function dequeue(rid) {
  store.set('queue', store.get('queue', []).filter((x) => x.rid !== rid));
  renderQueue();
}
function renderQueue() {
  const n = store.get('queue', []).length;
  const b = $('queueBadge');
  b.hidden = n === 0;
  b.textContent = `⏳ ${n} queued — tap to send`;
}

async function submit(req) {
  req.rid = req.rid || uid();
  req.session = req.session || today();
  req.recentId = req.recentId || uid();
  upsertRecent({ id: req.recentId, action: req.action, code: req.code, msg: describe(req), status: 'sending', t: Date.now() });
  try {
    handleReply(req, await api(reqParams(req)), true);
  } catch (err) {
    if (err instanceof ServerError) {
      upsertRecent({ id: req.recentId, status: 'error', msg: describe(req) + ' — ' + err.message });
      toast(err.message, 'bad');
      beep('bad');
    } else {
      enqueue(req);
      upsertRecent({ id: req.recentId, status: 'queued', msg: describe(req) });
      toast('No connection — saved, will send when back online', 'warn');
      beep('warn');
    }
  }
}

function handleReply(req, reply, live) {
  if (reply.status === 'unknown') {
    upsertRecent({ id: req.recentId, status: 'unknown', req, msg: `New barcode ${req.code}` });
    if (live) { beep('warn'); askName(req); }
    return 'unknown';
  }
  if (reply.ok) {
    if (reply.name) { names[normalize(req.code)] = reply.name; store.set('names', names); }
    upsertRecent({ id: req.recentId, status: 'ok', msg: reply.message, req: undefined });
    if (live) { toast(reply.message, /LOW|off/.test(reply.message) ? 'warn' : ''); beep('ok'); }
    return 'ok';
  }
  upsertRecent({ id: req.recentId, status: 'error', msg: reply.message || 'Failed' });
  if (live) { toast(reply.message || 'Failed', 'bad'); beep('bad'); }
  return 'error';
}

let flushing = false;
async function flush({ announce = false } = {}) {
  if (flushing || !configured()) return;
  flushing = true;
  let sent = 0, unknown = 0, stuck = false;
  try {
    for (;;) {
      const q = store.get('queue', []);
      if (!q.length) break;
      const req = q[0];
      try {
        const reply = await api(reqParams(req));
        dequeue(req.rid);
        sent++;
        if (handleReply(req, reply, false) === 'unknown') unknown++;
      } catch (err) {
        if (err instanceof ServerError) {
          dequeue(req.rid);
          upsertRecent({ id: req.recentId, status: 'error', msg: describe(req) + ' — ' + err.message });
        } else { stuck = true; break; }
      }
    }
  } finally {
    flushing = false;
    renderQueue();
  }
  if (sent) toast(`Sent ${sent} queued scan${sent > 1 ? 's' : ''}` + (unknown ? ` · ${unknown} need a name` : ''), unknown ? 'warn' : '');
  else if (announce && stuck) toast('Still no connection', 'warn');
  else if (announce) toast('Nothing queued');
}

/* ───────────── sheets ───────────── */

function openSheet(dialog) {
  return new Promise((resolve) => {
    state.sheetOpen = true;
    dialog.returnValue = '';
    dialog.addEventListener('close', () => {
      state.sheetOpen = false;
      lastSeenAt = Date.now(); // the item may still be in front of the camera: it must leave first
      resolve(dialog.returnValue);
    }, { once: true });
    dialog.showModal();
  });
}

async function askQty(code) {
  const n = names[normalize(code)];
  $('qtyMode').textContent = ACTION_VERB[state.mode] + (lockerRelevant() && state.locker ? ' · ' + state.locker : '');
  $('qtyTitle').textContent = n || 'New barcode';
  $('qtyCode').textContent = n ? code : code + ' — will be looked up';
  $('qtyInput').value = 1;
  const r = await openSheet($('qtySheet'));
  if (r !== 'ok') return 0;
  return Math.max(1, Math.round(Number($('qtyInput').value) || 1));
}

async function askName(req) {
  $('nameCode').textContent = req.code;
  $('nameInput').value = '';
  setTimeout(() => $('nameInput').focus(), 50);
  const r = await openSheet($('nameSheet'));
  const name = $('nameInput').value.trim();
  if (r !== 'ok' || !name) return;
  // Same action again, now with a name. New rid: this is a different request.
  submit({ ...req, name, rid: uid() });
}

/* ───────────── modes & lockers ───────────── */

const lockerRelevant = () => state.mode === 'add' || state.mode === 'count';

function renderMode() {
  document.querySelectorAll('.modes button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)));
  const bar = $('lockerBar');
  bar.hidden = !lockerRelevant();
  bar.classList.remove('needs');
  $('lockerLabel').textContent = state.mode === 'count' ? 'Counting' : 'Stowing in';
  const sel = $('lockerSelect');
  sel.replaceChildren();
  const first = new Option(state.mode === 'count' ? 'Choose locker…' : '— no locker —', '');
  sel.append(first);
  for (const l of state.lockers) sel.append(new Option(l, l));
  if (state.locker && !state.lockers.includes(state.locker)) state.locker = '';
  sel.value = state.locker;
  $('scanHint').textContent = state.setup ? 'Point at the setup QR · tap to cancel'
    : { add: 'Scan items going in', remove: 'Scan items being used', wish: 'Scan what we should buy', count: 'Scan everything in this locker' }[state.mode];
}

function setMode(m) {
  state.mode = m;
  lastCode = ''; // an item already in view should count in the new mode
  store.set('mode', m);
  renderMode();
}

async function refreshLockers() {
  const reply = await api({ action: 'lockers' });
  if (reply.ok && Array.isArray(reply.lockers)) {
    state.lockers = reply.lockers;
    store.set('lockers', state.lockers);
    renderMode();
  }
  return reply;
}

/* ───────────── handling a scanned / typed code ───────────── */

async function handleCode(raw) {
  const code = String(raw).trim();
  if (!code) return;
  if (!configured()) { toast('Set up the connection first', 'warn'); openSettings(); return; }
  if (state.mode === 'count' && !state.locker) {
    $('lockerBar').classList.add('needs');
    toast('Choose the locker you are counting first', 'warn');
    beep('warn');
    return;
  }
  if (state.mode === 'remove') {
    submit({ action: 'remove', code, qty: 1 });
    return;
  }
  const qty = await askQty(code);
  if (!qty) return;
  submit({ action: state.mode, code, qty, locker: lockerRelevant() ? state.locker : '' });
}

/* ───────────── camera & detection ───────────── */

const video = $('video');
const canvas = document.createElement('canvas');
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
let stream = null;
let running = false;
let lastCode = '';
let lastSeenAt = 0;
let productDetector = null;
let qrDetector = null;
let scannerReady = false;

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('./vendor/' + path, import.meta.url).href : prefix + path),
  },
});

function detector() {
  if (state.setup) return (qrDetector ||= new BarcodeDetector({ formats: ['qr_code'] }));
  return (productDetector ||= new BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'],
  }));
}

async function startCamera() {
  unlockAudio();
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    toast('Camera blocked: ' + (err.message || err.name) + '. Allow camera access for this app.', 'bad');
    return;
  }
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay quirks; frames still arrive */ }
  $('startBtn').hidden = true;
  if (!scannerReady) $('scanHint').textContent = 'Loading scanner…';
  running = true;
  loop();
}

function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('startBtn').hidden = false;
}

async function loop() {
  while (running) {
    if (!state.sheetOpen && video.readyState >= 2 && video.videoWidth) {
      try {
        // Only look at the middle of the picture: faster, and avoids reading the next box over.
        const vw = video.videoWidth, vh = video.videoHeight;
        const cw = Math.round(vw * (state.setup ? 0.7 : 0.85));
        const ch = Math.round(vh * (state.setup ? 0.85 : 0.6));
        const scale = Math.min(1, 960 / cw);
        canvas.width = Math.round(cw * scale);
        canvas.height = Math.round(ch * scale);
        ctx2d.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
        const found = await detector().detect(canvas);
        if (!scannerReady) { scannerReady = true; renderMode(); }
        if (found.length) onDetected(found[0].rawValue);
      } catch (err) {
        console.warn('detect failed', err);
      }
    }
    await sleep(90);
  }
}

// A barcode triggers once, then must be out of view for a moment before it can trigger again.
// So holding a can in front of the camera in Use mode removes it once, not every few seconds.
const GONE_MS = 1200;
function onDetected(raw) {
  const now = Date.now();
  const repeat = raw === lastCode && now - lastSeenAt < GONE_MS;
  lastSeenAt = now;
  if (repeat) return;
  lastCode = raw;
  const cam = $('camera');
  cam.classList.add('hit');
  setTimeout(() => cam.classList.remove('hit'), 300);
  if (state.setup) handleSetupCode(raw);
  else handleCode(raw);
}

/* ───────────── settings & setup QR ───────────── */

function openSettings() {
  const s = settings();
  $('urlInput').value = s.url;
  $('keyInput').value = s.key;
  $('settingsStatus').textContent = '';
  $('settingsStatus').className = 'status';
  $('versionLine').textContent = `Galley Scan ${VERSION}`;
  openSheet($('settingsSheet')).then(saveSettingsFromForm);
}

function saveSettingsFromForm() {
  const url = $('urlInput').value.trim();
  const key = $('keyInput').value.trim();
  const s = settings();
  if (url !== s.url || key !== s.key) {
    store.set('settings', { url, key });
    if (url && key) refreshLockers().catch(() => {});
  }
}

function setStatus(text, cls = '') {
  const el = $('settingsStatus');
  el.textContent = text;
  el.className = 'status ' + cls;
}

async function testConnection() {
  saveSettingsFromForm();
  const s = settings();
  if (!s.url || !s.key) return setStatus('Enter the URL and key, or scan the setup code.', 'bad');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(s.url)) {
    setStatus('URL should start with https://script.google.com/ and end with /exec', 'bad');
  } else setStatus('Testing…');
  try {
    const ping = await api({ action: 'ping' });
    const lockers = await refreshLockers();
    setStatus(`${ping.message} · ${lockers.lockers ? lockers.lockers.length : 0} lockers loaded`, 'ok');
    flush();
  } catch (err) {
    setStatus(err instanceof ServerError ? err.message : 'Could not reach Google. Check the internet connection and the URL.', 'bad');
  }
}

function enterSetupScan() {
  $('settingsSheet').close('setup');
  state.setup = true;
  $('camera').classList.add('setup');
  lastCode = '';
  renderMode();
  startCamera();
}

function exitSetupScan() {
  state.setup = false;
  $('camera').classList.remove('setup');
  renderMode();
}

function handleSetupCode(raw) {
  let d = null;
  try { d = JSON.parse(raw); } catch { /* not JSON */ }
  if (!d || d.t !== 'freddy-grocery' || !d.u || !d.k) {
    toast('That QR code is not a Galley setup code', 'bad');
    beep('bad');
    return;
  }
  store.set('settings', { url: d.u, key: d.k });
  exitSetupScan();
  beep('ok');
  toast('Setup saved ✓');
  openSettings();
  testConnection();
}

/* ───────────── feedback: toast & beep ───────────── */

let toastTimer = 0;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), kind === 'bad' ? 5000 : 2800);
}

let audio = null;
function unlockAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
function beep(kind) {
  if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 40 : [60, 40, 60]);
  if (!audio) return;
  const tones = { ok: [[1046, 0.07]], warn: [[660, 0.09], [660, 0.09]], bad: [[220, 0.25]] }[kind] || [];
  let t = audio.currentTime;
  for (const [f, d] of tones) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + d);
    t += d + 0.05;
  }
}

/* ───────────── wiring ───────────── */

document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('lockerSelect').onchange = (e) => {
  state.locker = e.target.value;
  store.set('locker', state.locker);
  lastCode = '';
  $('lockerBar').classList.remove('needs');
};
$('startBtn').onclick = startCamera;
$('camera').addEventListener('click', (e) => {
  if (state.setup && e.target !== $('startBtn')) { exitSetupScan(); openSettings(); }
});
$('settingsBtn').onclick = openSettings;
$('scanSetupBtn').onclick = enterSetupScan;
$('testBtn').onclick = testConnection;
$('flushBtn').onclick = () => flush({ announce: true });
$('queueBadge').onclick = () => flush({ announce: true });
$('clearRecentBtn').onclick = () => { recent = []; saveRecent(); renderRecent(); setStatus('Recent list cleared'); };
$('manualBtn').onclick = async () => {
  $('manualInput').value = '';
  setTimeout(() => $('manualInput').focus(), 50);
  const r = await openSheet($('manualSheet'));
  if (r === 'ok') handleCode($('manualInput').value);
};
document.querySelectorAll('.stepper button').forEach((b) => (b.onclick = () => {
  const i = $('qtyInput');
  i.value = Math.max(1, (Number(i.value) || 1) + Number(b.dataset.step));
}));

window.addEventListener('online', () => flush());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera(); // saves battery; iOS stops the camera in the background anyway
  else flush();
});
setInterval(() => { if (navigator.onLine) flush(); }, 30000);

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}

renderMode();
renderRecent();
renderQueue();
if (!configured()) openSettings();
else { refreshLockers().catch(() => {}); flush(); }

// Exposed for automated tests only.
window.__galley = { handleCode, flush, state, onDetected };
