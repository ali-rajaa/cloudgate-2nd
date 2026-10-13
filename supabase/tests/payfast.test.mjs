// Tests the PayFast Edge Functions end to end against a local Supabase and a
// stand-in PayFast server (see README). Needs functions served with
// supabase/functions/.env where PAYFAST_SECURED_KEY=test-secured-key, PAYFAST_MERCHANT_ID=102.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY = process.env.PAYFAST_SECURED_KEY || 'test-secured-key', MERCHANT = process.env.PAYFAST_MERCHANT_ID || '102';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL, SERVICE, opts);
const run = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (c, n, x) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, x === undefined ? '' : JSON.stringify(x)); } };
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();
async function user(name) {
  const email = `${name}-${run}@test.rizq`;
  const { data } = await service.auth.admin.createUser({ email, password: 'Passw0rd!x', email_confirm: true });
  const client = createClient(URL, ANON, opts);
  const { data: s } = await client.auth.signInWithPassword({ email, password: 'Passw0rd!x' });
  return { id: data.user.id, client, token: s.session.access_token };
}
async function org(u, type, name) {
  const { data: id, error } = await u.client.rpc('create_organisation', { p_type: type, p_name: name });
  if (error) throw error;
  await service.from('organisations').update({ status: 'approved', tier: type === 'ngo' ? 'A' : null, phone: '+923001112222', address: 'Test', sector: 'F-7', lat: 33.72, lng: 73.05, bank_iban: 'PK36SCBL0000001123456702' }).eq('id', id);
  return id;
}

console.log('\nPayFast functions test');
await service.from('settings').update({ value: 'payfast' }).eq('key', 'payment_mode');
const vu = await user('pfv'), nu = await user('pfn'), other = await user('pfo');
const vendor = await org(vu, 'vendor', 'PF Bakery'), ngo = await org(nu, 'ngo', 'PF Kitchen'), ngo2 = await org(other, 'ngo', 'PF Other');
const { data: listing, error: le } = await vu.client.rpc('create_listing', {
  p_vendor: vendor, p_title: 'Bread for checkout', p_category: 'plain_bakery', p_quantity: 30, p_unit: 'pieces', p_weight_kg: 5,
  p_retail_value_rs: 3000, p_price_rs: 1500, p_storage: 'room', p_prepared_at: minutes(-30), p_safe_until: minutes(600),
  p_pickup_start: minutes(70), p_pickup_end: minutes(140) });
if (le) throw le;
const { data: order } = await nu.client.rpc('claim_listing', { p_ngo: ngo, p_listing: listing });

const call = (fn, token, body) => fetch(`${URL}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let res = await call('payfast-checkout', other.token, { order_id: order });
ok(res.status === 403, 'another NGO cannot start checkout for this order', res.status);
res = await call('payfast-checkout', nu.token, { order_id: order });
const co = await res.json();
ok(res.status === 200 && co.fields?.TOKEN?.startsWith('tok_') && co.fields.TXNAMT === '1500' && co.fields.BASKET_ID === order,
  'checkout returns a PayFast form with the token and the amount from our database', co);
ok(co.action?.endsWith('/Ecommerce/api/Transaction/PostTransaction'), 'form posts to PayFast\'s payment page');
const { data: o1 } = await nu.client.from('orders').select('status, held_until').eq('id', order).single();
ok(o1.status === 'payment_processing' && o1.held_until, 'food is held while the NGO pays', o1);

const ipn = (fields) => fetch(`${URL}/functions/v1/payfast-ipn`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
const hash = (basket, err) => createHash('sha256').update(`${basket}|${KEY}|${MERCHANT}|${err}`).digest('hex');
const base = { basket_id: order, transaction_id: 'TXN' + run, err_code: '000', err_msg: 'Success', transaction_amount: '1500', PaymentName: 'Raast' };

res = await ipn({ ...base, validation_hash: 'deadbeef' });
ok(res.status === 400, 'a notification with a wrong hash is rejected', res.status);
let { data: o2 } = await nu.client.from('orders').select('status').eq('id', order).single();
ok(o2.status === 'payment_processing', 'and the order is not marked paid');

res = await ipn({ ...base, transaction_id: 'TXN2' + run, validation_hash: hash(order, '000') });
const r1 = await res.json();
({ data: o2 } = await nu.client.from('orders').select('status').eq('id', order).single());
ok(res.status === 200 && r1.result === 'paid' && o2.status === 'paid', 'a correctly signed notification marks the order paid', { r1, o2 });
res = await ipn({ ...base, transaction_id: 'TXN2' + run, validation_hash: hash(order, '000') });
ok((await res.json()).result === 'duplicate', 'the same notification again changes nothing');
const { data: pays } = await service.from('payments').select('status, amount_rs, method').eq('order_id', order);
ok(pays.filter((p) => p.status === 'succeeded').length === 1 && pays[0].amount_rs === 1500, 'exactly one successful payment recorded', pays);

await service.from('settings').update({ value: 'direct' }).eq('key', 'payment_mode');
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
