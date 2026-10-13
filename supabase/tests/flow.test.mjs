// End-to-end test of the Rizq Rasan backend against a running Supabase
// (local: `supabase start`). It signs in as real users, so the access rules,
// functions and timers are exercised exactly as the app uses them.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node flow.test.mjs

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) { console.error('Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL, SERVICE, opts);
const anon = createClient(URL, ANON, opts);
const run = Date.now().toString(36);
let passed = 0, failed = 0;

function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function rpc(client, fn, args) { return client.rpc(fn, args); }
async function must(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
async function user(name) {
  const email = `${name}-${run}@test.rizq`;
  const { data, error } = await service.auth.admin.createUser({ email, password: 'Passw0rd!x', email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const client = createClient(URL, ANON, opts);
  const s = await client.auth.signInWithPassword({ email, password: 'Passw0rd!x' });
  if (s.error) throw s.error;
  return { id: data.user.id, client, email };
}
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();

async function setSetting(key, value) {
  const { error } = await service.from('settings').update({ value }).eq('key', key);
  if (error) throw error;
}

async function makeOrg(u, type, name, extra) {
  const org = await must(u.client, 'create_organisation', { p_type: type, p_name: name, p_business_kind: type === 'vendor' ? 'Bakery' : 'NGO', p_phone: '+923001234567' });
  await must(u.client, 'update_organisation', { p_org: org, p_fields: { address: 'Shop 12, Street 3', sector: 'F-7 Markaz', lat: 33.7215, lng: 73.0566, ntn: '1234567-8', ...extra } });
  const path = `${org}/registration-${run}.pdf`;
  const up = await u.client.storage.from('documents').upload(path, new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), { contentType: 'application/pdf' });
  if (up.error) throw new Error('upload: ' + up.error.message);
  await must(u.client, 'add_document', { p_org: org, p_kind: 'registration', p_path: path });
  await must(u.client, 'submit_for_review', { p_org: org });
  return org;
}

function listingArgs(vendor, over = {}) {
  return {
    p_vendor: vendor, p_title: 'Naan and sheermal, 40 pieces', p_category: 'tandoor_breads', p_quantity: 40, p_unit: 'pieces',
    p_weight_kg: 6, p_retail_value_rs: 2400, p_price_rs: 1200, p_storage: 'room', p_prepared_at: minutes(-60),
    p_safe_until: minutes(16 * 60), p_pickup_start: minutes(70), p_pickup_end: minutes(130),
    p_description: 'Fresh this evening', p_feeds_about: 14, p_dietary: { halal: 'vendor_declared', contains: ['gluten'] }, p_instructions: 'Ask at the counter',
    ...over,
  };
}

console.log('\nRizq Rasan backend test, run', run);

// ---------------------------------------------------------------------------
console.log('\n1. Accounts, onboarding and approval');
const admin1 = await user('admin1'), admin2 = await user('admin2');
await service.from('platform_admins').insert([{ user_id: admin1.id }, { user_id: admin2.id }]);
const vendorU = await user('vendor'), ngoU = await user('ngo'), ngo2U = await user('ngo2'), staffU = await user('stranger');
const vendor = await makeOrg(vendorU, 'vendor', 'Test Bakery F-7', { raast_id: '03001234567', bank_account_title: 'Test Bakery', bank_iban: 'PK36SCBL0000001123456702' });
const ngo = await makeOrg(ngoU, 'ngo', 'Test Kitchen G-9', { lat: 33.6938, lng: 73.0297, sector: 'G-9/4' });
const ngo2 = await makeOrg(ngo2U, 'ngo', 'Second Shelter', { lat: 33.7, lng: 73.04 });
let st = (await vendorU.client.from('organisations').select('status').eq('id', vendor).single()).data;
ok(st.status === 'pending_review', 'application submitted for review');
let r = await rpc(vendorU.client, 'create_listing', listingArgs(vendor));
ok(r.error && /not approved/.test(r.error.message), 'unapproved business cannot list food', r.error?.message);
r = await rpc(vendorU.client, 'admin_set_org_status', { p_org: vendor, p_status: 'approved' });
ok(!!r.error, 'a business cannot approve itself');
for (const o of [vendor, ngo, ngo2]) await must(admin1.client, 'admin_set_org_status', { p_org: o, p_status: 'approved' });
st = (await ngoU.client.from('organisations').select('status, tier').eq('id', ngo).single()).data;
ok(st.status === 'approved' && st.tier === 'C', 'admin approves; new NGOs start in Tier C', st);
for (const o of [ngo, ngo2]) await must(admin1.client, 'admin_set_org_status', { p_org: o, p_status: 'approved', p_tier: 'A' });
const notes = (await vendorU.client.from('notifications').select('title')).data.map((n) => n.title);
ok(notes.includes('Your account is approved'), 'business is notified of approval');

// ---------------------------------------------------------------------------
console.log('\n2. Privacy and access rules');
r = await ngoU.client.from('organisations').select('id').eq('id', vendor);
ok(r.data.length === 0, 'NGO cannot read the business\'s organisation record');
r = await vendorU.client.from('documents').select('id').eq('organisation_id', ngo);
ok(r.data.length === 0, 'business cannot see the NGO\'s documents');
r = await anon.from('organisations').select('id');
ok(r.error || r.data.length === 0, 'logged-out visitors see no organisations');
r = await ngoU.client.storage.from('documents').list(vendor);
ok((r.data || []).length === 0, 'NGO cannot list the business\'s document files');
r = await staffU.client.storage.from('documents').upload(`${vendor}/sneaky.pdf`, new Blob(['x'], { type: 'application/pdf' }), { contentType: 'application/pdf' });
ok(!!r.error, 'outsider cannot upload into a business\'s document folder');
r = await vendorU.client.from('listings').insert({ vendor_id: vendor, title: 'x', category_id: 'mithai', quantity: 1, weight_kg: 1, retail_value_rs: 9000, price_rs: 1000, prepared_at: minutes(0), safe_until: minutes(600), pickup_start: minutes(70), pickup_end: minutes(130) });
ok(!!r.error, 'listings cannot be inserted directly, only through the checked function');
const sign = await admin1.client.storage.from('documents').createSignedUrl(`${vendor}/registration-${run}.pdf`, 300);
ok(!sign.error && sign.data?.signedUrl, 'admin can open a document through a 5-minute link');

// ---------------------------------------------------------------------------
console.log('\n3. Listing rules');
const bad = [
  [{ p_price_rs: 900, p_retail_value_rs: 4000 }, /start at Rs 1,000/, 'price under Rs 1,000 is refused'],
  [{ p_price_rs: 1500, p_retail_value_rs: 2400 }, /at most half/, 'price over half of retail is refused'],
  [{ p_pickup_start: minutes(5), p_pickup_end: minutes(40) }, /at least 60 minutes/, 'pickup ending within 60 minutes is refused'],
  [{ p_pickup_start: minutes(70), p_pickup_end: minutes(85) }, /at least 30 minutes long/, 'pickup window under 30 minutes is refused'],
  [{ p_safe_until: minutes(30 * 60) }, /at most/, 'safe-until beyond the category limit is refused'],
  [{ p_category: 'curries', p_storage: 'hot', p_safe_until: minutes(150), p_pickup_end: minutes(115) }, /Cooked food can't be listed yet/, 'cooked food is refused until it opens'],
  [{ p_category: 'dairy' }, /can't be listed yet/, 'Phase 2 categories are refused'],
];
for (const [over, re, name] of bad) {
  r = await rpc(vendorU.client, 'create_listing', listingArgs(vendor, over));
  ok(r.error && re.test(r.error.message), name, r.error?.message);
}
const listing1 = await must(vendorU.client, 'create_listing', listingArgs(vendor));
ok(!!listing1, 'a valid listing goes live');
const photoPath = `${vendor}/${listing1}-1.jpg`;
r = await vendorU.client.storage.from('listing-photos').upload(photoPath, new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
ok(!r.error, 'business uploads a food photo', r.error?.message);
await must(vendorU.client, 'add_listing_photo', { p_listing: listing1, p_path: photoPath });

// ---------------------------------------------------------------------------
console.log('\n4. Finding and claiming food (direct payment mode)');
r = await rpc(anon, 'search_listings', { p_ngo: ngo });
ok(!!r.error, 'logged-out visitors cannot browse listings');
r = await ngoU.client.from('listings').select('id').eq('id', listing1);
ok(r.data.length === 0, 'NGOs cannot read the listings table directly');
const found = await must(ngoU.client, 'search_listings', { p_ngo: ngo, p_radius_km: 10 });
const hit = found.find((l) => l.id === listing1);
ok(hit && hit.can_claim && hit.distance_km > 0 && hit.photo_path === photoPath, 'NGO finds the listing with distance and photo', hit);
ok(hit && !('address' in hit), 'search results never include the business\'s address');
r = await rpc(vendorU.client, 'search_listings', { p_ngo: vendor });
ok(!!r.error, 'businesses cannot use NGO search');

// 20 claims at once on one listing: exactly one may win.
const ngos = [ngoU];
for (let i = 0; i < 19; i++) {
  const u = await user('race' + i);
  const o = await must(u.client, 'create_organisation', { p_type: 'ngo', p_name: 'Race NGO ' + i });
  await service.from('organisations').update({ status: 'approved', phone: '+923000000000', address: 'x', sector: 'G-9' }).eq('id', o);
  u.org = o; ngos.push(u);
}
ngoU.org = ngo;
const results = await Promise.all(ngos.map((u) => rpc(u.client, 'claim_listing', { p_ngo: u.org, p_listing: listing1 })));
const winners = results.filter((x) => !x.error);
ok(winners.length === 1, '20 simultaneous claims: exactly 1 succeeds', { winners: winners.length, sample: results.find((x) => x.error)?.error?.message });
const order1 = winners[0].data;
const winnerIdx = results.findIndex((x) => !x.error);
const winner = ngos[winnerIdx];
ok(results.filter((x) => x.error).every((x) => /just claimed|another NGO/.test(x.error.message)), 'losers are told it was just claimed');
{
  const tc = ngos.find((u, i) => i !== winnerIdx && i > 0);
  const extra = [];
  for (let i = 0; i < 3; i++) extra.push(await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Tier test ' + i, p_category: 'mithai' })));
  const a1 = await rpc(tc.client, 'claim_listing', { p_ngo: tc.org, p_listing: extra[0] });
  const a2 = await rpc(tc.client, 'claim_listing', { p_ngo: tc.org, p_listing: extra[1] });
  ok(!a1.error && a2.error && /unpaid claim/.test(a2.error.message), 'Tier C: only 1 unpaid claim at a time', a2.error?.message);
  await must(tc.client, 'release_claim', { p_order: a1.data });
  const a3 = await rpc(tc.client, 'claim_listing', { p_ngo: tc.org, p_listing: extra[1] });
  await must(tc.client, 'release_claim', { p_order: a3.data });
  const a4 = await rpc(tc.client, 'claim_listing', { p_ngo: tc.org, p_listing: extra[2] });
  ok(a4.error && /claims a day/.test(a4.error.message), 'Tier C: 2 claims a day', a4.error?.message);
  for (const id of extra) await rpc(vendorU.client, 'withdraw_listing', { p_listing: id });
}

let det = await must(winner.client, 'order_details', { p_order: order1 });
ok(det.status === 'payment_due' && det.pickup_code === null && det.vendor.address === null, 'before paying: no pickup code and no address', det);
r = await vendorU.client.from('orders').select('pickup_code').eq('id', order1);
ok(!!r.error, 'business can never read the pickup code column');
r = await winner.client.from('orders').update({ status: 'paid' }).eq('id', order1).select();
ok(r.error || r.data.length === 0, 'NGO cannot mark its own order paid by writing to the table');
r = await rpc(winner.client, 'vendor_confirm_payment', { p_order: order1 });
ok(!!r.error, 'NGO cannot confirm its own payment');
const payInfo = (await must(winner.client, 'direct_payment_details', { p_order: order1 }))[0];
ok(payInfo.amount_rs === 1200 && payInfo.raast_id === '03001234567', 'NGO sees the amount and the business\'s Raast ID', payInfo);
await must(winner.client, 'ngo_mark_paid', { p_order: order1, p_reference: 'RAAST123456' });
await must(vendorU.client, 'vendor_confirm_payment', { p_order: order1, p_received: true });
det = await must(winner.client, 'order_details', { p_order: order1 });
ok(det.status === 'paid' && /^\d{4}$/.test(det.pickup_code) && det.vendor.address, 'after the business confirms: code and address appear', { status: det.status, code: det.pickup_code });
const vdet = await must(vendorU.client, 'order_details', { p_order: order1 });
ok(vdet.pickup_code === null, 'business view of the order still has no code');
ok(det.commission_rs === 0 && det.vendor_share_rs === 1200, 'no commission in direct (pilot) mode', det);

// ---------------------------------------------------------------------------
console.log('\n5. Pickup code at the counter');
const wrong = det.pickup_code === '0000' ? '1111' : '0000';
let lastWrong;
for (let i = 0; i < 5; i++) lastWrong = await rpc(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: wrong });
ok(lastWrong.data && lastWrong.data.ok === false, 'a wrong code is rejected');
r = await rpc(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: det.pickup_code });
ok(r.error && /locked/.test(r.error.message), '5 wrong codes in 10 minutes lock entry', r.error?.message);
const newCode = await must(admin1.client, 'admin_reissue_code', { p_order: order1 });
det = await must(winner.client, 'order_details', { p_order: order1 });
ok(det.pickup_code === newCode, 'admin reissues the code and the NGO sees the new one');
r = await must(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: newCode, p_quantity: 40 });
ok(r.ok === true, 'right code hands the food over', r);
await must(winner.client, 'ngo_confirm_receipt', { p_order: order1 });
det = await must(winner.client, 'order_details', { p_order: order1 });
ok(det.status === 'completed', 'NGO confirms receipt: order completed');
const imp = await must(anon, 'impact_totals', {});
ok(imp.kg_rescued >= 6 && imp.meals >= 14, 'public impact totals come from completed orders', imp);

// ---------------------------------------------------------------------------
console.log('\n6. Gateway payments (PayFast mode)');
await setSetting('payment_mode', 'payfast');
const listing2 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Plain buns, 60', p_category: 'plain_bakery', p_price_rs: 2000, p_retail_value_rs: 5000 }));
const order2 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing2 });
det = await must(ngoU.client, 'order_details', { p_order: order2 });
ok(det.payment_mode === 'payfast' && det.commission_rs === 100 && det.vendor_share_rs === 1900, '5% commission rounded down in gateway mode', det);
r = await rpc(ngoU.client, 'record_gateway_payment', { p_order: order2, p_reference: 'x', p_amount: 2000, p_method: 'raast', p_event_id: 'e', p_body: {}, p_signature_valid: true, p_success: true });
ok(!!r.error, 'only the server can record a gateway payment');
const ev = `evt-${run}`;
r = await must(service, 'record_gateway_payment', { p_order: order2, p_reference: 'PF-1', p_amount: 1999, p_method: 'raast', p_event_id: ev + '-bad', p_body: {}, p_signature_valid: true, p_success: true });
ok(r === 'amount_mismatch', 'a payment for the wrong amount is not accepted', r);
r = await must(service, 'record_gateway_payment', { p_order: order2, p_reference: 'PF-2', p_amount: 2000, p_method: 'raast', p_event_id: ev + '-sig', p_body: {}, p_signature_valid: false, p_success: true });
ok(r === 'bad_signature', 'an unsigned notification is ignored', r);
r = await must(service, 'record_gateway_payment', { p_order: order2, p_reference: 'PF-3', p_amount: 2000, p_method: 'raast', p_event_id: ev, p_body: {}, p_signature_valid: true, p_success: true });
ok(r === 'paid', 'a valid notification marks the order paid', r);
r = await must(service, 'record_gateway_payment', { p_order: order2, p_reference: 'PF-3', p_amount: 2000, p_method: 'raast', p_event_id: ev, p_body: {}, p_signature_valid: true, p_success: true });
ok(r === 'duplicate', 'the same notification twice changes nothing', r);
det = await must(ngoU.client, 'order_details', { p_order: order2 });
await must(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: det.pickup_code });
await must(ngoU.client, 'ngo_confirm_receipt', { p_order: order2 });
const line = (await vendorU.client.from('payout_lines').select('*').eq('order_id', order2).single()).data;
ok(line && line.net_rs === 1900 && line.status === 'eligible', 'business\'s 95% becomes payable after completion', line);

// ---------------------------------------------------------------------------
console.log('\n7. Payout batch needs two admins');
const batch = await must(admin1.client, 'prepare_payout', { p_run_date: new Date().toISOString().slice(0, 10) });
r = await rpc(admin1.client, 'admin_approve_payout', { p_payout: batch });
ok(r.error && /different admin/.test(r.error.message), 'the admin who prepared a batch cannot approve it', r.error?.message);
await must(admin2.client, 'admin_approve_payout', { p_payout: batch });
await must(admin2.client, 'admin_mark_payout_sent', { p_payout: batch, p_references: { [vendor]: 'BANKREF-1' } });
const paidLine = (await vendorU.client.from('payout_lines').select('status, bank_reference').eq('order_id', order2).single()).data;
ok(paidLine.status === 'paid' && paidLine.bank_reference === 'BANKREF-1', 'payout recorded with the bank reference', paidLine);
r = await vendorU.client.from('ledger_entries').select('id');
ok(r.error || r.data.length === 0, 'businesses cannot read the ledger');

// ---------------------------------------------------------------------------
console.log('\n8. Cancellations, refunds and strikes');
// NGO cancels in good time: full refund, listing goes live again.
const listing3 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Mithai box', p_category: 'mithai', p_pickup_start: minutes(140), p_pickup_end: minutes(200) }));
const order3 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing3 });
await must(service, 'record_gateway_payment', { p_order: order3, p_reference: 'PF-4', p_amount: 1200, p_method: 'raast', p_event_id: ev + '-3', p_body: {}, p_signature_valid: true, p_success: true });
r = await must(ngoU.client, 'ngo_cancel_order', { p_order: order3 });
ok(r === 'cancelled_refunded', 'NGO cancels 60+ minutes before pickup: full refund', r);
const ref3 = (await ngoU.client.from('refunds').select('amount_rs').eq('order_id', order3)).data;
ok(ref3.length === 1 && ref3[0].amount_rs === 1200, 'refund of the full price recorded', ref3);
const l3 = (await vendorU.client.from('listings').select('status').eq('id', listing3).single()).data;
ok(l3.status === 'live', 'listing goes back on sale');

