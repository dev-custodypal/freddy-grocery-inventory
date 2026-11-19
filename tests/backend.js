// Minimal in-memory mock of the Apps Script services used by Code.gs
const fs = require('fs');
const vm = require('vm');
function makeBackend(files) {

function makeSheet(name) {
  const s = {
    name, data: [], maxRows: 1000, formats: {}, frozen: 0,
    getName: () => name,
    getLastRow() { let l = 0; s.data.forEach((r, i) => { if (r && r.some(v => v !== '' && v != null)) l = i + 1; }); return l; },
    getMaxRows: () => s.maxRows,
    insertRowsAfter(_, n) { s.maxRows += n; },
    setFrozenRows(n) { s.frozen = n; },
    clear() { s.data = []; },
    getRange(a, b, c, d) {
      let r, col, nr = 1, nc = 1;
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z])(\d*)(?::([A-Z])(\d*))?$/);
        col = m[1].charCodeAt(0) - 64; r = m[2] ? +m[2] : 1;
        if (m[3]) { nc = m[3].charCodeAt(0) - 64 - col + 1; nr = m[4] ? +m[4] - r + 1 : s.maxRows; }
        else if (!m[2]) nr = s.maxRows;
      } else { r = a; col = b; nr = c || 1; nc = d || 1; }
      if (r + nr - 1 > s.maxRows) throw new Error('Range outside sheet: ' + name + ' row ' + (r + nr - 1));
      const rng = {
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((s.data[r - 1 + i] || [])[col - 1 + j]) ?? ''); out.push(row); } return out; },
        getValue() { return rng.getValues()[0][0]; },
        setValues(v) {
          if (v.length !== nr || v[0].length !== nc) throw new Error(`setValues dims ${v.length}x${v[0].length} vs ${nr}x${nc} on ${name}`);
          for (let i = 0; i < nr; i++) { s.data[r - 1 + i] = s.data[r - 1 + i] || []; for (let j = 0; j < nc; j++) s.data[r - 1 + i][col - 1 + j] = v[i][j]; }
          return rng;
        },
        setValue(v) { return rng.setValues([[v]]); },
        setFormula(f) { return rng.setValues([[f]]); },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.data[r - 1 + i]) s.data[r - 1 + i][col - 1 + j] = ''; return rng; },
        setNumberFormat() { return rng; }, setFontWeight() { return rng; }, setBackground() { return rng; },
        insertCheckboxes() { return rng; }, clearDataValidations() { return rng; },
      };
      return rng;
    }
  };
  return s;
}

const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n)),
  getSheets: () => Object.values(sheets),
  deleteSheet: s => delete sheets[s.name],
  setActiveSheet() {},
};
const props = {};
const cache = {};
const offResponses = {};
const ctx = {
  console,
  SpreadsheetApp: { getActive: () => ss, getUi: () => { throw new Error('no ui'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { getUuid: () => 'abcd1234-ef56-7890-abcd-ef1234567890', formatDate: () => '2026-11-16' },
  Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
  UrlFetchApp: { fetch: url => { const code = url.match(/product\/(\d+)/)[1]; const p = offResponses[code];
    return { getResponseCode: () => p ? 200 : 404, getContentText: () => JSON.stringify(p ? { status: 1, product: p } : { status: 0 }) }; } },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
  Logger: { log: () => {} },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  HtmlService: { createHtmlOutput: h => ({ html: h, setWidth() { return this; }, setHeight() { return this; } }) },
  ScriptApp: { getService: () => ({ getUrl: () => null }) },
};
vm.createContext(ctx);



for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
return { ctx, sheets, props, cache, offResponses };
}
module.exports = { makeBackend };
