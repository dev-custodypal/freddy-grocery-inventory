const { makeBackend } = require('./backend.js');
const { ctx, sheets, props, cache, offResponses } = makeBackend(process.argv.slice(2));
let fails = 0;
const call = p => JSON.parse(ctx.doGet({ parameter: Object.assign({ key: props.API_KEY }, p) }).text);
const expect = (label, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ' + JSON.stringify(info))); if (!cond) fails++; };

ctx.setup();
expect('tabs created', ['Items', 'Log', 'Wishlist', 'Stocktake', 'Plan'].every(n => sheets[n]), Object.keys(sheets));
expect('api key set', props.API_KEY === 'abcd1234ef567890', props);

let r = ctx.doGet({ parameter: { key: 'nope', action: 'ping' } });
expect('bad key denied', JSON.parse(r.text).status === 'denied', r);
expect('ping', call({ action: 'ping' }).ok);

offResponses['0012345678905'] = { product_name: 'Penne', brands: 'Barilla, X', quantity: '500 g' };
r = call({ action: 'add', code: '012345678905', qty: 6 }); // 12-digit -> padded
expect('OFF lookup creates + adds', r.ok && r.status === 'created' && r.onHand === 6 && /Penne 500 g/.test(r.message), r);
r = call({ action: 'add', code: '0012345678905', qty: 2 });
expect('existing add', r.status === 'ok' && r.onHand === 8, r);

r = call({ action: 'remove', code: '5555555555555' });
expect('unknown -> status unknown', r.status === 'unknown', r);
r = call({ action: 'add', code: '5555555555555', name: 'Local rum', locker: 'Port aft' });
expect('unknown with name creates', r.ok && r.onHand === 1, r);

// min qty + auto wishlist
const items = sheets.Items;
const pr = ctx.findRow_(items, '0012345678905');
items.getRange(pr, 7).setValue(3);  // Min Qty
items.getRange(pr, 8).setValue(1.5); // estimate
r = call({ action: 'remove', code: '0012345678905', qty: 5 });
expect('remove to min triggers wishlist', r.onHand === 3 && /wishlist/.test(r.message), r);
expect('wishlist row open', sheets.Wishlist.getRange(2, 1, 1, 7).getValues()[0][5] === 'Open');
r = call({ action: 'remove', code: '0012345678905' });
expect('no duplicate wish', sheets.Wishlist.getLastRow() === 2, sheets.Wishlist.data);
r = call({ action: 'wish', code: '0012345678905', qty: 2 });
expect('wish increments open row', /wishlist \(\d+\)/.test(r.message) && sheets.Wishlist.getLastRow() === 2, r);
r = call({ action: 'add', code: '0012345678905', qty: 10 });
expect('add closes wishlist', /ticked off/.test(r.message) && sheets.Wishlist.getRange(2, 6).getValue() === 'Bought', r);
r = call({ action: 'remove', code: '5555555555555', qty: 3 });
expect('over-remove clamps to 0', r.onHand === 0 && /count was off/.test(r.message), r);

// stocktake
r = call({ action: 'count', code: '0012345678905', qty: 4, locker: 'Galley 1', session: '2026-11-16' });
r = call({ action: 'count', code: '0012345678905', qty: 3, locker: 'Galley 1', session: '2026-11-16' });
expect('count running total', /7 counted/.test(r.message), r);
// an item expected in Galley 1 but not scanned
call({ action: 'add', code: 'TINNED-TOMS', name: 'Tinned tomatoes', qty: 5 });
items.getRange(ctx.findRow_(items, 'TINNED-TOMS'), 9).setValue('Galley 1');
ctx.buildStocktakeReview();
const rv = sheets['Stocktake Review'].getRange(2, 1, 2, 10).getValues();
expect('review: not-found first', rv[0][3] === 'Tinned tomatoes' && rv[0][7].startsWith('NOT FOUND') && rv[0][8] === false, rv);
expect('review: penne diff', rv[1][4] === 12 && rv[1][5] === 7 && rv[1][6] === -5 && rv[1][8] === true, rv);
ctx.applyStocktakeReview();
expect('apply sets on hand', items.getRange(pr, 6).getValue() === 7);
expect('stocktake logged negative', sheets.Log.data.some(row => row[3] === 'stocktake' && row[4] === -5), sheets.Log.data);
expect('unticked not applied', items.getRange(ctx.findRow_(items, 'TINNED-TOMS'), 6).getValue() === 5);

// locker on add
call({ action: 'add', code: '7777777777777', name: 'Coffee', locker: 'Stbd hull 2' });
const cr = ctx.findRow_(items, '7777777777777');
expect('add sets locker on new item', items.getRange(cr, 9).getValue() === 'Stbd hull 2');
r = call({ action: 'add', code: '7777777777777', locker: 'Galley 1' });
expect('add appends second locker', /also stored in Galley 1/.test(r.message) && items.getRange(cr, 9).getValue() === 'Stbd hull 2, Galley 1', r);
r = call({ action: 'add', code: '7777777777777', locker: 'galley 1' });
expect('same locker (case) not duplicated', items.getRange(cr, 9).getValue() === 'Stbd hull 2, Galley 1', r);
r = call({ action: 'add', code: '7777777777777' });
expect('add without locker no warning', !/usually/.test(r.message), r);

// multi-locker stocktake: milk in bulk + quick access, only Floor counted
call({ action: 'add', code: 'MILK', name: 'UHT milk', qty: 10, locker: 'Saloon seat' });
call({ action: 'add', code: 'MILK', qty: 2, locker: 'Floor' });
call({ action: 'count', code: 'MILK', qty: 2, locker: 'Floor', session: '2026-11-18' });
ctx.buildStocktakeReview();
let rv2 = sheets['Stocktake Review'].getRange(2, 1, 1, 10).getValues()[0];
expect('partial count flagged + unticked', rv2[3] === 'UHT milk' && /PARTIAL.*Saloon seat/.test(rv2[7]) && rv2[8] === false, rv2);
call({ action: 'count', code: 'MILK', qty: 9, locker: 'Saloon seat', session: '2026-11-18' });
ctx.buildStocktakeReview();
rv2 = sheets['Stocktake Review'].getRange(2, 1, 1, 10).getValues()[0];
expect('both lockers counted -> Different, ticked, total 11', rv2[7] === 'Different' && rv2[5] === 11 && rv2[8] === true, rv2);

// lockers list
expect('lockers tab exists', !!sheets.Lockers);
r = call({ action: 'lockers' });
expect('empty list ok', r.ok && Array.isArray(r.lockers) && r.lockers.length === 0, r);
ctx.setup(); // re-run: seeds from Items
r = call({ action: 'lockers' });
expect('seeded from items', ['Galley 1', 'Port aft', 'Stbd hull 2', 'Saloon seat', 'Floor'].every(l => r.lockers.includes(l)) && r.lockers.length === 5, r);
expect('setup rerun keeps key + items', props.API_KEY === 'abcd1234ef567890' && ctx.findRow_(items, 'MILK') > 0);
r = call({ action: 'add', code: 'MILK', locker: 'Flor' });
expect('unknown locker rejected', !r.ok && /not in the Lockers tab/.test(r.message), r);
r = call({ action: 'add', code: 'MILK', locker: 'floor' });
expect('known locker (case-insensitive) ok', r.ok, r);

// brand
offResponses['0071018010190'] = { product_name: 'Peanut butter', brands: '', brand_owner: 'Acme Foods Inc.', quantity: '16 oz' };
r = call({ action: 'add', code: '0071018010190' });
expect('brand_owner fallback shown', /Acme Foods Inc\. Peanut butter 16 oz/.test(r.message), r);
r = call({ action: 'add', code: '0012345678905' });
expect('brand not duplicated when in name? (Barilla + Penne)', /Barilla Penne 500 g/.test(r.message), r);
offResponses['0099999999999'] = { product_name: 'Barilla Fusilli', brands: 'Barilla' };
r = call({ action: 'add', code: '0099999999999' });
expect('brand skipped when already in name', /\] Barilla Fusilli/.test(r.message) && !/Barilla Barilla/.test(r.message), r);
items.getRange(ctx.findRow_(items, '0071018010190'), 3).setValue('');
ctx.fillMissingBrands();
expect('fillMissingBrands', items.getRange(ctx.findRow_(items, '0071018010190'), 3).getValue() === 'Acme Foods Inc.');