// Vendor cancels after payment: refund + vendor strike.
const order4 = await must(ngo2U.client, 'claim_listing', { p_ngo: ngo2, p_listing: listing3 });
await must(service, 'record_gateway_payment', { p_order: order4, p_reference: 'PF-5', p_amount: 1200, p_method: 'raast', p_event_id: ev + '-4', p_body: {}, p_signature_valid: true, p_success: true });
await must(vendorU.client, 'vendor_cancel_order', { p_order: order4, p_reason: 'Sold out' });
const strikes = (await vendorU.client.from('strikes').select('reason')).data;
ok(strikes.length === 1, 'business gets a strike for cancelling after payment', strikes);

// NGO cancels late: counts as a no-show.
const listing5 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Rusk packs', p_category: 'plain_bakery', p_pickup_start: minutes(20), p_pickup_end: minutes(90) }));
const order5 = await must(ngo2U.client, 'claim_listing', { p_ngo: ngo2, p_listing: listing5 });
await must(service, 'record_gateway_payment', { p_order: order5, p_reference: 'PF-6', p_amount: 1200, p_method: 'raast', p_event_id: ev + '-5', p_body: {}, p_signature_valid: true, p_success: true });
r = await must(ngo2U.client, 'ngo_cancel_order', { p_order: order5 });
ok(r === 'cancelled_no_refund', 'NGO cancelling within 60 minutes of pickup: no refund', r);
const s2 = (await ngo2U.client.from('strikes').select('id')).data;
ok(s2.length === 1, 'late cancellation gives the NGO a strike');

