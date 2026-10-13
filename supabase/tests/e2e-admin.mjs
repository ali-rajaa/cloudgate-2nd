// Browser test of the admin screens (assets/app/admin.js) against the local Supabase.
// It creates two admins, a business and an NGO with their own sign-ins, drives the
// business and NGO through the backend functions, and drives the admin screens in
// Chromium like a person would.
//
//   cd supabase/tests && SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... APP_URL=http://127.0.0.1:4023/app/ node e2e-admin.mjs
// (Keys are read from `supabase status` when not set.)

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

if (!process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const env = execSync('npx --yes supabase@2 status -o env', { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of env.split('\n')) {
    const m = /^(\w+)="?(.*?)"?$/.exec(line.trim());
    if (m && m[1] === 'ANON_KEY') process.env.SUPABASE_ANON_KEY = m[2];
    if (m && m[1] === 'SERVICE_ROLE_KEY') process.env.SUPABASE_SERVICE_ROLE_KEY = m[2];
  }
}
const URL_ = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.APP_URL || 'http://127.0.0.1:4023/app/';
const SHOTS = process.env.SHOTS_DIR || new URL('../../../../tmp/claude-0/-home-user/a3b53ec8-58ae-5e8d-ac3b-c3e65a0793c6/scratchpad/shots-admin/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL_, SERVICE, opts);
const run = Date.now().toString(36);
const PASSWORD = 'Passw0rd!x';
let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function must(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
async function one(q) { const { data, error } = await q; if (error) throw new Error(error.message); return data; }
async function waitFor(fn, name, ms = 8000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise((r) => setTimeout(r, 200)); }
  return last;
}
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();

async function user(name, fullName) {
  const email = `${name}-${run}@test.rizq`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error) throw error;
  const client = createClient(URL_, ANON, opts);
  const s = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (s.error) throw s.error;
  return { id: data.user.id, client, email };
}
const pdf = (label) => new Blob([`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`], { type: 'application/pdf' });
async function upload(u, org, kind) {
  const path = `${org}/${kind}-${run}-${Math.random().toString(36).slice(2, 6)}.pdf`;
  const up = await u.client.storage.from('documents').upload(path, pdf(kind), { contentType: 'application/pdf' });
  if (up.error) throw new Error('upload: ' + up.error.message);
  return must(u.client, 'add_document', { p_org: org, p_kind: kind, p_path: path });
}
async function apply(u, type, name, fields, kinds) {
  const org = await must(u.client, 'create_organisation', { p_type: type, p_name: name, p_business_kind: type === 'vendor' ? 'Bakery' : 'Community kitchen', p_phone: '+923001234567' });
  await must(u.client, 'accept_policies', { p_org: org, p_policies: ['terms', 'privacy'], p_version: '0.1' });
  await must(u.client, 'update_organisation', { p_org: org, p_fields: { address: 'Shop 12, Street 3', sector: 'F-7 Markaz', lat: 33.7215, lng: 73.0566, ...fields } });
  for (const k of kinds) await upload(u, org, k);
  await must(u.client, 'submit_for_review', { p_org: org });
  return org;
}
function listingArgs(vendor, title, price, retail, category = 'tandoor_breads') {
  return {
    p_vendor: vendor, p_title: title, p_category: category, p_quantity: 40, p_unit: 'pieces', p_weight_kg: 6, p_retail_value_rs: retail, p_price_rs: price,
    p_storage: 'room', p_prepared_at: minutes(-60), p_safe_until: minutes(16 * 60), p_pickup_start: minutes(70), p_pickup_end: minutes(130),
    p_description: 'Fresh this evening', p_feeds_about: 14, p_dietary: { halal: 'vendor_declared' }, p_instructions: 'Ask at the counter',
  };
}
let ev = 0;
const pay = (order, amount) => must(service, 'record_gateway_payment', { p_order: order, p_reference: `PF-${run}-${++ev}`, p_amount: amount, p_method: 'raast',
  p_event_id: `adm-${run}-${ev}`, p_body: { basket_id: order, transaction_amount: String(amount) }, p_signature_valid: true, p_success: true });

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const consoleErrors = [];
async function openAs(u, label, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${label}] ${m.text()} @ ${page.url()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror ${e.message} @ ${page.url()}`));
  await page.goto(APP + '#/login');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/#\/admin$/);
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  return page;
}
async function visit(page, hash, heading) {
  await page.goto(APP + '#' + hash);
  if (heading) await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
  await page.waitForSelector('.app-loading', { state: 'detached' }).catch(() => {});
}
const dlg = (page) => page.locator('dialog.app-dialog[open]');
async function toast(page, re) {
  const t = page.locator('.app-toast', { hasText: re }).first();
  await t.waitFor({ timeout: 8000 });
  return t.textContent();
}
async function noOverflow(page) { return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); }
async function shot(page, name) { await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true }); }

let exitCode = 0;
let savedMode;
try {
  console.log('\nAdmin screens e2e, run', run);

  // -------------------------------------------------------------------------
  console.log('\n1. Setup: two admins, a business and an NGO apply');
  const admin1 = await user('admin1', 'Amina Admin'), admin2 = await user('admin2', 'Bilal Admin');
  { const { error } = await service.from('platform_admins').insert([{ user_id: admin1.id }, { user_id: admin2.id }]); if (error) throw error; }
  const vendorU = await user('vendor', 'Vera Vendor'), ngoU = await user('ngo', 'Nadia Khan');
  const vendorName = `Admin Test Bakery ${run}`, ngoName = `Admin Test Kitchen ${run}`;
  const vendor = await apply(vendorU, 'vendor', vendorName, { ntn: '1234567-8', raast_id: '03001234567', bank_account_title: 'Admin Test Bakery', bank_iban: 'PK36SCBL0000001123456702', pickup_instructions: 'Back counter' },
    ['registration', 'ntn', 'ifa_licence', 'signatory_cnic', 'bank_letter']);
  const ngo = await apply(ngoU, 'ngo', ngoName, { people_served_per_day: 120, registration_number: 'ICT-123' }, ['registration', 'authority_letter', 'signatory_cnic']);
  ok(true, 'business and NGO submitted applications with documents');

  // -------------------------------------------------------------------------
  console.log('\n2. Admin 1 reviews the NGO (phone size)');
  const p1 = await openAs(admin1, 'admin1', { width: 390, height: 844 });
  const appsTile = p1.locator('a.adm-queue', { hasText: 'Applications waiting for review' });
  ok(Number(await appsTile.locator('.adm-queue__value').textContent()) >= 2, 'overview counts applications waiting for review');
  ok(await p1.locator('a.adm-queue', { hasText: 'Food safety reports' }).count() === 1 && await p1.locator('a.adm-queue', { hasText: 'Payment amount mismatches' }).count() === 1
    && await p1.locator('a.adm-queue', { hasText: 'Refunds needing a second admin' }).count() === 1, 'overview shows the money and safety queues');
  ok(await p1.getByText('Food rescued').count() === 1, 'overview shows impact totals');
  ok(await noOverflow(p1), 'overview has no horizontal scroll at 390px');
  await shot(p1, '01-overview-390');
  await appsTile.click();
  await p1.getByRole('heading', { name: 'Verifications' }).waitFor();
  await p1.locator('a.adm-row', { hasText: ngoName }).waitFor();
  ok(await p1.locator('a.adm-row', { hasText: vendorName }).count() === 1, 'verification queue lists both applications');
  ok(await noOverflow(p1), 'verifications has no horizontal scroll at 390px');
  await shot(p1, '02-verifications-390');
  await p1.locator('a.adm-row', { hasText: ngoName }).click();
  await p1.getByRole('heading', { name: ngoName }).waitFor();
  ok(await p1.getByText('Nadia Khan').count() >= 1, 'organisation page shows its members');
  ok(await p1.locator('li.app-doc').count() === 3, 'organisation page lists the three documents');
  ok(await p1.getByText('ICT-123').count() === 1, 'organisation page shows the details');

  const regDoc = p1.locator('li.app-doc', { hasText: 'Registration certificate' });
  const [popup] = await Promise.all([p1.waitForEvent('popup'), regDoc.getByRole('button', { name: 'View' }).click()]);
  await popup.waitForURL(/\/storage\/v1\/object\/sign\/documents\//, { timeout: 8000 }).catch(() => {});
  const signed = popup.url();
  ok(/\/object\/sign\/documents\/.+token=/.test(signed), 'View opens a signed document link in a new tab', signed);
  const fileRes = await fetch(signed);
  ok(fileRes.status === 200 && (await fileRes.text()).startsWith('%PDF'), 'the signed link serves the file');
  const token = JSON.parse(Buffer.from(new URL(signed).searchParams.get('token').split('.')[1], 'base64url').toString());
  ok(token.exp - token.iat === 300, 'the link expires after 5 minutes', token);
  await popup.close();

  await regDoc.getByRole('button', { name: 'Approve' }).click();
  await toast(p1, /Document checked/);
  const regRow = await one(service.from('documents').select('status, reviewed_by').eq('organisation_id', ngo).eq('kind', 'registration').single());
  ok(regRow.status === 'approved' && regRow.reviewed_by === admin1.id, 'document approved by admin 1', regRow);

  await p1.locator('.adm-actions').getByRole('button', { name: 'Approve', exact: true }).click();
  const tierSelect = dlg(p1).locator('select');
  ok(await tierSelect.inputValue() === 'C', 'tier defaults to C');
  await tierSelect.selectOption('B');
  await dlg(p1).getByRole('button', { name: 'Approve' }).click();
  await toast(p1, /Approved/);
  let o = await one(service.from('organisations').select('status, tier').eq('id', ngo).single());
  ok(o.status === 'approved' && o.tier === 'B', 'NGO approved in Tier B', o);
  await p1.getByRole('button', { name: 'Suspend' }).waitFor();
  ok(await p1.getByRole('button', { name: 'Change tier' }).count() === 1, 'approved NGO offers Suspend and Change tier');
  ok(await noOverflow(p1), 'organisation page has no horizontal scroll at 390px');
  await shot(p1, '03-organisation-ngo-390');

  // -------------------------------------------------------------------------
  console.log('\n3. Admin 1 asks the business for changes, then approves');
  await visit(p1, '/admin/verifications', 'Verifications');
  await p1.locator('a.adm-row', { hasText: vendorName }).click();
  await p1.getByRole('heading', { name: vendorName }).waitFor();
  ok(await p1.getByText('PK36 SCBL 0000 0011 2345 6702').count() === 1, 'business IBAN shown in groups of four');
  await p1.locator('li.app-doc', { hasText: 'NTN certificate' }).getByRole('button', { name: 'Needs a new file' }).click();
  await dlg(p1).locator('textarea').fill('The certificate is cut off at the bottom. Upload the full page.');
  await dlg(p1).getByRole('button', { name: 'Ask for a new file' }).click();
  await toast(p1, /new file/);
  const ntnDoc = await one(service.from('documents').select('status, reason').eq('organisation_id', vendor).eq('kind', 'ntn').single());
  ok(ntnDoc.status === 'rejected' && /cut off/.test(ntnDoc.reason), 'document marked as needing a new file, with the reason', ntnDoc);

  await p1.locator('.adm-actions').getByRole('button', { name: 'Needs changes' }).click();
  await dlg(p1).getByRole('button', { name: 'Send back' }).click();
  ok(await dlg(p1).getByText('This is needed.').count() === 1, 'a reason is required to ask for changes');
  await dlg(p1).locator('textarea').fill('Please upload a clear copy of your NTN certificate.');
  await dlg(p1).getByRole('button', { name: 'Send back' }).click();
  await toast(p1, /Sent back for changes/);
  o = await one(service.from('organisations').select('status, status_reason').eq('id', vendor).single());
  ok(o.status === 'needs_changes' && /NTN/.test(o.status_reason), 'business sent back for changes with the reason', o);
  const vNote = await one(vendorU.client.from('notifications').select('title, body').eq('title', 'Your application needs changes'));
  ok(vNote.length === 1 && /NTN/.test(vNote[0].body), 'business is told what to fix');

  await upload(vendorU, vendor, 'ntn');
  await must(vendorU.client, 'submit_for_review', { p_org: vendor });
  await p1.reload();
  await p1.getByRole('heading', { name: vendorName }).waitFor();
  ok(await p1.locator('.app-page-head .badge').textContent() === 'Waiting for review', 'resubmitted application is waiting for review again');
  ok(await p1.locator('li.app-doc', { hasText: 'NTN certificate' }).count() === 2, 'the new file shows beside the old one');
  await p1.locator('.adm-actions').getByRole('button', { name: 'Approve', exact: true }).click();
  ok(await dlg(p1).locator('select').count() === 0, 'businesses are approved without a tier');
  await dlg(p1).getByRole('button', { name: 'Approve' }).click();
  await toast(p1, /Approved/);
  o = await one(service.from('organisations').select('status, tier').eq('id', vendor).single());
  ok(o.status === 'approved' && o.tier === null, 'business approved', o);
  await visit(p1, '/admin/verifications', 'Verifications');
  await p1.waitForTimeout(300);
  ok(await p1.locator('a.adm-row', { hasText: run }).count() === 0, 'approved applications leave the queue');

  // -------------------------------------------------------------------------
  console.log('\n4. Orders in gateway mode (business and NGO use their own functions)');
  savedMode = (await one(service.from('settings').select('value').eq('key', 'payment_mode').single())).value;
  await service.from('settings').update({ value: 'payfast' }).eq('key', 'payment_mode');
  const lA = await must(vendorU.client, 'create_listing', listingArgs(vendor, `Naan batch A ${run}`, 1200, 2400));
  const lB = await must(vendorU.client, 'create_listing', listingArgs(vendor, `Wedding cake trays ${run}`, 12000, 24000, 'plain_bakery'));
  const lC = await must(vendorU.client, 'create_listing', listingArgs(vendor, `Rusk boxes ${run}`, 1000, 2000, 'plain_bakery'));
  const lD = await must(vendorU.client, 'create_listing', listingArgs(vendor, `Sheermal ${run}`, 1000, 2000));
  const orderA = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: lA });
  ok(await pay(orderA, 1200) === 'paid', 'order A paid through the gateway');
  const orderB = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: lB });
  ok(await pay(orderB, 12000) === 'paid', 'order B (Rs 12,000) paid');
  const orderC = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: lC });
  ok(await pay(orderC, 1000) === 'paid', 'order C paid');
  const orderD = await must(ngoU.client, 'claim_listing', { p_ngo: ngo, p_listing: lD });
  await service.from('settings').update({ value: savedMode }).eq('key', 'payment_mode'); savedMode = undefined;
  await must(ngoU.client, 'release_claim', { p_order: orderD });
  const codeA = (await must(ngoU.client, 'order_details', { p_order: orderA })).pickup_code;
  const handed = await must(vendorU.client, 'verify_pickup_code', { p_vendor: vendor, p_code: codeA });
  ok(handed.ok && handed.order_id === orderA, 'order A handed over with the pickup code');
  const disputeId = await must(ngoU.client, 'report_problem', { p_order: orderA, p_kind: 'food_safety', p_details: 'The naan smelled sour and several pieces had mould on them.' });
  await must(vendorU.client, 'reply_to_problem', { p_dispute: disputeId, p_reply: 'The bread was baked at 6 pm and was fresh when we handed it over.' });
  ok(true, 'NGO reported a food safety problem and the business replied');

  // -------------------------------------------------------------------------
  console.log('\n5. Admin 1 decides the problem with a refund and a strike');
  await visit(p1, '/admin', 'Overview');
  ok(Number(await p1.locator('a.adm-queue', { hasText: 'Food safety reports' }).locator('.adm-queue__value').textContent()) >= 1, 'overview counts the food safety report');
  await p1.locator('a.adm-queue', { hasText: 'Food safety reports' }).click();
  await p1.getByRole('heading', { name: 'Problems' }).waitFor();
  const dRow = p1.locator('a.adm-row', { hasText: `Naan batch A ${run}` });
  await dRow.waitFor();
  ok(await dRow.evaluate((el) => el.classList.contains('adm-row--alert')), 'food safety report is highlighted');
  ok(/24-hour target/.test(await dRow.textContent()), 'food safety report shows the 24-hour target');
  ok(await noOverflow(p1), 'problems list has no horizontal scroll at 390px');
  await shot(p1, '04-disputes-390');
  await dRow.click();
  await p1.getByRole('heading', { name: 'Food safety' }).waitFor();
  ok(await p1.getByText('several pieces had mould').count() === 1 && await p1.getByText('baked at 6 pm').count() === 1, 'both sides\' accounts are shown');
  ok(await p1.locator('.adm-target--alert').count() === 1, 'decision target is shown as urgent');
  await p1.getByLabel('Decision').fill('Upheld. The photos show mould. The business refunds part of the price and gets a strike.');
  await p1.getByLabel('Refund to the NGO (Rs)').fill('1300');
  await p1.getByRole('button', { name: 'Record decision' }).click();
  ok(await p1.getByText('The refund can be at most Rs 1,200.').count() === 1, 'refund cannot be more than the price');
  await p1.getByLabel('Refund to the NGO (Rs)').fill('400');
  await p1.getByLabel('Strike').selectOption({ label: `Strike for ${vendorName} (business)` });
  await shot(p1, '05-dispute-form-390');
  await p1.getByRole('button', { name: 'Record decision' }).click();
  ok(/Refund Rs 400/.test(await dlg(p1).textContent()), 'confirmation repeats the refund');
  await dlg(p1).getByRole('button', { name: 'Record decision' }).click();
  await toast(p1, /Decision recorded/);
  const dRec = await one(service.from('disputes').select('status, refund_rs, strike_org, decided_by').eq('id', disputeId).single());
  ok(dRec.status === 'decided' && dRec.refund_rs === 400 && dRec.strike_org === vendor && dRec.decided_by === admin1.id, 'decision recorded', dRec);
  const refA = await one(service.from('refunds').select('amount_rs, status').eq('order_id', orderA));
  ok(refA.length === 1 && refA[0].amount_rs === 400 && refA[0].status === 'approved', 'Rs 400 refund created', refA);
  const lineA = await one(service.from('payout_lines').select('status, net_rs').eq('order_id', orderA).single());
  ok(lineA.status === 'eligible' && lineA.net_rs === 760, 'order completed; payout line is Rs 1,140 less the Rs 380 vendor share of the refund', lineA);
  await p1.getByRole('heading', { name: 'Decision' }).waitFor();
  ok(await p1.getByText('Rs 400').count() >= 1, 'decided report shows the refund');

  // Forgive the strike on the business's page.
  await visit(p1, '/admin/organisations/' + vendor, vendorName);
  const strikeRow = p1.locator('li.adm-row', { hasText: 'Upheld problem report' });
  ok(await strikeRow.getByText('Active').count() === 1, 'business page shows the active strike');
  ok(await p1.getByText('Reliability (of 100)').count() === 1, 'business page shows the reliability score');
  ok(await p1.locator('a.adm-row', { hasText: `Naan batch A ${run}` }).count() === 1, 'business page lists recent orders');
  await strikeRow.getByRole('button', { name: 'Forgive' }).click();
  await dlg(p1).getByRole('button', { name: 'Forgive strike' }).click();
  await toast(p1, /Strike forgiven/);
  const strike = await one(service.from('strikes').select('forgiven_by').eq('organisation_id', vendor).single());
  ok(strike.forgiven_by === admin1.id, 'strike forgiven', strike);

  // -------------------------------------------------------------------------
  console.log('\n6. Admin 1 works on orders');
  await visit(p1, '/admin/orders?status=paid', 'Orders');
  const cRow = p1.locator('a.adm-row', { hasText: `Rusk boxes ${run}` });
  await cRow.waitFor();
  ok(await p1.locator('a.adm-row', { hasText: `Naan batch A ${run}` }).count() === 0, 'status filter shows only paid orders');
  ok(await noOverflow(p1), 'orders list has no horizontal scroll at 390px');
  await cRow.click();
  await p1.getByRole('heading', { name: `Rusk boxes ${run}` }).waitFor();
  const shownCode = (await p1.locator('.app-code__value').textContent()).trim();
  const codeC = (await must(ngoU.client, 'order_details', { p_order: orderC })).pickup_code;
  ok(shownCode === codeC, 'admin sees the pickup code');
  ok(await p1.locator('.adm-timeline li').count() >= 3, 'order timeline shows claim, payment and paid');
  ok(await noOverflow(p1), 'order page has no horizontal scroll at 390px');
  await shot(p1, '06-order-390');
  await p1.getByRole('button', { name: 'Reissue pickup code' }).click();
  await dlg(p1).getByRole('button', { name: 'Reissue code' }).click();
  const newCodeText = await toast(p1, /New pickup code/);
  const codeC2 = (await must(ngoU.client, 'order_details', { p_order: orderC })).pickup_code;
  ok(codeC2 !== codeC && newCodeText.includes(codeC2), 'pickup code reissued and shown', { codeC, codeC2, newCodeText });

  await visit(p1, '/admin/orders/' + orderD, `Sheermal ${run}`);
  ok(await p1.getByRole('button', { name: /Cancel/ }).count() === 0, 'released order has no cancel action');
  await p1.getByRole('button', { name: 'Remove listing' }).click();
  await dlg(p1).locator('textarea').fill('Photos show a different product.');
  await dlg(p1).getByRole('button', { name: 'Remove listing' }).click();
  await toast(p1, /Listing removed/);
  const lDrow = await one(service.from('listings').select('status, status_reason').eq('id', lD).single());
  ok(lDrow.status === 'removed' && /different product/.test(lDrow.status_reason), 'live listing removed', lDrow);

  await visit(p1, '/admin/orders/' + orderB, `Wedding cake trays ${run}`);
  await p1.getByRole('button', { name: 'Cancel and refund Rs 12,000' }).click();
  await dlg(p1).locator('textarea').fill('The business cannot supply this order.');
  await dlg(p1).getByRole('button', { name: 'Cancel and refund' }).click();
  await toast(p1, /Order cancelled/);
  const oB = await one(service.from('orders').select('status').eq('id', orderB).single());
  const refB = (await one(service.from('refunds').select('id, amount_rs, status, requested_by').eq('order_id', orderB)))[0];
  ok(oB.status === 'cancelled_by_vendor' && refB?.amount_rs === 12000 && refB.status === 'pending_approval' && refB.requested_by === admin1.id,
    'order cancelled with a Rs 12,000 refund waiting for a second admin', { oB, refB });

  await visit(p1, '/admin/payments', 'Payments');
  const refRow1 = p1.locator(`li[data-refund="${refB.id}"]`);
  await refRow1.waitFor();
  ok(await refRow1.getByRole('button', { name: 'Approve refund' }).isDisabled(), 'admin 1 cannot approve a refund they asked for');
  ok(await refRow1.getByText('a different admin must approve it').count() === 1, 'and is told why');
  ok(await noOverflow(p1), 'payments has no horizontal scroll at 390px');
  await shot(p1, '07-payments-390');

  // -------------------------------------------------------------------------
  console.log('\n7. Admin 1 prepares a payout batch but cannot approve it');
  await visit(p1, '/admin/payouts', 'Payouts');
  const runDate = new Date(Date.UTC(2031, 0, 1) + (parseInt(run, 36) % 9000) * 86400000).toISOString().slice(0, 10);
  await p1.getByRole('button', { name: 'Prepare batch now' }).click();
  ok(/^\d{4}-\d{2}-\d{2}$/.test(await dlg(p1).locator('input[type=date]').inputValue()), 'batch date defaults to a date');
  await dlg(p1).locator('input[type=date]').fill(runDate);
  await dlg(p1).getByRole('button', { name: 'Prepare batch' }).click();
  await p1.waitForURL(/#\/admin\/payouts\/[0-9a-f-]{36}$/);
  const batchId = p1.url().split('/').pop();
  const batch = await one(service.from('payouts').select('prepared_by, status, run_date, total_rs').eq('id', batchId).single());
  ok(batch.prepared_by === admin1.id && batch.status === 'draft' && batch.run_date === runDate, 'draft batch prepared by admin 1', batch);
  const myLine = await one(service.from('payout_lines').select('payout_id, status').eq('order_id', orderA).single());
  ok(myLine.payout_id === batchId && myLine.status === 'in_batch', 'the business\'s line is in the batch', myLine);
  const vCard = p1.locator(`article[data-vendor="${vendor}"]`);
  await vCard.waitFor();
  ok(/PK36 SCBL 0000 0011 2345 6702/.test(await vCard.textContent()) && /Admin Test Bakery/.test(await vCard.textContent()), 'batch shows the business\'s IBAN and account title');
  ok(/Rs 760/.test(await vCard.textContent()), 'batch shows the business\'s total');
  const approve1 = p1.getByRole('button', { name: /^Approve Rs/ });
  ok(await approve1.isDisabled(), 'admin 1 cannot approve their own batch');
  ok(await p1.getByText('You prepared this batch, so a different admin must approve it.').count() === 1, 'the screen explains a different admin must approve');
  const selfApprove = await admin1.client.rpc('admin_approve_payout', { p_payout: batchId });
  ok(/different admin/.test(selfApprove.error?.message || ''), 'the database refuses it too', selfApprove.error?.message);
  ok(await noOverflow(p1), 'payout batch has no horizontal scroll at 390px');
  await shot(p1, '08-payout-draft-390');

  // -------------------------------------------------------------------------
  console.log('\n8. Admin 2 approves and records the payout (desktop size)');
  const p2 = await openAs(admin2, 'admin2', { width: 1280, height: 900 });
  await shot(p2, '09-overview-1280');
  await visit(p2, '/admin/payouts/' + batchId);
  const approve2 = p2.getByRole('button', { name: /^Approve Rs/ });
  await approve2.waitFor();
  ok(!(await approve2.isDisabled()), 'admin 2 can approve the batch');
  await approve2.click();
  await dlg(p2).getByRole('button', { name: 'Approve batch' }).click();
  await toast(p2, /Batch approved/);
  const approved = await one(service.from('payouts').select('status, approved_by').eq('id', batchId).single());
  ok(approved.status === 'approved' && approved.approved_by === admin2.id, 'batch approved by admin 2', approved);
  await p2.getByRole('button', { name: 'Record payout' }).waitFor();
  const refInputs = p2.locator('.adm-send input');
  const n = await refInputs.count();
  ok(n >= 1, 'one bank reference field per business', n);
  await p2.getByRole('button', { name: 'Record payout' }).click();
  ok(await p2.getByText('Enter the bank reference.').count() >= 1, 'bank references are required');
  for (let i = 0; i < n; i++) await refInputs.nth(i).fill(`BANK-${run}-${i}`);
  await p2.getByLabel(`Bank reference for ${vendorName}`).fill(`HBL-${run}`);
  await shot(p2, '10-payout-send-1280');
  await p2.getByRole('button', { name: 'Record payout' }).click();
  await toast(p2, /Payout recorded/);
  const sent = await one(service.from('payouts').select('status, sent_at').eq('id', batchId).single());
  const paidLine = await one(service.from('payout_lines').select('status, bank_reference').eq('order_id', orderA).single());
  ok(sent.status === 'sent' && paidLine.status === 'paid' && paidLine.bank_reference === `HBL-${run}`, 'payout recorded with the business\'s bank reference', { sent, paidLine });
  await p2.locator('.app-page-head .badge', { hasText: 'Sent' }).waitFor();

  // Refund approval by the second admin.
  await visit(p2, '/admin/payments', 'Payments');
  const refRow2 = p2.locator(`li[data-refund="${refB.id}"]`);
  await refRow2.getByRole('button', { name: 'Approve refund' }).click();
  await dlg(p2).getByRole('button', { name: 'Approve refund' }).click();
  await toast(p2, /Refund approved/);
  let rB = await one(service.from('refunds').select('status, approved_by').eq('id', refB.id).single());
  ok(rB.status === 'approved' && rB.approved_by === admin2.id, 'admin 2 approves the refund', rB);
  await p2.locator(`li[data-refund="${refB.id}"]`).getByRole('button', { name: 'Mark sent' }).click();
  await dlg(p2).getByLabel('Reference').fill(`RAAST-${run}`);
  await dlg(p2).getByRole('button', { name: 'Mark sent' }).click();
  await toast(p2, /marked as sent/);
  rB = await one(service.from('refunds').select('status, gateway_reference').eq('id', refB.id).single());
  ok(rB.status === 'sent' && rB.gateway_reference === `RAAST-${run}`, 'refund marked sent with its reference', rB);
  await p2.getByRole('tab', { name: /Mismatches/ }).click();
  await p2.getByText(/PayFast told us an amount/).waitFor();
  ok(true, 'mismatches tab opens');
  await p2.getByRole('tab', { name: /^Payments/ }).click();
  await p2.locator('a.adm-row', { hasText: `Rusk boxes ${run}` }).waitFor();
  ok(true, 'payments tab lists gateway payments');

  // -------------------------------------------------------------------------
  console.log('\n9. Settings and the audit log');
  await visit(p2, '/admin/settings', 'Settings');
  const strikeSetting = p2.locator('article[data-key="strike_expiry_days"]');
  const before = await strikeSetting.locator('input').inputValue();
  const changedTo = String(Number(before) + 1);
  ok(await p2.locator('article[data-key="payment_mode"] input[type=radio]').count() === 2, 'payment mode is a two-option choice');
  ok(await p2.locator('article[data-key="payment_mode"] .notice--warning').count() === 1, 'payment mode carries a warning');
  ok(await p2.locator('article[data-key="cooked_food_open"] input[role=switch]').count() === 1, 'yes/no settings are toggles');
  ok(await p2.locator('article[data-key="tier_limits"] textarea').count() === 1, 'JSON settings are edited as text');
  ok(await p2.getByText('Tandoor breads (naan, roti, paratha, sheermal)').count() === 1, 'categories are listed read-only');
  await p2.locator('article[data-key="tier_limits"] textarea').fill('{ "A": ');
  await p2.locator('article[data-key="tier_limits"]').getByRole('button', { name: 'Save' }).click();
  ok(await p2.getByText('This isn\'t valid JSON').count() === 1, 'invalid JSON is caught before saving');
  await strikeSetting.locator('input').fill(changedTo);
  await strikeSetting.getByRole('button', { name: 'Save' }).click();
  await toast(p2, /Strike expiry days saved/);
  const sv = await one(service.from('settings').select('value, updated_by').eq('key', 'strike_expiry_days').single());
  ok(String(sv.value) === changedTo && sv.updated_by === admin2.id, 'setting saved by admin 2', sv);
  await shot(p2, '11-settings-1280');
  await visit(p2, '/admin/audit', 'Audit log');
  const auditRow = p2.locator('li[data-action="update_setting"]', { hasText: 'strike_expiry_days' }).first();
  await auditRow.waitFor();
  ok(/Bilal Admin/.test(await auditRow.textContent()) && (await auditRow.textContent()).includes(changedTo), 'the change is in the audit log with who made it');
  ok(await p2.locator('li[data-action="approve_payout"]').count() >= 1 && await p2.locator('li[data-action="set_org_status"]').count() >= 1, 'audit log also has approvals and payouts');
  await shot(p2, '12-audit-1280');
  // Put the setting back, through the screen.
  await visit(p2, '/admin/settings', 'Settings');
  await p2.locator('article[data-key="strike_expiry_days"] input').fill(before);
  await p2.locator('article[data-key="strike_expiry_days"]').getByRole('button', { name: 'Save' }).click();
  await toast(p2, /Strike expiry days saved/);
  ok(String((await one(service.from('settings').select('value').eq('key', 'strike_expiry_days').single())).value) === before, 'setting put back');

  // Organisation search.
  await visit(p2, '/admin/organisations', 'Organisations');
  await p2.getByLabel('Search by name').fill(`Kitchen ${run}`);
  await p2.locator('a.adm-row', { hasText: ngoName }).waitFor();
  ok(await p2.locator('a.adm-row', { hasText: vendorName }).count() === 0, 'search finds the NGO by name only');
  await p2.getByLabel('Type').selectOption('vendor');
  await waitFor(async () => (await p2.locator('a.adm-row', { hasText: ngoName }).count()) === 0);
  ok(await p2.locator('a.adm-row', { hasText: ngoName }).count() === 0, 'type filter hides NGOs');
  await p2.getByLabel('Search by name').fill(run);
  await p2.locator('a.adm-row', { hasText: vendorName }).waitFor();
  ok(true, 'type filter and search combine');

  // -------------------------------------------------------------------------
  console.log('\n10. Every admin screen at 390px');
  await p2.setViewportSize({ width: 390, height: 844 });
  const screens = [['/admin', 'overview'], ['/admin/verifications', 'verifications'], ['/admin/organisations', 'organisations'], ['/admin/organisations/' + ngo, 'org-ngo'],
    ['/admin/orders', 'orders'], ['/admin/orders/' + orderA, 'order-a'], ['/admin/disputes?tab=decided', 'disputes-decided'], ['/admin/disputes/' + disputeId, 'dispute-decided'],
    ['/admin/payments', 'payments'], ['/admin/payouts', 'payouts'], ['/admin/payouts/' + batchId, 'payout-sent'], ['/admin/settings', 'settings'], ['/admin/audit', 'audit']];
  const wide = [];
  for (const [hash, name] of screens) {
    await visit(p2, hash);
    await p2.waitForTimeout(250);
    if (!(await noOverflow(p2))) wide.push(hash);
    await shot(p2, '20-' + name + '-390');
  }
  ok(wide.length === 0, 'no admin screen scrolls sideways at 390px', wide);

  ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
} catch (e) {
  failed++;
  console.error('\nTest stopped:', e);
  exitCode = 1;
} finally {
  if (savedMode !== undefined) await service.from('settings').update({ value: savedMode }).eq('key', 'payment_mode');
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
