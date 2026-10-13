// Browser test of the NGO screens (assets/app/ngo.js) against the local Supabase.
// It creates its own businesses, NGO and listings, then drives the app like a person.
//
//   cd supabase/tests && SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... APP_URL=http://127.0.0.1:4022/app/ node e2e-ngo.mjs
//
// Screenshots go to SHOTS_DIR (default: ./e2e-shots-ngo).

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.APP_URL || 'http://127.0.0.1:4022/app/';
const SHOTS = process.env.SHOTS_DIR || './e2e-shots-ngo';
if (!ANON || !SERVICE) { console.error('Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL, SERVICE, opts);
const run = Date.now().toString(36);
const PASSWORD = 'Passw0rd!x';
let passed = 0, failed = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function check(name, fn) {
  try { const r = await fn(); ok(r !== false, name, r === false ? undefined : undefined); }
  catch (e) { ok(false, name, String(e.message || e).split('\n')[0]); }
}
async function must(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
async function user(name) {
  const email = `${name}-${run}@test.rizq`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const client = createClient(URL, ANON, opts);
  const s = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (s.error) throw s.error;
  return { id: data.user.id, client, email };
}
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();

async function approvedOrg(u, type, name, fields, extra = {}) {
  const org = await must(u.client, 'create_organisation', { p_type: type, p_name: name, p_business_kind: type === 'vendor' ? 'Bakery' : 'NGO', p_phone: '+923001234567' });
  await must(u.client, 'update_organisation', { p_org: org, p_fields: fields });
  const { error } = await service.from('organisations').update({ status: 'approved', approved_at: new Date().toISOString(), ...extra }).eq('id', org);
  if (error) throw error;
  return org;
}

function listing(vendor, title, over = {}) {
  return {
    p_vendor: vendor, p_title: title, p_category: 'tandoor_breads', p_quantity: 40, p_unit: 'pieces',
    p_weight_kg: 6, p_retail_value_rs: 2400, p_price_rs: 1200, p_storage: 'room', p_prepared_at: minutes(-60),
    p_safe_until: minutes(16 * 60), p_pickup_start: minutes(70), p_pickup_end: minutes(130),
    p_description: 'Fresh this evening', p_feeds_about: 14, p_dietary: { vegetarian: true, halal: 'vendor_declared', contains: ['gluten'] },
    p_instructions: 'Ask at the back counter', ...over,
  };
}

// A small solid PNG (8x8) for the listing photo.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEXCiE3///+2y7tMAAAAEUlEQVQI12P4z8DAwMDAAAQABgABTYV1pgAAAABJRU5ErkJggg==', 'base64');

console.log('\nRizq Rasan NGO screens e2e, run', run);

// ---------------------------------------------------------------------------
console.log('\n1. Test data');
const mode = (await service.from('settings').select('value').eq('key', 'payment_mode').single()).data?.value;
if (mode !== 'direct') { console.error(`payment_mode is ${JSON.stringify(mode)}; this test needs "direct".`); process.exit(2); }
const vendorU = await user('ngo-e2e-vendor'), vendor2U = await user('ngo-e2e-vendor2'), ngoU = await user('ngo-e2e-ngo'), ngo2U = await user('ngo-e2e-ngo2');
const vendor = await approvedOrg(vendorU, 'vendor', `Tandoor House ${run}`, {
  address: 'Shop 12, Street 3', sector: 'F-7 Markaz', lat: 33.7215, lng: 73.0566, ntn: '1234567-8',
  pickup_instructions: 'Use the side door after 9 pm', raast_id: '03001234567', bank_account_title: 'Tandoor House', bank_iban: 'PK36SCBL0000001123456702',
});
const vendor2 = await approvedOrg(vendor2U, 'vendor', `Far Bakery ${run}`, {
  address: 'Plot 4, Blue Area', sector: 'Blue Area', lat: 33.7380, lng: 73.0900, ntn: '7654321-0', raast_id: '03111234567', bank_account_title: 'Far Bakery',
});
const ngo = await approvedOrg(ngoU, 'ngo', `Kitchen ${run}`, { address: 'House 5, Street 9', sector: 'G-9', lat: 33.6938, lng: 73.0297 }, { tier: 'A' });
const ngo2 = await approvedOrg(ngo2U, 'ngo', `Shelter ${run}`, { address: 'House 1', sector: 'G-10', lat: 33.69, lng: 73.02 }, { tier: 'A' });

const T = {
  naan: `Naan and sheermal ${run}`, fruit: `Fruit box ${run}`, rusk: `Rusk packs ${run}`, late: `Evening rotis ${run}`,
  far: `Far buns ${run}`, gone: `Parathas ${run}`, unsafe: `Sheermal tray ${run}`,
};
const L = {};
L.naan = await must(vendorU.client, 'create_listing', listing(vendor, T.naan));
L.fruit = await must(vendorU.client, 'create_listing', listing(vendor, T.fruit, { p_category: 'fruit_veg', p_price_rs: 2500, p_retail_value_rs: 6000, p_pickup_end: minutes(200), p_dietary: { vegan: true } }));
L.rusk = await must(vendorU.client, 'create_listing', listing(vendor, T.rusk, { p_category: 'plain_bakery', p_price_rs: 1000, p_retail_value_rs: 2000, p_pickup_end: minutes(190) }));
L.late = await must(vendorU.client, 'create_listing', listing(vendor, T.late, { p_pickup_start: minutes(20), p_pickup_end: minutes(95) }));
L.gone = await must(vendorU.client, 'create_listing', listing(vendor, T.gone, { p_pickup_end: minutes(180) }));
L.unsafe = await must(vendorU.client, 'create_listing', listing(vendor, T.unsafe, { p_pickup_end: minutes(185) }));
L.far = await must(vendor2U.client, 'create_listing', listing(vendor2, T.far, { p_category: 'plain_bakery' }));
{
  const path = `${vendor}/naan-${run}.png`;
  const up = await vendorU.client.storage.from('listing-photos').upload(path, PNG, { contentType: 'image/png' });
  if (up.error) throw new Error('photo upload: ' + up.error.message);
  await must(vendorU.client, 'add_listing_photo', { p_listing: L.naan, p_path: path });
}
ok(Object.values(L).every(Boolean), 'two approved businesses, two approved NGOs and 7 live listings created');

// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_NAME_NOT_RESOLVED/.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.setDefaultTimeout(15000);

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const view = page.locator('#app-view');
const cardFor = (title) => page.locator('.ngo-card', { hasText: title });
const dialogBox = page.locator('dialog.app-dialog');
async function goto(hash) { await page.goto(APP + '#' + hash); await page.waitForSelector('#app-view > :not(.app-loading)'); }
async function waitText(text, timeout = 15000) { await view.getByText(text, { exact: false }).first().waitFor({ timeout }); return true; }
async function claimFromCard(title) {
  await goto('/ngo');
  await cardFor(title).click();
  await page.locator('.ngo-claim-btn').waitFor();
  await page.locator('.ngo-claim-btn').click();
  await dialogBox.locator('button[type=submit]').click();
  await page.waitForURL(/#\/ngo\/claims\/[0-9a-f-]{36}$/);
  await page.locator('.ngo-countdown, .ngo-wait, .ngo-code').first().waitFor();
  return page.url().split('/').pop();
}
async function markPaid(ref) {
  await page.fill('input[name=reference]', ref);
  await page.getByRole('button', { name: 'I\'ve paid' }).click();
  await page.locator('.ngo-wait', { hasText: 'Waiting for the business to confirm' }).waitFor();
}

console.log('\n2. Log in as the NGO');
await page.goto(APP + '#/login');
await page.fill('input[name=email]', ngoU.email);
await page.fill('input[name=password]', PASSWORD);
await page.getByRole('button', { name: 'Log in' }).click();
await check('logging in lands on Find food', async () => { await page.waitForURL(/#\/ngo$/); await page.locator('h1', { hasText: 'Find food' }).waitFor(); });

console.log('\n3. Browse and filter');
await check('nearby listings show as cards, the far business is hidden at 5 km', async () => {
  await cardFor(T.naan).waitFor();
  for (const t of [T.fruit, T.rusk, T.late]) await cardFor(t).waitFor();
  return (await cardFor(T.far).count()) === 0;
});
await check('distance filter defaults to the 5 km setting', async () => (await page.locator('select[name=radius]').inputValue()) === '5');
await check('card shows vendor, distance, badge, price with retail struck through, time left and dietary flags', async () => {
  const c = cardFor(T.naan);
  const text = await c.innerText();
  const okText = text.includes(`Tandoor House ${run}`) && /\d+\.\d km away/.test(text) && text.includes('Highly reliable') && text.includes('Rs 1,200')
    && /Ends in .* \(\d{1,2}:\d\d [ap]m\)/.test(text) && text.includes('Vegetarian') && text.includes('Contains gluten') && text.includes('F-7 Markaz');
  const struck = await c.locator('.app-card__retail').evaluate((e) => getComputedStyle(e).textDecorationLine.includes('line-through') && e.textContent.includes('Rs 2,400'));
  const img = await c.locator('img.app-card__photo').evaluate((e) => e.complete && e.naturalWidth > 0);
  if (!(okText && struck && img)) throw new Error(JSON.stringify({ okText, struck, img, text }));
});
await check('cards are sorted by pickup ending soonest', async () => {
  const titles = await page.locator('.ngo-card .app-card__title').allInnerTexts();
  const i = (t) => titles.indexOf(t);
  return i(T.late) < i(T.naan) && i(T.naan) < i(T.rusk) && i(T.rusk) < i(T.fruit);
});
await check('no horizontal scroll on Find food at 390px', noOverflow);
await shot('01-find-food-390');
await check('widening to 8 km shows the far business', async () => {
  await page.selectOption('select[name=radius]', '8');
  await cardFor(T.far).waitFor();
});
await check('category filter shows only fruit and vegetables', async () => {
  await page.selectOption('select[name=category]', 'fruit_veg');
  await page.waitForFunction((t) => [...document.querySelectorAll('.ngo-card .app-card__title')].every((e) => !e.textContent.includes('Naan and sheermal ' + t)), run);
  await cardFor(T.fruit).waitFor();
  return (await cardFor(T.naan).count()) === 0;
});
await check('max price filter hides the Rs 2,500 fruit box', async () => {
  await page.selectOption('select[name=category]', '');
  await page.selectOption('select[name=max_price]', '1500');
  await cardFor(T.naan).waitFor();
  await page.waitForFunction((t) => ![...document.querySelectorAll('.ngo-card .app-card__title')].some((e) => e.textContent === 'Fruit box ' + t), run);
});
await page.selectOption('select[name=max_price]', '');
await page.selectOption('select[name=radius]', '5');
await cardFor(T.naan).waitFor();

await check('filters are remembered when coming back', async () => {
  await page.selectOption('select[name=category]', 'plain_bakery');
  await cardFor(T.rusk).waitFor();
  await goto('/ngo/collectors');
  await goto('/ngo');
  const v = await page.locator('select[name=category]').inputValue();
  await page.selectOption('select[name=category]', '');
  await cardFor(T.naan).waitFor();
  return v === 'plain_bakery';
});

await check('list refreshes on its own when a listing goes away (focus)', async () => {
  await must(vendorU.client, 'withdraw_listing', { p_listing: L.unsafe }).catch(() => null); // temporarily gone
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction((t) => ![...document.querySelectorAll('.ngo-card .app-card__title')].some((e) => e.textContent === 'Sheermal tray ' + t), run);
});
// Put the unsafe-food listing back (withdrawn listings can't be relisted, so make a new one).
L.unsafe = await must(vendorU.client, 'create_listing', listing(vendor, T.unsafe, { p_pickup_end: minutes(185) }));

console.log('\n4. Notices and the empty state');
await check('empty state explains alerts are coming later and offers a wider radius', async () => {
  await service.from('organisations').update({ lat: 33.88, lng: 72.72 }).eq('id', ngo);
  await goto('/ngo');
  await page.locator('.app-empty', { hasText: 'No food near you right now' }).waitFor();
  const t = await page.locator('.app-empty').innerText();
  if (!/alerts for food near you are coming later/i.test(t) || !/wider distance/i.test(t)) throw new Error(t);
  await shot('02-empty-390');
  await page.getByRole('button', { name: /Show food within 8 km/ }).click();
  return (await page.locator('select[name=radius]').inputValue()) === '8';
});
await page.selectOption('select[name=radius]', '5');
await check('without a map pin, a notice links to the application page', async () => {
  await service.from('organisations').update({ lat: null, lng: null }).eq('id', ngo);
  await goto('/ngo');
  const n = page.locator('.notice', { hasText: 'no map pin' });
  await n.waitFor();
  return (await n.locator('a[href="#/onboarding"]').count()) === 1;
});
await check('claims-paused notice shows while claiming is paused', async () => {
  await service.from('organisations').update({ lat: 33.6938, lng: 73.0297, claims_paused_until: minutes(120) }).eq('id', ngo);
  await goto('/ngo');
  await page.locator('.notice', { hasText: 'Claiming is paused until' }).waitFor();
  await cardFor(T.naan).click();
  await page.locator('.ngo-claim-btn').waitFor();
  return await page.locator('.ngo-claim-btn').isDisabled();
});
await check('frozen notice shows while the account is frozen', async () => {
  await service.from('organisations').update({ claims_paused_until: null, frozen_until: minutes(60) }).eq('id', ngo);
  await goto('/ngo');
  await page.locator('.notice', { hasText: 'because of strikes' }).waitFor();
  await page.locator('.app-empty', { hasText: 'Finding food is paused' }).waitFor();
});
await service.from('organisations').update({ frozen_until: null, claims_paused_until: null }).eq('id', ngo);

console.log('\n5. Collectors');
await goto('/ngo/collectors');
await check('collectors page starts empty with a hint', async () => waitText('No collectors yet'));
await check('a bad mobile number is rejected with a clear message', async () => {
  await page.fill('input[name=name]', 'Ali Raza');
  await page.fill('input[name=phone]', '12345');
  await page.getByRole('button', { name: 'Add collector' }).click();
  await waitText('Enter a Pakistani mobile number');
});
await check('add a collector (name + mobile, number normalised)', async () => {
  await page.fill('input[name=phone]', '0300 765 4321');
  await page.getByRole('button', { name: 'Add collector' }).click();
  await page.locator('.ngo-collector', { hasText: 'Ali Raza' }).waitFor();
  const { data } = await service.from('collectors').select('phone').eq('organisation_id', ngo);
  return data.length === 1 && data[0].phone === '+923007654321' && (await page.locator('.ngo-collector', { hasText: '0300 7654321' }).count()) === 1;
});
await check('add, deactivate and remove a second collector', async () => {
  await page.fill('input[name=name]', 'Bilal Khan');
  await page.fill('input[name=phone]', '+92 321 1112223');
  await page.getByRole('button', { name: 'Add collector' }).click();
  const row = page.locator('.ngo-collector', { hasText: 'Bilal Khan' });
  await row.waitFor();
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await page.locator('.ngo-collector', { hasText: 'Bilal Khan' }).getByText('Inactive').waitFor();
  await page.locator('.ngo-collector', { hasText: 'Bilal Khan' }).getByRole('button', { name: 'Remove' }).click();
  await dialogBox.locator('button[type=submit]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.ngo-collector')].some((e) => e.textContent.includes('Bilal Khan')));
});
await check('at most 5 active collectors', async () => {
  await service.from('collectors').insert([1, 2, 3, 4].map((i) => ({ organisation_id: ngo, name: `Helper ${i}`, phone: `+92300000000${i}` })));
  await goto('/ngo/collectors');
  await waitText('5 of 5 active');
  const disabled = await page.getByRole('button', { name: 'Add collector' }).isDisabled();
  const r = await ngoU.client.from('collectors').insert({ organisation_id: ngo, name: 'Sixth', phone: '+923009999999' });
  await service.from('collectors').delete().eq('organisation_id', ngo).like('name', 'Helper %');
  return disabled && Boolean(r.error);
});
await check('no horizontal scroll on Collectors at 390px', noOverflow);
await shot('03-collectors-390');

console.log('\n6. Claim, pay directly, collect');
await goto('/ngo');
await cardFor(T.naan).click();
await check('listing detail shows time left, facts and the claim button', async () => {
  await page.waitForURL(new RegExp(`#/ngo/listings/${L.naan}$`));
  await page.locator('.ngo-claim-btn', { hasText: 'Claim for Rs 1,200' }).waitFor();
  const t = await view.innerText();
  return /Ends in/.test(t) && t.includes('40 pieces') && t.includes('Shown after you pay') && t.includes('14 people') && t.includes('Room temperature');
});
await check('no horizontal scroll on the listing at 390px', noOverflow);
await shot('04-listing-390');
await page.selectOption('select[name=collector]', { label: 'Ali Raza, 0300 7654321' });
await page.locator('.ngo-claim-btn').click();
await check('claiming asks for confirmation with the hold time', async () => {
  await dialogBox.waitFor();
  const t = await dialogBox.innerText();
  return /hold it for you until \d{1,2}:\d\d [ap]m/.test(t) && t.includes('Rs 1,200');
});
await dialogBox.locator('button[type=submit]').click();
let orderId;
await check('claiming goes to the claim page', async () => {
  await page.waitForURL(/#\/ngo\/claims\/[0-9a-f-]{36}$/);
  orderId = page.url().split('/').pop();
  const { data } = await service.from('orders').select('status, collector_id, listing_id').eq('id', orderId).single();
  return data.status === 'payment_due' && data.listing_id === L.naan && Boolean(data.collector_id);
});
await check('countdown to the payment deadline is shown and ticking', async () => {
  const v = page.locator('.ngo-countdown .app-countdown__value');
  await v.waitFor();
  const a = await v.innerText();
  await page.waitForTimeout(2200);
  const b = await v.innerText();
  return /^\d{1,2}:\d\d$/.test(a) && a !== b && (await page.locator('.ngo-countdown').innerText()).includes('Pay by');
});
await check('direct payment details: amount, Raast ID, account title, IBAN and reference with copy buttons', async () => {
  const t = await page.locator('.ngo-pay').innerText();
  const ref = 'RR-' + orderId.slice(0, 8).toUpperCase();
  const copies = await page.locator('.ngo-copy').count();
  return t.includes('Rs 1,200') && t.includes('03001234567') && t.includes('Tandoor House') && t.includes('PK36 SCBL 0000 0011 2345 6702') && t.includes(ref) && copies === 3;
});
await check('copy button copies the IBAN without spaces', async () => {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(APP).origin });
  await page.getByRole('button', { name: 'Copy IBAN' }).click();
  await page.getByRole('button', { name: 'Copy IBAN' }).getByText('Copied').waitFor();
  return (await page.evaluate(() => navigator.clipboard.readText())) === 'PK36SCBL0000001123456702';
});
await check('no horizontal scroll on the pay page at 390px', noOverflow);
await shot('05-pay-390');
await check('an empty transaction reference is rejected', async () => {
  await page.getByRole('button', { name: 'I\'ve paid' }).click();
  await waitText('Enter the transaction reference');
});
await check('"I\'ve paid" with a reference shows "Waiting for the business to confirm"', async () => {
  await markPaid('TXN5512345');
  const { data } = await service.from('orders').select('status, ngo_payment_reference').eq('id', orderId).single();
  return data.status === 'payment_processing' && data.ngo_payment_reference === 'TXN5512345';
});
await shot('06-waiting-390');
let code;
await check('vendor confirms the money: pickup code and address appear live', async () => {
  const t0 = Date.now();
  await must(vendorU.client, 'vendor_confirm_payment', { p_order: orderId, p_received: true });
  await page.locator('.ngo-code .app-code__value').waitFor({ timeout: 20000 });
  console.log(`    (appeared after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  code = (await page.locator('.ngo-code .app-code__value').innerText()).trim();
  const { data } = await service.from('orders').select('pickup_code').eq('id', orderId).single();
  return /^\d{4}$/.test(code) && code === data.pickup_code;
});
await check('paid page: address, phone link, instructions, Google Maps link, collector and WhatsApp share', async () => {
  const where = await page.locator('.ngo-where').innerText();
  const tel = await page.locator('a[href^="tel:"]').getAttribute('href');
  const map = await page.getByRole('link', { name: /Open in Google Maps/ }).getAttribute('href');
  const wa = await page.getByRole('link', { name: /Send to collector/ }).getAttribute('href');
  const collector = await page.locator('.ngo-collector').innerText();
  const waText = decodeURIComponent(wa.split('text=')[1] || '');
  const res = where.includes('Shop 12, Street 3') && where.includes('Use the side door after 9 pm') && tel === 'tel:+923001234567'
    && map.includes('33.7215,73.0566') && wa.startsWith('https://wa.me/?text=') && waText.includes(code) && waText.includes('Shop 12, Street 3')
    && /\d{1,2}:\d\d [ap]m to \d{1,2}:\d\d [ap]m/.test(waText) && collector.includes('Ali Raza');
  if (!res) throw new Error(JSON.stringify({ where, tel, map, waText, collector }));
});
await check('no horizontal scroll on the pickup code page at 390px', noOverflow);
await shot('07-paid-390');
await check('vendor enters the code: page asks "Did you receive everything?" live', async () => {
  const r = await must(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: code, p_quantity: null });
  if (!r.ok) throw new Error(r.message);
  await page.locator('.ngo-received').waitFor({ timeout: 20000 });
});
await check('"Confirm we received it" completes the order', async () => {
  await page.getByRole('button', { name: 'Confirm we received it' }).click();
  await page.locator('.badge', { hasText: 'Completed' }).first().waitFor();
  const { data } = await service.from('orders').select('status').eq('id', orderId).single();
  return data.status === 'completed';
});
await check('the completed claim is under Done in My claims', async () => {
  await page.getByRole('link', { name: 'My claims' }).first().click();
  await page.locator('h1', { hasText: 'My claims' }).waitFor();
  await page.getByRole('tab', { name: /Done/ }).click();
  const row = page.locator('.ngo-claim-row', { hasText: T.naan });
  await row.waitFor();
  return (await row.getAttribute('href')) === '#/ngo/claims/' + orderId && (await row.innerText()).includes('Completed');
});
await check('no horizontal scroll on My claims at 390px', noOverflow);
await shot('08-claims-390');

console.log('\n7. Release before paying');
let releaseId;
await check('claim and release before paying', async () => {
  releaseId = await claimFromCard(T.rusk);
  await page.getByRole('button', { name: 'Release this claim' }).click();
  await dialogBox.locator('button[type=submit]').click();
  await page.locator('.badge', { hasText: 'Released' }).first().waitFor();
  const { data: o } = await service.from('orders').select('status').eq('id', releaseId).single();
  const { data: l } = await service.from('listings').select('status').eq('id', L.rusk).single();
  return o.status === 'released' && l.status === 'live';
});
await check('the released listing can be found again', async () => {
  await goto('/ngo');
  await cardFor(T.rusk).waitFor();
});

console.log('\n8. Server errors show inline');
await check('"just claimed" error appears under the claim button', async () => {
  await goto('/ngo/listings/' + L.gone);
  await page.locator('.ngo-claim-btn').waitFor();
  await must(ngo2U.client, 'claim_listing', { p_ngo: ngo2, p_listing: L.gone, p_collector: null });
  await page.locator('.ngo-claim-btn').click();
  await dialogBox.locator('button[type=submit]').click();
  const err = page.locator('.ngo-claim-error');
  await err.waitFor({ state: 'visible' });
  const t = await err.innerText();
  return /just claimed by another NGO/.test(t) && (await err.locator('a[href="#/ngo"]').count()) === 1;
});

console.log('\n9. Late cancellation warning');
let lateId;
await check('cancelling within 60 minutes of pickup warns that it counts as a no-show', async () => {
  lateId = await claimFromCard(T.late);
  await markPaid('LATE998877');
  await must(vendorU.client, 'vendor_confirm_payment', { p_order: lateId, p_received: true });
  await page.locator('.ngo-code').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Cancel claim' }).click();
  await dialogBox.waitFor();
  const t = await dialogBox.innerText();
  await page.screenshot({ path: `${SHOTS}/09-late-cancel-dialog-390.png` });
  return t.includes('Cancel this late?') && /counts as a no-show/.test(t) && /won't get a refund/.test(t);
});
await check('"Keep my claim" leaves it paid', async () => {
  await dialogBox.getByRole('button', { name: 'Keep my claim' }).click();
  await dialogBox.waitFor({ state: 'detached' });
  const { data } = await service.from('orders').select('status').eq('id', lateId).single();
  return data.status === 'paid';
});
await check('confirming the late cancel marks it not collected, shown under Problems', async () => {
  await page.getByRole('button', { name: 'Cancel claim' }).click();
  await dialogBox.getByRole('button', { name: 'Cancel without refund' }).click();
  await page.locator('.badge', { hasText: 'Not collected' }).first().waitFor();
  await goto('/ngo/claims');
  await page.getByRole('tab', { name: /Problems/ }).click();
  await page.locator('.ngo-claim-row', { hasText: T.late }).waitFor();
});

console.log('\n10. Refuse unsafe food and report a problem');
await check('refusing unsafe food at pickup', async () => {
  const id = await claimFromCard(T.unsafe);
  await markPaid('UNSAFE4455');
  await must(vendorU.client, 'vendor_confirm_payment', { p_order: id, p_received: true });
  await page.locator('.ngo-code').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Refuse unsafe food' }).click();
  await dialogBox.locator('textarea').fill('Sour smell and mould on two pieces');
  await dialogBox.getByRole('button', { name: 'Refuse food' }).click();
  await page.locator('.badge', { hasText: 'Refused at pickup' }).first().waitFor();
  const { data } = await service.from('orders').select('status').eq('id', id).single();
  return data.status === 'refused_at_pickup';
});
await check('report a problem on the completed claim opens the report', async () => {
  await goto('/ngo/claims/' + orderId);
  await page.getByRole('button', { name: 'Report a problem' }).click();
  await dialogBox.locator('select').selectOption('short_handover');
  await dialogBox.locator('textarea').fill('We received 30 pieces, not 40.');
  await dialogBox.getByRole('button', { name: 'Send report' }).click();
  await page.waitForURL(/#\/disputes\/[0-9a-f-]{36}$/);
  await page.locator('h1', { hasText: 'Problem report' }).waitFor();
});

console.log('\n11. Wide screen and console');
await page.setViewportSize({ width: 1280, height: 900 });
await goto('/ngo');
await cardFor(T.rusk).waitFor();
await check('no horizontal scroll on Find food at 1280px', noOverflow);
await shot('10-find-food-1280');
await goto('/ngo/claims/' + lateId);
await shot('11-claim-1280');
await check('no JavaScript errors in the console', async () => { if (consoleErrors.length) throw new Error(consoleErrors.join(' | ')); });

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('Failed:', failures.join('; '));
process.exit(failed ? 1 : 0);