// ---------------------------------------------------------------------------
console.log('\n9. Automatic timers');
const listing6 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Fruit crate', p_category: 'fruit_veg', p_pickup_start: minutes(100), p_pickup_end: minutes(240) }));
const order6 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing6 });
await service.from('orders').update({ payment_deadline: minutes(-1) }).eq('id', order6);
const tick = await must(service, 'run_timers', {});
const o6 = (await ngoU.client.from('orders').select('status').eq('id', order6).single()).data;
const l6 = (await vendorU.client.from('listings').select('status').eq('id', listing6).single()).data;
ok(o6.status === 'expired_unpaid' && l6.status === 'live', 'unpaid claim expires and the food goes back on sale', { o6, l6, tick });
await service.from('listings').update({ pickup_end: minutes(-1), pickup_start: minutes(-40) }).eq('id', listing6);
await must(service, 'run_timers', {});
const l6b = (await vendorU.client.from('listings').select('status').eq('id', listing6).single()).data;
ok(l6b.status === 'expired', 'listing ends when its pickup window closes');

// Paid but never collected: vendor is asked, then says "not collected".
const listing7 = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Bread bags', p_category: 'plain_bakery' }));
const order7 = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: listing7 });
await must(service, 'record_gateway_payment', { p_order: order7, p_reference: 'PF-7', p_amount: 1200, p_method: 'raast', p_event_id: ev + '-7', p_body: {}, p_signature_valid: true, p_success: true });
await service.from('listings').update({ pickup_start: minutes(-90), pickup_end: minutes(-31) }).eq('id', listing7);
await must(service, 'run_timers', {});
let o7 = (await vendorU.client.from('orders').select('status').eq('id', order7).single()).data;
ok(o7.status === 'awaiting_collection_answer', '30 minutes after the window: business is asked "did they collect?"', o7);
await must(vendorU.client, 'vendor_answer_collection', { p_order: order7, p_collected: false });
o7 = (await vendorU.client.from('orders').select('status').eq('id', order7).single()).data;
const line7 = (await vendorU.client.from('payout_lines').select('net_rs').eq('order_id', order7)).data;
ok(o7.status === 'no_show' && line7.length === 1, 'no-show: business is still paid', { o7, line7 });