offResponses['0088888888888'] = { product_name: 'Oat milk', brands: 'Oatly', quantity: '1 L' };
r = call({ action: 'wish', code: '0088888888888' });
const wl = sheets.Wishlist.data[sheets.Wishlist.getLastRow() - 1];
expect('wishlist shows brand + size', wl[2] === 'Oatly Oat milk 1 L' && /\[NEW\] Oatly Oat milk 1 L/.test(r.message), { wl, r });
expect('wished item in catalogue with 0 on hand', items.getRange(ctx.findRow_(items, '0088888888888'), 6).getValue() === 0);

// plan
ctx.refreshPlan();
const plan = sheets.Plan;
expect('plan header row 9', plan.getRange(9, 1).getValue() === 'Name');
expect('plan has 8 items', plan.getRange(10, 1, 8, 1).getValues().every(x => x[0]), plan.data.slice(9));
console.log('sample plan formula F10:', plan.getRange(10, 6).getValue());

// retry protection (rid)
const before = items.getRange(ctx.findRow_(items, 'MILK'), 6).getValue();
r = call({ action: 'add', code: 'MILK', qty: 2, rid: 'abc-1' });
const r2 = call({ action: 'add', code: 'MILK', qty: 2, rid: 'abc-1' });
expect('rid: retry not applied twice', items.getRange(ctx.findRow_(items, 'MILK'), 6).getValue() === before + 2 && r2.duplicate === true && r2.message === r.message, { r, r2 });
call({ action: 'add', code: 'MILK', qty: 1, rid: 'abc-2' });
expect('rid: new rid applied', items.getRange(ctx.findRow_(items, 'MILK'), 6).getValue() === before + 3);

// setup QR html
props.WEB_APP_URL = 'https://script.google.com/macros/s/AKfyTEST/exec';
const html = ctx.setupQrHtml_(props.WEB_APP_URL, props.API_KEY);
expect('setup QR renders svg', /<svg[\s\S]*<\/svg>/.test(html) && html.includes('AKfyTEST'), html.slice(0, 200));
const qr = ctx.qrcode(0, 'M'); qr.addData(JSON.stringify({ t: 'freddy-grocery', u: props.WEB_APP_URL, k: props.API_KEY })); qr.make();
expect('QR module count sane', qr.getModuleCount() >= 25, qr.getModuleCount());
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
