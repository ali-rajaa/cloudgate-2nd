// End-to-end browser test of the business (vendor) screens.
// Creates its own approved business and NGO through the service role, then
// drives the app in Chromium like a person: typing, tapping, uploading a photo.
//
//   cd supabase/tests && node e2e-vendor.mjs
//   (APP_URL defaults to http://127.0.0.1:4021/app/; keys default to the local stack's)

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const APP = process.env.APP_URL || 'http://127.0.0.1:4021/app/';
const SHOTS = process.env.SHOTS_DIR || '/tmp/claude-0/-home-user/a3b53ec8-58ae-5e8d-ac3b-c3e65a0793c6/scratchpad/vendor-shots';
mkdirSync(SHOTS, { recursive: true });

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL, SERVICE, opts);
const run = Date.now().toString(36);
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function must(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();

async function user(name) {
  const email = `e2e-vendor-${name}-${run}@test.rizq`;
  const password = 'Passw0rd!x';
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const client = createClient(URL, ANON, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { id: data.user.id, client, email, password };
}

async function approvedOrg(u, type, name, extra) {
  const org = await must(u.client, 'create_organisation', { p_type: type, p_name: name, p_business_kind: type === 'vendor' ? 'Bakery' : 'NGO', p_phone: '+923001234567' });
  await must(u.client, 'update_organisation', { p_org: org, p_fields: { address: 'Shop 12, Street 3', sector: 'F-7 Markaz', lat: 33.7215, lng: 73.0566, ntn: '1234567-8', ...extra } });
  const { error } = await service.from('organisations').update({ status: 'approved', approved_at: new Date().toISOString(), ...(type === 'ngo' ? { tier: 'A' } : {}) }).eq('id', org);
  if (error) throw error;
  return org;
}

function listingArgs(vendor, over = {}) {
  return {
    p_vendor: vendor, p_title: 'Plain buns, 30 pieces', p_category: 'plain_bakery', p_quantity: 30, p_unit: 'pieces',
    p_weight_kg: 3, p_retail_value_rs: 3000, p_price_rs: 1000, p_storage: 'room', p_prepared_at: minutes(-30),
    p_safe_until: minutes(20 * 60), p_pickup_start: minutes(40), p_pickup_end: minutes(180),
    p_description: null, p_feeds_about: 10, p_dietary: { halal: 'vendor_declared' }, p_instructions: null, ...over,
  };
}

console.log('\nRizq Rasan vendor screens, e2e run', run);

// ---------------------------------------------------------------------------
console.log('\n0. Test data');
const vendorU = await user('vendor');
const ngoU = await user('ngo');
const vendor = await approvedOrg(vendorU, 'vendor', `E2E Bakery ${run}`, { raast_id: '03001234567', bank_account_title: 'E2E Bakery', bank_iban: 'PK36SCBL0000001123456702', pickup_instructions: 'Back counter' });
const ngo = await approvedOrg(ngoU, 'ngo', `E2E Kitchen ${run}`, { lat: 33.7, lng: 73.04, sector: 'G-9/4' });
const { data: col, error: colErr } = await ngoU.client.from('collectors').insert({ organisation_id: ngo, name: 'Imran Khan', phone: '+923331234567' }).select().single();
if (colErr) throw colErr;
const settingsRows = (await service.from('settings').select('key, value')).data;
const setting = (k) => settingsRows.find((r) => r.key === k)?.value;
const originalMode = setting('payment_mode');
async function ensureDirect() {
  const { data } = await service.from('settings').select('value').eq('key', 'payment_mode').single();
  if (data.value !== 'direct') await service.from('settings').update({ value: 'direct' }).eq('key', 'payment_mode');
}
await ensureDirect();
const chargeDirect = setting('charge_commission_in_direct_mode') === true;
ok(true, `approved business ${vendor.slice(0, 8)} and NGO ${ngo.slice(0, 8)} created; payment mode direct`);

// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
let expectHttpErrors = false;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (expectHttpErrors && /Failed to load resource/.test(m.text())) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const hash = () => page.evaluate(() => location.hash);
async function goto(path) {
  await page.evaluate((p) => { location.hash = '#' + p; }, path);
  await page.waitForFunction((p) => location.hash.split('?')[0] === '#' + p, path);
  await page.waitForSelector('#app-view .app-loading', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(150);
}
async function noOverflow(name) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  ok(w.doc <= w.vw, `no horizontal overflow on ${name} at ${w.vw}px`, w);
}
async function shot(name) { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); }
const text = (sel) => page.locator(sel).innerText();
const db = async (table, id, cols = 'status') => (await service.from(table).select(cols).eq('id', id).single()).data;

try {
  // -------------------------------------------------------------------------
  console.log('\n1. Log in and Today');
  await page.goto(APP + '#/login');
  await page.fill('input[name=email]', vendorU.email);
  await page.fill('input[name=password]', vendorU.password);
  await page.click('button:has-text("Log in")');
  await page.waitForFunction(() => location.hash === '#/vendor', null, { timeout: 15000 });
  await page.waitForSelector('.app-stats');
  ok(await page.locator('h1.app-title', { hasText: 'Today' }).isVisible(), 'business lands on Today');
  ok(await page.locator('text=List your first surplus in under a minute').isVisible(), 'first visit shows the "list your first surplus" empty state');
  ok((await text('[data-stat="live"] .app-stat__value')) === '0', 'live listings tile starts at 0');
  ok(await page.locator('#vd-record').innerText().then((t) => /100 out of 100/.test(t) && /None/.test(t)), 'reliability score 100 and no strikes shown');
  await noOverflow('Today');
  await shot('01-today-empty');

  // -------------------------------------------------------------------------
  console.log('\n2. List food (4 steps)');
  await page.click('.app-page-head a:has-text("List food")');
  await page.waitForSelector('.vd-form');
  ok((await page.textContent('.vd-stepcount')) === 'Step 1 of 4', 'form starts at step 1 of 4');
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=Add a photo of the food.').isVisible(), 'photo is required before continuing');
  const photo = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 600;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 800, 600); grad.addColorStop(0, '#d9a066'); grad.addColorStop(1, '#8a5a2b');
    g.fillStyle = grad; g.fillRect(0, 0, 800, 600);
    g.fillStyle = '#f3d29b';
    for (let i = 0; i < 12; i++) { g.beginPath(); g.ellipse(80 + (i % 4) * 200, 110 + Math.floor(i / 4) * 190, 85, 60, 0.3, 0, Math.PI * 2); g.fill(); }
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await page.setInputFiles('input[name=photos]', { name: 'naan.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo, 'base64') });
  await page.waitForSelector('.vd-photo img');
  ok(await page.locator('.vd-photo').count() === 1, 'photo preview appears after choosing a photo');
  await shot('02-new-step1');
  await page.click('.vd-stepbar button[type=submit]');
  ok((await page.textContent('.vd-stepcount')) === 'Step 2 of 4', 'continues to step 2');

  const catOptions = await page.$$eval('select[name=category] option', (os) => os.map((o) => o.value).filter(Boolean));
  const cookedOpen = setting('cooked_food_open') === true;
  ok(catOptions.includes('tandoor_breads') && !catOptions.includes('dairy') && !catOptions.includes('cream_bakery') && (cookedOpen || !catOptions.includes('curries')),
    'only categories open now are offered', catOptions);
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=Enter a title of at least 3 characters.').isVisible(), 'step 2 validates the title');
  const title = `Naan and sheermal ${run}`;
  await page.fill('input[name=title]', title);
  await page.selectOption('select[name=category]', 'tandoor_breads');
  await page.fill('input[name=quantity]', '40');
  await page.selectOption('select[name=unit]', 'pieces');
  await page.fill('input[name=weight]', '6');
  await page.fill('input[name=feeds]', '14');
  await page.check('input[name=allergen-gluten]');
  await noOverflow('List food step 2');
  await shot('03-new-step2');
  await page.click('.vd-stepbar button[type=submit]');
  ok((await page.textContent('.vd-stepcount')) === 'Step 3 of 4', 'continues to step 3');

  await page.waitForFunction(() => document.querySelector('input[name=safe]').value !== '');
  const safe = await page.$eval('input[name=safe]', (i) => ({ value: i.value, max: i.max }));
  ok(safe.value && safe.value === safe.max, 'safe-until is filled in from the category limit', safe);
  await page.fill('input[name=retail]', '2400');
  await page.fill('input[name=price]', '900');
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=Listings start at Rs 1,000.').isVisible(), 'price under the minimum is caught in the form');
  await page.fill('input[name=price]', '1500');
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=/at most half of the retail value \\(Rs 1,200/').isVisible(), 'price over half of retail is caught in the form');
  await page.fill('input[name=price]', '1200');
  const split = await text('#vd-split');
  const expShare = chargeDirect ? 1200 - Math.floor(1200 * Number(setting('commission_percent')) / 100) : 1200;
  ok(/NGO pays\s*Rs 1,200/.test(split) && new RegExp(`You receive\\s*Rs ${expShare.toLocaleString('en-US')}`).test(split), 'live split preview shows NGO pays / you receive / Rizq Rasan', split);
  // Safe-until can only be made shorter.
  const later = await page.evaluate(() => { const v = document.querySelector('input[name=safe]').value; const d = new Date(v + ':00Z'); d.setUTCHours(d.getUTCHours() + 2); return d.toISOString().slice(0, 16); });
  await page.fill('input[name=safe]', later);
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=/For this food the safe-until time can be at most/').isVisible(), 'safe-until later than the category limit is refused');
  await page.fill('input[name=safe]', safe.max);
  await noOverflow('List food step 3');
  await shot('04-new-step3');
  await page.click('.vd-stepbar button[type=submit]');
  ok((await page.textContent('.vd-stepcount')) === 'Step 4 of 4', 'continues to review');
  ok(await page.locator('.vd-card .app-card__title', { hasText: title }).isVisible(), 'review shows the card NGOs will see');
  await page.click('.vd-stepbar button[type=submit]');
  ok(await page.locator('text=Tick to confirm the food is safe.').isVisible(), 'safety ticks are required');
  await page.check('input[name=safe-tick]');
  await page.check('input[name=true-tick]');
  await shot('05-new-review');

  // The server is the judge: its message shows under the right field.
  expectHttpErrors = true;
  await page.route('**/rest/v1/rpc/create_listing', (route) => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ code: 'P0001', message: 'Pickup must end at least 60 minutes from now.', details: null, hint: null }) }), { times: 1 });
  await page.click('.vd-stepbar button[type=submit]');
  await page.waitForSelector('text=Pickup must end at least 60 minutes from now.');
  ok((await page.textContent('.vd-stepcount')) === 'Step 3 of 4' && await page.locator('input[name=end][aria-invalid=true]').count() === 1, 'server error shows inline under pickup end');
  await page.unroute('**/rest/v1/rpc/create_listing');
  expectHttpErrors = false;
  await page.click('.vd-stepbar button[type=submit]');
  await page.click('.vd-stepbar button[type=submit]');
  await page.waitForFunction(() => /^#\/vendor\/listings\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 20000 });
  const listing1 = (await hash()).split('/').pop();
  await page.waitForSelector('.vd-gallery img');
  ok(await page.locator('.app-page-head .badge', { hasText: 'Live' }).isVisible(), 'published listing is Live');
  const imgOk = await page.$eval('.vd-gallery img', (i) => i.complete ? i.naturalWidth > 0 : new Promise((r) => { i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); }));
  ok(imgOk, 'uploaded photo shows on the listing');
  const photos1 = (await service.from('listing_photos').select('file_path').eq('listing_id', listing1)).data;
  ok(photos1.length === 1 && photos1[0].file_path.startsWith(vendor + '/'), 'photo stored in the business folder and linked to the listing', photos1);
  const l1 = await db('listings', listing1, 'status, price_rs, dietary, safe_until, category_id');
  ok(l1.status === 'live' && l1.price_rs === 1200 && l1.dietary.contains?.includes('gluten') && l1.dietary.halal === 'vendor_declared', 'listing saved with price and dietary details', l1);
  await noOverflow('listing detail');
  await shot('06-listing-live');

  // -------------------------------------------------------------------------
  console.log('\n3. Listings page');
  await goto('/vendor/listings');
  ok(await page.locator('.vd-item', { hasText: title }).isVisible(), 'listing appears under the Live tab');
  ok(/Ends in/.test(await page.locator('.vd-item', { hasText: title }).innerText()), 'row shows time left');
  await noOverflow('Listings');
  await shot('07-listings');

  // -------------------------------------------------------------------------
  console.log('\n4. Claim, payment and confirmation (live)');
  await goto('/vendor');
  ok((await text('[data-stat="live"] .app-stat__value')) === '1', 'Today shows 1 live listing');
  await ensureDirect();
  const order1 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing1, p_collector: col.id });
  await page.waitForSelector(`#vd-waiting .vd-item:has-text("${title}")`, { timeout: 15000 });
  ok(true, 'the claim appears on Today without reloading');
  ok(/E2E Kitchen/.test(await text('#vd-waiting')), 'claim shows the NGO name');
  await must(ngoU.client, 'ngo_mark_paid', { p_order: order1, p_reference: 'RAAST-778899' });
  await page.waitForSelector(`#vd-confirm .vd-item:has-text("${title}")`, { timeout: 15000 });
  ok(/RAAST-778899/.test(await text('#vd-confirm')), 'payment to confirm shows the NGO\'s reference live');
  await shot('08-today-confirm');
  await page.click('#vd-confirm button:has-text("Payment received")');
  await page.waitForSelector(`#vd-due .vd-item:has-text("${title}")`, { timeout: 15000 });
  ok((await db('orders', order1)).status === 'paid', 'confirming payment marks the order paid');
  ok((await text('[data-stat="due"] .app-stat__value')) === '1', 'pickups due today tile shows 1');
  ok(/Rs 1,200/.test(await text('[data-stat="money"]')), 'payments confirmed today tile shows Rs 1,200');
  await noOverflow('Today with orders');
  await shot('09-today-due');

  // -------------------------------------------------------------------------
  console.log('\n5. Pickups and the pickup code keypad');
  const det = await must(ngoU.client, 'order_details', { p_order: order1 });
  const code = det.pickup_code;
  ok(/^\d{4}$/.test(code), 'NGO can read its 4-digit pickup code');
  const vendorView = await must(vendorU.client, 'order_details', { p_order: order1 });
  ok(vendorView.pickup_code === null, 'the business never receives the code');
  await goto('/vendor/pickups');
  ok(await page.locator('.vd-item', { hasText: title }).isVisible(), 'paid order is under To hand over');
  ok(/Imran Khan/.test(await page.locator('.vd-item', { hasText: title }).innerText()), 'row shows the collector\'s name');
  await noOverflow('Pickups');
  await shot('10-pickups');
  await page.click('a.vd-codebtn');
  await page.waitForSelector('.app-keypad');
  ok(/Imran Khan/.test(await text('#vd-expected')), 'keypad screen lists who is expected');
  const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
  for (const d of wrong) await page.click(`.app-keypad button[data-key="${d}"]`);
  ok((await page.$$eval('.app-keypad__digit', (b) => b.map((x) => x.textContent).join(''))) === wrong, 'keypad shows the digits entered');
  await page.click('button.vd-confirm');
  await page.waitForSelector('.vd-code-msg:not([hidden])');
  ok(/doesn't match a paid order/.test(await text('.vd-code-msg')), 'wrong code shows the server message');
  ok((await db('orders', order1)).status === 'paid', 'wrong code changes nothing');
  await page.click('.app-keypad__digit');
  await page.keyboard.type(code);
  await page.click('button.vd-confirm');
  await page.waitForSelector('.vd-match', { timeout: 15000 });
  const match = await text('.vd-match');
  ok(/E2E Kitchen/.test(match) && /Imran Khan/.test(match) && /Rs 1,200/.test(match), 'right code shows the NGO, collector and amount', match);
  ok(/40 pieces/.test(match), 'quantity handed over is shown');
  const o1 = await db('orders', order1, 'status, quantity_handed_over');
  ok(o1.status === 'picked_up' && Number(o1.quantity_handed_over) === 40, 'order is marked handed over with the full quantity', o1);
  await noOverflow('pickup code');
  await shot('11-code-match');

  // -------------------------------------------------------------------------
  console.log('\n6. Order page and problem report');
  await goto('/vendor/orders/' + order1);
  ok(await page.locator('.app-page-head .badge', { hasText: 'Handed over' }).isVisible(), 'order page shows Handed over');
  ok(await page.locator('.app-code').count() === 0, 'order page shows no pickup code');
  await noOverflow('order page');
  await page.click('button:has-text("Report a problem")');
  await page.selectOption('dialog select[name=kind]', 'conduct');
  await page.fill('dialog textarea[name=details]', 'The collector was rude to our staff at the counter.');
  await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => /^#\/disputes\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  const disputeId = (await hash()).split('/').pop();
  ok(!!disputeId, 'reporting a problem opens the report');
  await goto('/vendor/orders/' + order1);
  ok(await page.locator(`#vd-disputes a[href="#/disputes/${disputeId}"]`).isVisible(), 'order page links to the problem report');
  await shot('12-order');
  await goto('/vendor/pickups');
  await page.click('.app-tab:has-text("Problems")');
  ok(await page.waitForSelector(`.vd-item:has-text("${title}")`, { timeout: 10000 }).then(() => true, () => false), 'order with an open report is under Problems');

  // -------------------------------------------------------------------------
  console.log('\n7. Earnings');
  await goto('/vendor/earnings');
  ok(/pay you directly/.test(await text('#app-view')), 'direct mode explains there are no payouts');
  ok(await page.locator('#vd-direct tr', { hasText: title }).isVisible(), 'the order is listed with what the NGO paid');
  ok(/Rs 1,200/.test(await text('#vd-direct')), 'earnings show Rs 1,200');
  await noOverflow('Earnings');
  await shot('13-earnings');

  // -------------------------------------------------------------------------
  console.log('\n8. Edit wording and withdraw');
  const listing2 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: `Plain buns ${run}` }));
  await goto('/vendor/listings/' + listing2);
  ok(await page.locator('text=This listing has no photo.').isVisible(), 'listing without a photo asks for one');
  await page.click('button:has-text("Edit wording")');
  await page.fill('dialog input[name=title]', `Soft buns ${run}`);
  await page.fill('dialog textarea[name=instructions]', 'Bring a crate');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector(`h1.app-title:has-text("Soft buns ${run}")`);
  ok((await db('listings', listing2, 'title, instructions')).instructions === 'Bring a crate', 'wording saved through edit_listing');
  await page.click('button:has-text("Withdraw")');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('.app-page-head .badge:has-text("Withdrawn")');
  ok((await db('listings', listing2)).status === 'withdrawn', 'listing withdrawn after confirming');
  ok(await page.locator('button:has-text("Withdraw")').count() === 0, 'withdrawn listing has no actions');
  await goto('/vendor/listings');
  await page.click('.app-tab:has-text("Ended")');
  ok(await page.waitForSelector(`.vd-item:has-text("Soft buns ${run}")`, { timeout: 10000 }).then(() => true, () => false), 'withdrawn listing is under Ended');

  // -------------------------------------------------------------------------
  console.log('\n9. Confirming payment from Pickups, and code entry lock');
  const listing3 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: `Rusk packets ${run}` }));
  await goto('/vendor/pickups');
  await ensureDirect();
  const order3 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing3, p_collector: col.id });
  await must(ngoU.client, 'ngo_mark_paid', { p_order: order3, p_reference: 'IBFT-5544' });
  await page.click('.app-tab:has-text("Awaiting payment")');
  await page.waitForSelector(`.vd-item:has-text("Rusk packets ${run}") button:has-text("Payment received")`, { timeout: 15000 });
  await page.click(`.vd-item:has-text("Rusk packets ${run}") button:has-text("Payment received")`);
  await page.waitForFunction(() => /To hand over\s*1/.test(document.querySelector('.app-tabs')?.innerText || ''), null, { timeout: 15000 });
  ok((await db('orders', order3)).status === 'paid', 'payment confirmed from the Pickups list');
  const code3 = (await must(ngoU.client, 'order_details', { p_order: order3 })).pickup_code;
  await goto('/vendor/pickups/code');
  const wrongs = [];
  for (let i = 1; wrongs.length < 6; i++) { const c = String((Number(code3) + i * 137) % 10000).padStart(4, '0'); if (c !== code3 && c !== code) wrongs.push(c); }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.type(wrongs[i]);
    await page.click('button.vd-confirm');
    await page.waitForFunction(() => document.querySelectorAll('.app-keypad__digit.is-filled').length === 0);
  }
  ok(/doesn't match/.test(await text('.vd-code-msg')), 'fifth wrong code still shows the mismatch message');
  expectHttpErrors = true;
  await page.keyboard.type(wrongs[5]);
  await page.click('button.vd-confirm');
  await page.waitForFunction(() => /locked/.test(document.querySelector('.vd-code-msg')?.innerText || ''), null, { timeout: 10000 });
  ok(/Too many wrong codes/.test(await text('.vd-code-msg')), 'after 5 wrong codes entry is locked with the server message');
  await page.keyboard.type(code3);
  await page.click('button.vd-confirm');
  await page.waitForFunction(() => document.querySelectorAll('.app-keypad__digit.is-filled').length === 0);
  ok((await db('orders', order3)).status === 'paid' && /locked/.test(await text('.vd-code-msg')), 'even the right code is refused while locked');
  expectHttpErrors = false;
  await shot('14-code-locked');

  // -------------------------------------------------------------------------
  console.log('\n10. "Did they collect?" (live)');
  await goto('/vendor');
  await service.from('orders').update({ status: 'awaiting_collection_answer', collection_asked_at: new Date().toISOString() }).eq('id', order3);
  await page.waitForSelector(`#vd-ask .vd-item:has-text("Rusk packets ${run}")`, { timeout: 15000 });
  ok(true, 'the collection question appears on Today live');
  await shot('15-today-ask');
  await page.click(`#vd-ask button:has-text("Yes, they collected")`);
  await page.waitForSelector('#vd-ask', { state: 'detached', timeout: 15000 });
  ok((await db('orders', order3)).status === 'picked_up', 'answering yes marks the order handed over');

  // -------------------------------------------------------------------------
  console.log('\n11. Payment not received, then cancel');
  const listing4 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: `Fruit box ${run}`, p_category: 'fruit_veg' }));
  await ensureDirect();
  const order4 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing4, p_collector: null });
  await must(ngoU.client, 'ngo_mark_paid', { p_order: order4, p_reference: 'RAAST-0001' });
  await goto('/vendor/orders/' + order4);
  ok(/RAAST-0001/.test(await text('.notice')), 'order page asks to check the NGO\'s payment');
  await page.click('button:has-text("Not received")');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('.app-page-head .badge:has-text("Waiting for payment")', { timeout: 15000 });
  ok((await db('orders', order4)).status === 'payment_due', '"Not received" sends the order back to waiting for payment');
  await page.click('button:has-text("Cancel order")');
  ok(/nothing is charged/.test(await text('dialog')), 'cancel dialog explains the effect before payment');
  await page.click('dialog button[type=submit]');
  ok(await page.locator('dialog .field__error', { hasText: 'This is needed.' }).isVisible(), 'cancel needs a reason');
  await page.fill('dialog textarea[name=reason]', 'Oven broke, the food is not ready');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('.app-page-head .badge:has-text("Cancelled by business")', { timeout: 15000 });
  const o4 = await db('orders', order4, 'status, ended_reason');
  ok(o4.status === 'cancelled_by_vendor' && /Oven broke/.test(o4.ended_reason), 'order cancelled with the reason', o4);
  const strikes = (await service.from('strikes').select('id').eq('organisation_id', vendor)).data;
  ok(strikes.length === 0, 'cancelling before payment gives no strike');

  // -------------------------------------------------------------------------
  console.log('\n12. Desktop layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [path, name] of [['/vendor', 'today'], ['/vendor/new', 'new'], ['/vendor/listings', 'listings'], ['/vendor/listings/' + listing1, 'listing'],
    ['/vendor/pickups', 'pickups'], ['/vendor/pickups/code', 'code'], ['/vendor/orders/' + order1, 'order'], ['/vendor/earnings', 'earnings']]) {
    await goto(path);
    await noOverflow(name + ' (desktop)');
    await shot('20-desktop-' + name);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, name] of [['/vendor/new', 'new'], ['/vendor/pickups/code', 'code']]) { await goto(path); await noOverflow(name); }
} catch (e) {
  failed++;
  failures.push('exception: ' + e.message);
  console.log('  ✗ exception:', e.message);
  await shot('99-failure').catch(() => {});
} finally {
  ok(consoleErrors.length === 0, 'no JavaScript or console errors', consoleErrors);
  await browser.close();
  if (originalMode !== 'direct') await service.from('settings').update({ value: originalMode }).eq('key', 'payment_mode');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('Failed:', failures.join('; '));
process.exit(failed ? 1 : 0);