// Three unpaid expiries in 7 days pause claiming for 24 hours (not a strike).
const pauseNgoStrikesBefore = (await ngoU.client.from('strikes').select('id')).data.length;
for (let i = 0; i < 2; i++) {
  const li = await must(vendorU.client, 'create_listing', listingArgs(vendor, { p_title: 'Expiry test ' + i, p_category: 'mithai' }));
  const oi = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: li });
  await service.from('orders').update({ payment_deadline: minutes(-1) }).eq('id', oi);
  await must(service, 'run_timers', {});
}
const paused = (await ngoU.client.from('organisations').select('claims_paused_until').eq('id', ngo).single()).data;
ok(paused.claims_paused_until && new Date(paused.claims_paused_until) > new Date(), '3 unpaid expiries in 7 days pause claiming', paused);
ok((await ngoU.client.from('strikes').select('id')).data.length === pauseNgoStrikesBefore, 'the pause is not a strike');

// ---------------------------------------------------------------------------
console.log('\n10. Ledger stays balanced');
const { data: ledger } = await admin1.client.from('ledger_entries').select('txn_id, debit_rs, credit_rs');
const byTxn = {};
for (const e of ledger) { byTxn[e.txn_id] = (byTxn[e.txn_id] || 0) + e.debit_rs - e.credit_rs; }
ok(ledger.length > 0 && Object.values(byTxn).every((v) => v === 0), 'every ledger transaction has equal debits and credits', { txns: Object.keys(byTxn).length });
const audit = (await admin1.client.from('audit_log').select('action')).data.map((a) => a.action);
ok(audit.includes('set_org_status') && audit.includes('approve_payout'), 'admin actions are in the audit log');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
