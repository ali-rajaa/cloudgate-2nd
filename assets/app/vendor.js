// Business (vendor) screens: Today, List food, Listings, Pickups, pickup code, orders and earnings.
import {
  db, state, h, field, busy, toast, rpc, select, go, notice, pageHead, badge, empty, tabs, dialog, icon,
  uploadFile, photoUrl, rs, time, date, dateTime, untilText, minutesLeft, statusLabel, toLocalInput, fromLocalInput,
  phoneDisplay, friendly, AppError,
} from './core.js';

export function routes(register) {
  register('/vendor', { title: 'Today', roles: ['vendor'], render: today });
  register('/vendor/new', { title: 'List food', roles: ['vendor'], render: newListing });
  register('/vendor/listings', { title: 'Listings', roles: ['vendor'], render: listings });
  register('/vendor/listings/:id', { title: 'Listing', roles: ['vendor'], render: listing });
  register('/vendor/pickups', { title: 'Pickups', roles: ['vendor'], render: pickups });
  register('/vendor/pickups/code', { title: 'Enter pickup code', roles: ['vendor'], render: codeScreen });
  register('/vendor/orders/:id', { title: 'Order', roles: ['vendor'], render: order });
  register('/vendor/earnings', { title: 'Earnings', roles: ['vendor'], render: earnings });
}

// ---------------------------------------------------------------------------
// Screen lifetime: timers, realtime channels and key listeners end when the
// route changes or the screen re-renders.
// ---------------------------------------------------------------------------
let cleanups = [];
function resetScreen() { for (const f of cleanups.splice(0)) { try { f(); } catch { /* already gone */ } } }
window.addEventListener('hashchange', resetScreen);
function every(ms, fn) { const t = setInterval(fn, ms); cleanups.push(() => clearInterval(t)); }

// Live updates on this business's orders. Bursts of changes refresh once.
function watchOrders(root, refresh) {
  let timer;
  const ch = db.channel('vendor-orders-' + Math.random().toString(36).slice(2))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: 'vendor_id=eq.' + state.org.id }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (root.isConnected) refresh().catch((e) => toast(friendly(e), 'error')); }, 300);
    })
    .subscribe();
  cleanups.push(() => { clearTimeout(timer); db.removeChannel(ch); });
}

// Keep "Ends in 45 min (10:30 pm)" texts current.
function tickTimes(root) {
  every(30000, () => root.querySelectorAll('[data-until]').forEach((el) => { el.textContent = untilLabel(el.dataset.until, el.dataset.prefix); }));
}
function untilLabel(t, prefix = 'Ends in') {
  return minutesLeft(t) > 0 ? `${prefix} ${untilText(t)} (${time(t)})` : `Ended ${time(t)}`;
}
const until = (t, prefix = 'Ends in') => h('span.vd-until', { 'data-until': t, 'data-prefix': prefix }, untilLabel(t, prefix));

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
// Never select the pickup code: businesses can only check it.
const ORDER_COLS = 'id, listing_id, ngo_id, collector_id, status, payment_mode, price_rs, commission_rs, vendor_share_rs, payment_deadline, held_until, ngo_payment_reference, ngo_marked_paid_at, paid_at, quantity_handed_over, picked_up_at, completed_at, collection_asked_at, ended_at, ended_reason, created_at';
const ORDER_WITH_LISTING = ORDER_COLS + ', listings(id, title, quantity, unit, pickup_start, pickup_end, listing_photos(file_path, sort))';
const ACTIVE = ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer'];
const ENDED_ORDER = ['completed', 'completed_unconfirmed', 'expired_unpaid', 'released', 'cancelled_by_ngo', 'cancelled_by_vendor', 'refused_at_pickup', 'no_show'];

async function count(query) {
  const { count: n, error } = await query;
  if (error) throw new AppError(friendly(error));
  return n || 0;
}

const SETTING_KEYS = ['payment_mode', 'commission_percent', 'charge_commission_in_direct_mode', 'min_price_rs', 'max_price_share_of_retail',
  'min_listing_lead_minutes', 'min_pickup_window_minutes', 'safe_until_margin_minutes', 'cooked_food_open', 'hot_months', 'reliability_floor'];
async function loadSettings() {
  const rows = await select(db.from('settings').select('key, value').in('key', SETTING_KEYS));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
function moneySplit(price, s) {
  const p = Math.max(0, Math.round(Number(price) || 0));
  const free = s.payment_mode === 'direct' && s.charge_commission_in_direct_mode !== true;
  const commission = free ? 0 : Math.floor(p * Number(s.commission_percent || 0) / 100);
  return { price: p, commission, share: p - commission };
}

// Names of the NGO and collector come from order_details (businesses can't read NGO records).
async function partiesFor(orders) {
  const map = new Map();
  await Promise.all(orders.map(async (o) => {
    try { map.set(o.id, await rpc('order_details', { p_order: o.id })); } catch { map.set(o.id, null); }
  }));
  return map;
}

const ref = (id) => 'RR-' + String(id).slice(0, 8).toUpperCase();
const pkDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date(t));
const pkDayStart = () => new Date(pkDay(Date.now()) + 'T00:00:00+05:00').toISOString();
function windowText(start, end) {
  if (!start || !end) return '';
  return pkDay(start) === pkDay(end) ? `${time(start)} to ${time(end)}, ${date(start)}` : `${dateTime(start)} to ${dateTime(end)}`;
}
const firstPhoto = (photos) => (photos || []).slice().sort((a, b) => a.sort - b.sort)[0]?.file_path || null;
function thumb(path, alt = '') {
  return path ? h('img.vd-thumb', { src: photoUrl(path), alt, loading: 'lazy', width: 64, height: 64 }) : h('span.vd-thumb.vd-thumb--empty', icon('camera', 22));
}
const fact = (label, ...value) => h('div', h('dt', label), h('dd', ...value));
const back = (path, label) => h('a.vd-back', { href: '#' + path }, icon('back', 18), h('span', label));
const qty = (n, unit) => `${Number(n).toLocaleString('en-US')} ${unit || ''}`.trim();

const STORAGE = { room: 'Room temperature', hot: 'Kept hot (60°C or more)', chilled: 'Chilled (5°C or less)' };
const ALLERGENS = [['gluten', 'Gluten (wheat)'], ['milk', 'Milk'], ['eggs', 'Eggs'], ['nuts', 'Nuts'], ['sesame', 'Sesame'], ['soy', 'Soy'], ['fish', 'Fish']];
function dietText(d) {
  if (!d) return 'Not given';
  const parts = [];
  if (d.vegetarian) parts.push('Vegetarian');
  if (d.contains?.length) parts.push('Contains ' + d.contains.map((c) => (ALLERGENS.find((a) => a[0] === c)?.[1] || c).toLowerCase()).join(', '));
  if (d.halal) parts.push('Halal (declared by the business)');
  return parts.length ? parts.join(' · ') : 'Not given';
}
function reliabilityText(score) {
  return score >= 90 ? 'Highly reliable' : score >= 75 ? 'Reliable' : score >= 60 ? 'Building a record' : 'Under review';
}

// ---------------------------------------------------------------------------
// Order actions shared by Today, Pickups and the order page
// ---------------------------------------------------------------------------
function paymentButtons(o, after) {
  const yes = h('button.btn.btn--primary.btn--sm', { type: 'button', onclick: () => busy(yes, async () => {
    await rpc('vendor_confirm_payment', { p_order: o.id, p_received: true });
    toast('Payment confirmed. The NGO can now see its pickup code.');
    await after();
  }) }, icon('check', 18), ' Payment received');
  const no = h('button.btn.btn--secondary.btn--sm', { type: 'button', onclick: async () => {
    const ok = await dialog({ title: 'Payment not received?', text: 'We\'ll ask the NGO to check its payment and tell our team. Check your bank or Raast account first.', confirm: 'Not received', danger: true });
    if (ok) busy(no, async () => { await rpc('vendor_confirm_payment', { p_order: o.id, p_received: false }); toast('The NGO has been asked to check its payment.'); await after(); });
  } }, 'Not received');
  return [yes, no];
}

function collectionButtons(o, after) {
  const yes = h('button.btn.btn--primary.btn--sm', { type: 'button', onclick: () => busy(yes, async () => {
    await rpc('vendor_answer_collection', { p_order: o.id, p_collected: true });
    toast('Marked as collected.');
    await after();
  }) }, 'Yes, they collected');
  const no = h('button.btn.btn--secondary.btn--sm', { type: 'button', onclick: async () => {
    const ok = await dialog({ title: 'Nobody collected the food?', text: 'The order becomes a no-show. The NGO gets a strike and isn\'t refunded. They can report a problem within 24 hours if they disagree.', confirm: 'No, not collected', danger: true });
    if (ok) busy(no, async () => { await rpc('vendor_answer_collection', { p_order: o.id, p_collected: false }); toast('Marked as not collected.'); await after(); });
  } }, 'No, not collected');
  return [yes, no];
}

function orderMeta(o) {
  const l = o.listings || {};
  switch (o.status) {
    case 'payment_due': return [until(o.payment_deadline, 'Pay within'), ' · Don\'t hand over the food until it shows as paid'];
    case 'payment_processing': return o.payment_mode === 'direct'
      ? [`NGO says it paid ${o.ngo_marked_paid_at ? 'at ' + time(o.ngo_marked_paid_at) : ''}`, o.ngo_payment_reference ? ` · Reference ${o.ngo_payment_reference}` : '']
      : ['The payment is being confirmed'];
    case 'paid': return ['Pickup ', windowText(l.pickup_start, l.pickup_end), ' · ', until(l.pickup_end)];
    case 'awaiting_collection_answer': return [`Pickup ended at ${time(l.pickup_end)}, ${date(l.pickup_end)}. No code was entered.`];
    case 'picked_up': return [`Handed over ${dateTime(o.picked_up_at)}`];
    case 'completed': case 'completed_unconfirmed': return [`Completed ${o.completed_at ? dateTime(o.completed_at) : ''}`];
    default: return [o.ended_reason || statusLabel(o.status)];
  }
}

function orderItem(o, d, actions) {
  const l = o.listings || {};
  const collector = d?.collector?.name;
  return h('li.app-list__item.vd-item', { 'data-order': o.id },
    thumb(firstPhoto(l.listing_photos)),
    h('div.vd-item__body',
      h('a.app-list__title.vd-item__title', { href: '#/vendor/orders/' + o.id }, l.title || 'Order ' + ref(o.id)),
      h('p.app-list__text', d?.ngo?.name || 'An NGO', collector ? ` · Collector: ${collector}` : '', ' · ', h('strong', rs(o.price_rs))),
      h('p.app-list__meta', orderMeta(o))),
    h('div.vd-item__end', badge(o.status), actions?.length ? h('div.vd-actions', actions) : null));
}

function actionsFor(o, after) {
  if (o.status === 'payment_processing' && o.payment_mode === 'direct') return paymentButtons(o, after);
  if (o.status === 'awaiting_collection_answer') return collectionButtons(o, after);
  if (o.status === 'paid') return [h('a.btn.btn--secondary.btn--sm', { href: '#/vendor/pickups/code' }, icon('key', 18), ' Enter pickup code')];
  return [];
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------
async function today() {
  resetScreen();
  const org = state.org;
  const owner = state.membershipRole === 'owner';
  const body = h('div.vd-today');
  const root = h('section.vd', pageHead('Today', org.name,
    h('a.btn.btn--accent', { href: '#/vendor/new' }, icon('plus'), h('span', 'List food'))), body);

  async function fill() {
    const now = new Date().toISOString();
    const [s, liveCount, everCount, active, paidToday, lines, score, strikes] = await Promise.all([
      loadSettings(),
      count(db.from('listings').select('id', { count: 'exact', head: true }).eq('vendor_id', org.id).eq('status', 'live').gt('pickup_end', now)),
      count(db.from('listings').select('id', { count: 'exact', head: true }).eq('vendor_id', org.id)),
      select(db.from('orders').select(ORDER_WITH_LISTING).eq('vendor_id', org.id).in('status', ACTIVE).order('created_at')),
      select(db.from('orders').select('price_rs, status').eq('vendor_id', org.id).gte('paid_at', pkDayStart())),
      select(db.from('payout_lines').select('net_rs, status').eq('vendor_id', org.id).in('status', ['eligible', 'in_batch'])),
      rpc('reliability_score', { p_org: org.id }),
      select(db.from('strikes').select('id, reason, expires_at, created_at').eq('organisation_id', org.id).is('forgiven_at', null).gt('expires_at', now).order('created_at')),
    ]);
    const parties = await partiesFor(active);
    const toConfirm = active.filter((o) => o.status === 'payment_processing' && o.payment_mode === 'direct');
    const toAsk = active.filter((o) => o.status === 'awaiting_collection_answer');
    const due = active.filter((o) => o.status === 'paid');
    const waiting = active.filter((o) => o.status === 'payment_due' || (o.status === 'payment_processing' && o.payment_mode !== 'direct'));
    const todayKey = pkDay(Date.now());
    const dueToday = due.filter((o) => o.listings && pkDay(o.listings.pickup_start) <= todayKey).length;
    const direct = s.payment_mode === 'direct';
    const money = direct
      ? paidToday.filter((o) => !['cancelled_by_vendor', 'refused_at_pickup'].includes(o.status)).reduce((a, o) => a + o.price_rs, 0)
      : lines.reduce((a, l) => a + l.net_rs, 0);

    const stat = (href, value, label, name) => h('a.app-stat', { href: '#' + href, 'data-stat': name }, h('p.app-stat__value', value), h('p.app-stat__label', label));
    const stats = h('div.app-stats',
      stat('/vendor/listings', String(liveCount), liveCount === 1 ? 'Live listing' : 'Live listings', 'live'),
      stat('/vendor/pickups', String(dueToday), dueToday === 1 ? 'Pickup due today' : 'Pickups due today', 'due'),
      owner ? stat('/vendor/earnings', rs(money), direct ? 'Payments confirmed today' : 'Due in your next payout', 'money') : null);

    const refresh = () => fill();
    const section = (id, title, lead, list, actions) => list.length ? h('section.app-section', { id },
      h('div.vd-section-head', h('h2.app-h2', title), h('span.app-tab__count', String(list.length))),
      lead ? h('p.app-muted', lead) : null,
      h('ul.app-list', list.map((o) => orderItem(o, parties.get(o.id), actions(o))))) : null;

    const sections = [
      section('vd-confirm', 'Payments to confirm', 'Check your bank or Raast account, then confirm. The NGO sees its pickup code only after you confirm.', toConfirm, (o) => paymentButtons(o, refresh)),
      section('vd-ask', 'Did they collect?', 'The pickup window has ended and no code was entered.', toAsk, (o) => collectionButtons(o, refresh)),
      section('vd-due', 'Pickups due', 'Paid and ready. Hand over the food when the collector gives you the right code.', due, (o) => actionsFor(o, refresh)),
      section('vd-waiting', 'Claimed, waiting for payment', 'Keep the food aside. Don\'t hand it over until it shows as paid.', waiting, () => []),
    ].filter(Boolean);

    let lead = null;
    if (!sections.length) {
      lead = everCount === 0
        ? empty('List your first surplus in under a minute', 'Take a photo, set a price and a pickup time. Verified NGOs nearby can claim it straight away.', h('a.btn.btn--primary', { href: '#/vendor/new' }, 'List food'))
        : h('div.vd-quiet', icon('check'), h('p', liveCount ? 'Nothing needs you right now. New claims show up here as they happen.' : 'Nothing needs you right now. List food when you have surplus.'));
    }

    const floor = Number(s.reliability_floor || 60);
    const record = h('section.app-section', { id: 'vd-record' }, h('h2.app-h2', 'Your record'),
      h('dl.key-facts',
        fact('Reliability score', `${score} out of 100`, h('span.vd-sub', reliabilityText(score))),
        fact('Active strikes', strikes.length ? String(strikes.length) : 'None', h('span.vd-sub', strikes.length ? 'Strikes expire after 60 days' : 'Keep it that way: hand over what you list, on time'))),
      strikes.length ? h('ul.vd-strikes', strikes.map((x) => h('li', x.reason, h('span.vd-sub', ` Expires ${date(x.expires_at)}`)))) : null,
      score < floor ? notice('warning', 'Your reliability is under review. You can have at most 3 live listings until it improves.') : null);

    body.replaceChildren(stats, lead, ...sections, record);
  }

  await fill();
  watchOrders(root, fill);
  tickTimes(root);
  every(120000, () => { if (root.isConnected) fill().catch(() => {}); });
  return root;
}

// ---------------------------------------------------------------------------
// List food: four steps
// ---------------------------------------------------------------------------
async function newListing() {
  resetScreen();
  const org = state.org;
  const [s, cats] = await Promise.all([loadSettings(), select(db.from('categories').select('*').order('sort'))]);
  const open = cats.filter((c) => c.opens === 'pilot' || (c.opens === 'cooked' && s.cooked_food_open === true));
  const catById = (id) => cats.find((c) => c.id === id);
  const minPrice = Number(s.min_price_rs || 1000), share = Number(s.max_price_share_of_retail || 0.5);
  const lead = Number(s.min_listing_lead_minutes || 60), minWindow = Number(s.min_pickup_window_minutes || 30), margin = Number(s.safe_until_margin_minutes || 30);

  // Step 1: photos
  const photos = [];
  const photoErr = h('p.field__error', { hidden: true, role: 'alert' });
  const photoInput = h('input.vd-file', { type: 'file', name: 'photos', accept: 'image/jpeg,image/png,image/webp', multiple: true, 'aria-label': 'Add photos' });
  const photoGrid = h('div.vd-photos');
  function drawPhotos() {
    photoGrid.replaceChildren(
      ...photos.map((p, i) => h('figure.vd-photo',
        h('img', { src: p.url, alt: `Photo ${i + 1}` }),
        i === 0 ? h('figcaption', 'Main photo') : null,
        h('button.vd-photo__remove', { type: 'button', 'aria-label': `Remove photo ${i + 1}`, onclick: () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); drawPhotos(); } }, icon('x', 18)))),
      photos.length < 3 ? h('label.vd-addphoto', icon('camera', 28), h('span', photos.length ? 'Add another' : 'Take or choose a photo'), photoInput) : null);
  }
  photoInput.addEventListener('change', () => {
    photoErr.hidden = true;
    for (const f of Array.from(photoInput.files)) {
      if (photos.length >= 3) { showPhotoErr('A listing can have up to 3 photos.'); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { showPhotoErr('Use a JPG, PNG or WebP photo.'); continue; }
      if (f.size > 15 * 1024 * 1024) { showPhotoErr('That photo is too large. Use one under 15 MB.'); continue; }
      photos.push({ file: f, url: URL.createObjectURL(f) });
    }
    photoInput.value = '';
    drawPhotos();
  });
  function showPhotoErr(m) { photoErr.textContent = m; photoErr.hidden = false; }
  drawPhotos();
  cleanups.push(() => photos.forEach((p) => URL.revokeObjectURL(p.url)));
  const step1 = h('div.vd-step',
    h('p.app-muted', 'A clear photo of the actual food helps NGOs decide quickly. The first photo is required; add up to 3.'),
    photoGrid, photoErr);

  // Step 2: what it is
  const f = {
    title: field({ name: 'title', label: 'Title', required: true, full: true, placeholder: 'Naan and sheermal, 40 pieces', hint: 'What it is and how much, in a few words.' }),
    category: field({ name: 'category', label: 'Category', type: 'select', required: true, full: true, options: open.map((c) => ({ value: c.id, label: c.name })),
      hint: s.cooked_food_open === true ? null : 'Cooked food opens after the pilot.' }),
    quantity: field({ name: 'quantity', label: 'Quantity', type: 'number', required: true, min: 0, step: 'any', inputmode: 'decimal' }),
    unit: field({ name: 'unit', label: 'Unit', type: 'select', required: true, value: 'pieces', options: ['pieces', 'kg', 'boxes', 'trays', 'packets', 'portions', 'litres'] }),
    weight: field({ name: 'weight', label: 'Estimated weight (kg)', type: 'number', required: true, min: 0, max: 500, step: 'any', inputmode: 'decimal' }),
    feeds: field({ name: 'feeds', label: 'Feeds about', type: 'number', min: 1, step: 1, inputmode: 'numeric', hint: 'Number of people' }),
    description: field({ name: 'description', label: 'Description', type: 'textarea', full: true, rows: 2, placeholder: 'Baked this evening. Packed in paper bags.' }),
    vegetarian: field({ name: 'vegetarian', label: 'Vegetarian', type: 'checkbox' }),
    halal: field({ name: 'halal', label: 'I declare this food is halal', type: 'checkbox', value: true }),
  };
  const allergens = ALLERGENS.map(([id, label]) => field({ name: 'allergen-' + id, label, type: 'checkbox' }));
  const step2 = h('div.vd-step.form__grid',
    f.title.wrap, f.category.wrap,
    h('div.vd-grid2', f.quantity.wrap, f.unit.wrap, f.weight.wrap, f.feeds.wrap),
    f.description.wrap,
    h('fieldset.vd-fieldset', h('legend.field__label', 'Contains'), h('div.vd-checks', allergens.map((a) => a.wrap))),
    h('fieldset.vd-fieldset', h('legend.field__label', 'Dietary'), h('div.vd-checks', f.vegetarian.wrap, f.halal.wrap)));

  // Step 3: price and pickup
  const roundTo = (t, mins, up) => { const ms = mins * 60000; return new Date((up ? Math.ceil : Math.floor)(t / ms) * ms); };
  const prepDefault = roundTo(Date.now(), 5, false);
  const startDefault = roundTo(Date.now() + 15 * 60000, 15, true);
  const p = {
    retail: field({ name: 'retail', label: 'Retail value (Rs)', type: 'number', required: true, min: 1, step: 1, inputmode: 'numeric', hint: 'What this food would sell for in your shop.' }),
    price: field({ name: 'price', label: 'Price for NGOs (Rs)', type: 'number', required: true, min: minPrice, step: 1, inputmode: 'numeric', hint: `From ${rs(minPrice)}, and at most half the retail value.` }),
    storage: field({ name: 'storage', label: 'How it is kept', type: 'select', required: true, value: 'room', options: Object.entries(STORAGE).map(([value, label]) => ({ value, label })) }),
    prepared: field({ name: 'prepared', label: 'Prepared at', type: 'datetime-local', required: true, value: toLocalInput(prepDefault), hint: 'When it was cooked, baked or opened.' }),
    safe: field({ name: 'safe', label: 'Safe until', type: 'datetime-local', required: true }),
    start: field({ name: 'start', label: 'Pickup from', type: 'datetime-local', required: true, value: toLocalInput(startDefault) }),
    end: field({ name: 'end', label: 'Pickup until', type: 'datetime-local', required: true, value: toLocalInput(new Date(startDefault.getTime() + 2 * 3600000)) }),
    instructions: field({ name: 'instructions', label: 'Packaging and pickup notes', type: 'textarea', full: true, rows: 2, placeholder: 'Bring two crates. Ask for the manager at the back counter.' }),
  };
  const splitBox = h('dl.app-split', { 'aria-live': 'polite', id: 'vd-split' });
  const splitNote = h('p.field__hint');
  const priceMax = h('span');
  function drawSplit() {
    const sp = moneySplit(p.price.value(), s);
    splitBox.replaceChildren(
      h('div', h('dt', 'NGO pays'), h('dd', rs(sp.price))),
      h('div', h('dt', 'You receive'), h('dd', rs(sp.share))),
      h('div', h('dt', 'Rizq Rasan'), h('dd', rs(sp.commission))));
    splitNote.textContent = s.payment_mode === 'direct'
      ? 'During the pilot NGOs pay you directly by Raast or bank transfer' + (sp.commission ? '.' : ', and Rizq Rasan takes no commission.')
      : `Rizq Rasan keeps ${s.commission_percent}% (services tax included). Payouts go to your bank on Mondays and Thursdays.`;
    const retail = Number(p.retail.value()) || 0;
    priceMax.textContent = retail ? `For this listing the price can be ${rs(minPrice)} to ${rs(Math.floor(retail * share))}.` : '';
  }
  p.price.input.addEventListener('input', drawSplit);
  p.retail.input.addEventListener('input', drawSplit);
  drawSplit();

  let cap = null, capFor = '', safeEdited = false;
  const safeHint = h('p.field__hint');
  p.safe.input.after(safeHint);
  p.safe.input.addEventListener('input', () => { safeEdited = true; });
  function storageOptions() {
    const c = catById(f.category.value());
    const allowed = (k) => !c || c.uses_label_date || c[{ room: 'max_hours_room', hot: 'max_hours_hot', chilled: 'max_hours_chilled' }[k]] !== null;
    for (const opt of p.storage.input.options) if (opt.value) { opt.disabled = !allowed(opt.value); opt.hidden = !allowed(opt.value); }
    if (p.storage.input.value && !allowed(p.storage.input.value)) p.storage.input.value = Object.keys(STORAGE).find(allowed) || '';
  }
  async function refreshCap() {
    const c = catById(f.category.value());
    const prepared = fromLocalInput(p.prepared.input.value);
    const storage = p.storage.input.value;
    if (!c || !prepared || !storage) return;
    const key = [c.id, storage, prepared].join('|');
    if (key === capFor) return;
    capFor = key;
    try {
      const v = await rpc('max_safe_until', { p_category: c.id, p_storage: storage, p_prepared: prepared });
      if (capFor !== key) return;
      cap = v;
      if (cap) {
        p.safe.input.max = toLocalInput(cap);
        if (!safeEdited || !p.safe.input.value || fromLocalInput(p.safe.input.value) > cap) { p.safe.input.value = toLocalInput(cap); safeEdited = false; }
        safeHint.textContent = `Filled in from the food safety limit for ${c.name.split(' (')[0].toLowerCase()}. You can make it earlier, not later (latest ${dateTime(cap)}).`;
        fitPickupEnd();
      } else {
        p.safe.input.removeAttribute('max');
        safeHint.textContent = 'Use the use-by or best-before date on the label.';
      }
      p.storage.error('');
    } catch (e) {
      cap = null;
      p.storage.error(friendly(e));
    }
  }
  // Keep the default pickup end inside the safe-until margin.
  function fitPickupEnd() {
    const safe = fromLocalInput(p.safe.input.value);
    const end = fromLocalInput(p.end.input.value);
    if (!safe || !end) return;
    const latest = new Date(safe).getTime() - margin * 60000;
    if (new Date(end).getTime() > latest) p.end.input.value = toLocalInput(roundTo(latest, 5, false));
  }
  f.category.input.addEventListener('change', () => { storageOptions(); refreshCap(); });
  p.storage.input.addEventListener('change', refreshCap);
  p.prepared.input.addEventListener('change', refreshCap);
  p.safe.input.addEventListener('change', fitPickupEnd);

  const step3 = h('div.vd-step.form__grid',
    h('div.vd-grid2', p.retail.wrap, p.price.wrap),
    h('div.field.field--full', h('p.field__hint', priceMax), splitBox, splitNote),
    h('div.vd-grid2', p.storage.wrap, p.prepared.wrap),
    p.safe.wrap,
    h('div.vd-grid2', p.start.wrap, p.end.wrap),
    p.instructions.wrap);

  // Step 4: review
  const tick1 = field({ name: 'safe-tick', label: 'The food was made and kept safely, and is fit to eat until the safe-until time.', type: 'checkbox' });
  const tick2 = field({ name: 'true-tick', label: 'The photo, quantity and times are accurate. I\'ll have it ready during the pickup window.', type: 'checkbox' });
  const preview = h('div.vd-preview');
  const summary = h('div.vd-summary', { hidden: true, role: 'alert', tabindex: '-1' });
  const step4 = h('div.vd-step',
    h('p.app-muted', 'This is what NGOs will see.'),
    preview,
    h('div.vd-ticks', tick1.wrap, tick2.wrap));

  function drawPreview() {
    const c = catById(f.category.value());
    const sp = moneySplit(p.price.value(), s);
    const start = fromLocalInput(p.start.input.value), end = fromLocalInput(p.end.input.value), safe = fromLocalInput(p.safe.input.value);
    const editLink = (n) => h('button.vd-linkbtn', { type: 'button', onclick: () => show(n) }, 'Change');
    preview.replaceChildren(
      h('article.app-card.vd-card',
        photos[0] ? h('img.app-card__photo', { src: photos[0].url, alt: '' }) : h('div.app-card__photo'),
        h('div.app-card__body',
          h('h3.app-card__title', f.title.value()),
          h('p.app-card__meta', h('span', qty(f.quantity.value(), f.unit.value())), f.feeds.value() ? h('span', `Feeds about ${f.feeds.value()}`) : null, h('span', `${f.weight.value()} kg`)),
          h('p.app-card__meta', h('span', icon('clock', 16), windowText(start, end)), h('span', icon('pin', 16), org.sector || '')),
          h('p.app-card__price', h('span.app-card__amount', rs(sp.price)), h('span.app-card__retail', rs(p.retail.value())), h('span.vd-sub', 'retail value')))),
      h('dl.key-facts.vd-facts',
        fact('Photos', `${photos.length} of 3`, ' ', editLink(0)),
        fact('Category', c?.name || '', ' ', editLink(1)),
        fact('Dietary', dietText(dietary()), ' ', editLink(1)),
        fact('Money', `NGO pays ${rs(sp.price)} · You receive ${rs(sp.share)} · Rizq Rasan ${rs(sp.commission)}`, ' ', editLink(2)),
        fact('Kept', STORAGE[p.storage.input.value] || '', ' ', editLink(2)),
        fact('Safe until', safe ? dateTime(safe) : '', ' ', editLink(2)),
        p.instructions.value() ? fact('Notes', p.instructions.value()) : null));
  }

  function dietary() {
    const d = {};
    if (f.vegetarian.value()) d.vegetarian = true;
    const contains = ALLERGENS.filter((_, i) => allergens[i].value()).map((a) => a[0]);
    if (contains.length) d.contains = contains;
    if (f.halal.value()) d.halal = 'vendor_declared';
    return d;
  }

  // Validation mirrors the server's rules. The server still decides.
  function check(n) {
    const errs = [];
    const err = (fld, m) => { fld.error(m); errs.push([fld, m]); };
    if (n === 0) {
      if (!photos.length) { showPhotoErr('Add a photo of the food.'); errs.push([null, 'Add a photo of the food.']); }
    }
    if (n === 1) {
      const t = f.title.value();
      if (t.length < 3) err(f.title, 'Enter a title of at least 3 characters.');
      else if (t.length > 80) err(f.title, 'Keep the title under 80 characters.');
      if (!f.category.value()) err(f.category, 'Choose a category.');
      if (!(Number(f.quantity.value()) > 0)) err(f.quantity, 'Enter how much there is.');
      if (!f.unit.value()) err(f.unit, 'Choose a unit.');
      const w = Number(f.weight.value());
      if (!(w > 0)) err(f.weight, 'Estimate the weight in kg.');
      else if (w > 500) err(f.weight, 'One listing can be at most 500 kg.');
      if (f.feeds.value() !== '' && !(Number.isInteger(f.feeds.value()) && f.feeds.value() > 0)) err(f.feeds, 'Enter a whole number of people, or leave it empty.');
    }
    if (n === 2) {
      const retail = p.retail.value(), price = p.price.value();
      if (!(Number.isInteger(retail) && retail > 0)) err(p.retail, 'Enter the retail value in whole rupees.');
      if (!Number.isInteger(price) || price <= 0) err(p.price, 'Enter the price in whole rupees.');
      else if (price < minPrice) err(p.price, `Listings start at ${rs(minPrice)}.`);
      else if (Number.isInteger(retail) && price > Math.floor(retail * share)) err(p.price, `The price can be at most half of the retail value (${rs(Math.floor(retail * share))} for this listing).`);
      const c = catById(f.category.value());
      const month = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', month: 'numeric' }).format(new Date()));
      if (!p.storage.input.value) err(p.storage, 'Choose how the food is kept.');
      else if (c?.cooked && p.storage.input.value === 'room' && (s.hot_months || []).includes(month)) err(p.storage, 'From May to September cooked food can\'t be listed at room temperature. Keep it hot or chilled.');
      const prepared = fromLocalInput(p.prepared.input.value), safe = fromLocalInput(p.safe.input.value);
      const start = fromLocalInput(p.start.input.value), end = fromLocalInput(p.end.input.value);
      const T = (x) => new Date(x).getTime();
      if (!prepared) err(p.prepared, 'Enter when the food was prepared.');
      else if (T(prepared) > Date.now() + 5 * 60000) err(p.prepared, 'The preparation time can\'t be in the future.');
      if (!safe) err(p.safe, 'Enter the safe-until time.');
      else if (cap && T(safe) > T(cap)) err(p.safe, `For this food the safe-until time can be at most ${dateTime(cap)}.`);
      if (!start) err(p.start, 'Enter when pickup starts.');
      if (!end) err(p.end, 'Enter when pickup ends.');
      if (start && end) {
        if (T(end) - T(start) < minWindow * 60000) err(p.end, `The pickup window must be at least ${minWindow} minutes long.`);
        else if (T(end) < Date.now() + lead * 60000) err(p.end, `Pickup must end at least ${lead} minutes from now.`);
        else if (safe && T(end) > T(safe) - margin * 60000) err(p.end, `Pickup must end at least ${margin} minutes before the food's safe-until time.`);
      }
    }
    if (n === 3) {
      if (!tick1.value()) err(tick1, 'Tick to confirm the food is safe.');
      if (!tick2.value()) err(tick2, 'Tick to confirm the details are accurate.');
    }
    if (errs.length) {
      const firstField = errs.find((e) => e[0])?.[0];
      (firstField?.input || photoInput.closest('label') || photoInput).focus?.();
    }
    return errs.length === 0;
  }

  // Step navigation
  const STEPS = [['Photo', step1], ['What it is', step2], ['Price and pickup', step3], ['Review and publish', step4]];
  let current = 0;
  const counter = h('p.vd-stepcount', { 'aria-live': 'polite' });
  const progress = h('div.vd-progress', { 'aria-hidden': 'true' }, STEPS.map(() => h('span')));
  const stepTitle = h('h2.app-h2.vd-steptitle');
  const backBtn = h('button.btn.btn--secondary', { type: 'button', onclick: () => show(current - 1) }, 'Back');
  const nextBtn = h('button.btn.btn--primary', { type: 'submit' }, 'Continue');
  const form = h('form.app-form.card.vd-form', { novalidate: true },
    counter, progress, stepTitle, summary, ...STEPS.map(([, node]) => node),
    h('div.vd-stepbar', backBtn, nextBtn));
  function show(n) {
    current = Math.max(0, Math.min(STEPS.length - 1, n));
    STEPS.forEach(([, node], i) => { node.hidden = i !== current; });
    progress.querySelectorAll('span').forEach((el, i) => el.classList.toggle('is-done', i <= current));
    counter.textContent = `Step ${current + 1} of ${STEPS.length}`;
    stepTitle.textContent = STEPS[current][0];
    backBtn.hidden = current === 0;
    nextBtn.textContent = current === STEPS.length - 1 ? 'Publish listing' : 'Continue';
    nextBtn.classList.toggle('btn--accent', current === STEPS.length - 1);
    nextBtn.classList.toggle('btn--primary', current !== STEPS.length - 1);
    if (current === 2) refreshCap();
    if (current === 3) drawPreview();
    if (current !== 3) summary.hidden = true;
    window.scrollTo({ top: 0 });
  }

  // Server messages land under the field they belong to.
  const SERVER_FIELDS = [
    [/Pickup must end|pickup window/i, p.end, 2],
    [/safe-until/i, p.safe, 2],
    [/Listings start at|at most half/i, p.price, 2],
    [/preparation time/i, p.prepared, 2],
    [/room temperature|when stored|cannot be listed when/i, p.storage, 2],
    [/category|can.t be listed|Cooked food/i, f.category, 1],
  ];
  function serverError(message) {
    const hit = SERVER_FIELDS.find(([re]) => re.test(message));
    if (hit) {
      show(hit[2]);
      hit[1].error(message);
      hit[1].input.focus();
    } else {
      summary.replaceChildren(icon('alert'), h('p', message));
      summary.hidden = false;
      summary.focus();
    }
  }

  async function publish() {
    let id;
    try {
      id = await rpc('create_listing', {
        p_vendor: org.id, p_title: f.title.value(), p_category: f.category.value(), p_quantity: Number(f.quantity.value()), p_unit: f.unit.value(),
        p_weight_kg: Number(f.weight.value()), p_retail_value_rs: p.retail.value(), p_price_rs: p.price.value(), p_storage: p.storage.input.value,
        p_prepared_at: fromLocalInput(p.prepared.input.value), p_safe_until: fromLocalInput(p.safe.input.value),
        p_pickup_start: fromLocalInput(p.start.input.value), p_pickup_end: fromLocalInput(p.end.input.value),
        p_description: f.description.value() || null, p_feeds_about: f.feeds.value() === '' ? null : f.feeds.value(),
        p_dietary: dietary(), p_instructions: p.instructions.value() || null,
      });
    } catch (e) { serverError(friendly(e)); return; }
    let failed = 0;
    for (const ph of photos) {
      try {
        const path = await uploadFile('listing-photos', org.id, ph.file);
        await rpc('add_listing_photo', { p_listing: id, p_path: path });
      } catch { failed++; }
    }
    if (failed) toast(`Your listing is live, but ${failed === 1 ? 'a photo' : failed + ' photos'} didn't upload. Add ${failed === 1 ? 'it' : 'them'} from the listing page.`, 'error');
    else toast('Listed. NGOs nearby can see it now.');
    go('/vendor/listings/' + id);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!check(current)) return;
    if (current < STEPS.length - 1) { show(current + 1); return; }
    for (let i = 0; i < 3; i++) if (!check(i)) { show(i); check(i); return; }
    busy(nextBtn, publish);
  });

  storageOptions();
  show(0);
  return h('section.app-narrow.vd', pageHead('List food', 'Takes about a minute. NGOs see it as soon as you publish.'), form);
}

// ---------------------------------------------------------------------------
// My listings
// ---------------------------------------------------------------------------
const LISTING_TABS = [
  { id: 'live', label: 'Live', statuses: ['live'], empty: ['Nothing live right now', 'List surplus food and NGOs nearby can claim it.'] },
  { id: 'claimed', label: 'Claimed', statuses: ['claimed'], empty: ['No claimed listings', 'When an NGO claims your food it shows here until it is handed over.'] },
  { id: 'done', label: 'Done', statuses: ['completed'], empty: ['Nothing handed over yet', 'Completed handovers show here.'] },
  { id: 'ended', label: 'Ended', statuses: ['expired', 'withdrawn', 'removed'], empty: ['Nothing has ended', 'Listings that were withdrawn or not claimed in time show here.'] },
  { id: 'drafts', label: 'Drafts', statuses: ['draft'], empty: ['No drafts', 'Listings are published as soon as you finish the form.'] },
];

async function listings({ query }) {
  resetScreen();
  const org = state.org;
  const [rows, orders] = await Promise.all([
    select(db.from('listings').select('id, title, status, status_reason, price_rs, retail_value_rs, quantity, unit, pickup_start, pickup_end, created_at, updated_at, listing_photos(file_path, sort)')
      .eq('vendor_id', org.id).order('pickup_end', { ascending: false }).limit(300)),
    select(db.from('orders').select('id, listing_id, status').eq('vendor_id', org.id).in('status', [...ACTIVE, 'picked_up'])),
  ]);
  const orderFor = new Map(orders.map((o) => [o.listing_id, o]));
  let active = LISTING_TABS.some((t) => t.id === query.tab) ? query.tab : 'live';
  const holder = h('div');
  const root = h('section.vd', pageHead('Listings', null, h('a.btn.btn--accent', { href: '#/vendor/new' }, icon('plus'), h('span', 'List food'))), holder);

  function draw() {
    const tab = LISTING_TABS.find((t) => t.id === active);
    let list = rows.filter((l) => tab.statuses.includes(l.status));
    if (active === 'live') list = list.slice().sort((a, b) => new Date(a.pickup_end) - new Date(b.pickup_end));
    const bar = tabs(LISTING_TABS.map((t) => ({ id: t.id, label: t.label, count: rows.filter((l) => t.statuses.includes(l.status)).length })), active, (id) => {
      active = id;
      history.replaceState(null, '', '#/vendor/listings?tab=' + id);
      draw();
    });
    const content = list.length
      ? h('ul.app-list', list.map((l) => {
        const o = orderFor.get(l.id);
        const side = l.status === 'live' ? until(l.pickup_end)
          : o ? h('span.vd-sub', statusLabel(o.status))
          : l.status_reason ? h('span.vd-sub', l.status_reason) : null;
        return h('li.app-list__item.vd-item', { 'data-listing': l.id },
          thumb(firstPhoto(l.listing_photos)),
          h('div.vd-item__body',
            h('a.app-list__title.vd-item__title', { href: '#/vendor/listings/' + l.id }, l.title),
            h('p.app-list__text', h('strong', rs(l.price_rs)), ' · ', qty(l.quantity, l.unit)),
            h('p.app-list__meta', 'Pickup ', windowText(l.pickup_start, l.pickup_end))),
          h('div.vd-item__end', badge(l.status), side));
      }))
      : empty(tab.empty[0], tab.empty[1], active === 'live' ? h('a.btn.btn--primary', { href: '#/vendor/new' }, 'List food') : null);
    holder.replaceChildren(bar, content);
  }
  draw();
  tickTimes(root);
  return root;
}

// ---------------------------------------------------------------------------
// One listing
// ---------------------------------------------------------------------------
async function listing({ params, app }) {
  resetScreen();
  const l = await select(db.from('listings').select('*, categories(name), listing_photos(id, file_path, sort)').eq('id', params.id).maybeSingle());
  if (!l || l.vendor_id !== state.org.id) return empty('Listing not found', 'It may belong to another business.', h('a.btn.btn--secondary', { href: '#/vendor/listings' }, 'Back to your listings'));
  const [orders, s] = await Promise.all([
    select(db.from('orders').select(ORDER_COLS).eq('listing_id', l.id).order('created_at')),
    loadSettings(),
  ]);
  const current = orders.find((o) => ACTIVE.includes(o.status) || o.status === 'picked_up') || orders[orders.length - 1] || null;
  const d = current ? await rpc('order_details', { p_order: current.id }).catch(() => null) : null;
  const photos = (l.listing_photos || []).slice().sort((a, b) => a.sort - b.sort);
  const live = l.status === 'live';
  const sp = moneySplit(l.price_rs, s);

  // Actions while live
  const actions = [];
  if (live) {
    const edit = h('button.btn.btn--secondary', { type: 'button', onclick: async () => {
      const v = await dialog({ title: 'Edit wording', text: 'You can fix the wording while the listing is live. Price, quantity and times can\'t change; withdraw and list again instead.', confirm: 'Save changes', fields: [
        { name: 'title', label: 'Title', required: true, value: l.title },
        { name: 'description', label: 'Description', type: 'textarea', value: l.description || '' },
        { name: 'instructions', label: 'Packaging and pickup notes', type: 'textarea', value: l.instructions || '' },
      ] });
      if (!v) return;
      if (v.title.length < 3 || v.title.length > 80) { toast('The title must be 3 to 80 characters.', 'error'); return; }
      busy(edit, async () => {
        await rpc('edit_listing', { p_listing: l.id, p_title: v.title, p_description: v.description || null, p_instructions: v.instructions || null });
        toast('Changes saved.');
        app.refresh();
      });
    } }, 'Edit wording');
    actions.push(edit);
    if (photos.length < 3) {
      const input = h('input.vd-file', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Add a photo' });
      const add = h('button.btn.btn--secondary', { type: 'button', onclick: () => input.click() }, icon('camera', 18), ' Add photo');
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Use a JPG, PNG or WebP photo.', 'error'); return; }
        busy(add, async () => {
          const path = await uploadFile('listing-photos', state.org.id, file);
          await rpc('add_listing_photo', { p_listing: l.id, p_path: path });
          toast('Photo added.');
          app.refresh();
        });
      });
      actions.push(add, input);
    }
    const withdraw = h('button.btn.btn--danger', { type: 'button', onclick: async () => {
      const ok = await dialog({ title: 'Withdraw this listing?', text: 'NGOs will stop seeing it straight away. This can\'t be undone, but you can list the food again.', confirm: 'Withdraw listing', danger: true });
      if (ok) busy(withdraw, async () => { await rpc('withdraw_listing', { p_listing: l.id }); toast('Listing withdrawn.'); app.refresh(); });
    } }, 'Withdraw');
    actions.push(withdraw);
  }

  // Timeline
  const events = [{ at: l.created_at, title: 'Listed', text: `Live for NGOs at ${rs(l.price_rs)}` }];
  for (const o of orders) {
    const who = o.id === current?.id && d?.ngo?.name ? d.ngo.name : 'An NGO';
    events.push({ at: o.created_at, title: 'Claimed', text: `${who} claimed it. Order ${ref(o.id)}.` });
    if (o.ngo_marked_paid_at) events.push({ at: o.ngo_marked_paid_at, title: 'NGO says it paid', text: o.ngo_payment_reference ? `Reference ${o.ngo_payment_reference}` : '' });
    if (o.paid_at) events.push({ at: o.paid_at, title: 'Paid', text: 'Ready to collect' });
    if (o.picked_up_at) events.push({ at: o.picked_up_at, title: 'Handed over', text: o.quantity_handed_over != null ? `${qty(o.quantity_handed_over, l.unit)} handed over` : '' });
    if (o.completed_at) events.push({ at: o.completed_at, title: statusLabel(o.status), text: '' });
    else if (o.ended_at) events.push({ at: o.ended_at, title: statusLabel(o.status), text: o.ended_reason || '' });
  }
  if (['withdrawn', 'expired', 'removed'].includes(l.status)) events.push({ at: l.updated_at, title: statusLabel(l.status), text: l.status_reason || '' });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const root = h('section.app-narrow.vd',
    back('/vendor/listings', 'Listings'),
    pageHead(l.title, l.categories?.name, badge(l.status)),
    live ? h('p.vd-lead-until', icon('clock', 18), until(l.pickup_end, 'Pickup ends in')) : null,
    photos.length ? h('div.vd-gallery', photos.map((ph, i) => h('img', { src: photoUrl(ph.file_path), alt: i === 0 ? l.title : `Photo ${i + 1}`, loading: 'lazy' })))
      : notice('warning', 'This listing has no photo. Listings with a photo are claimed much faster.'),
    actions.length ? h('div.vd-actions.vd-actions--page', actions) : null,
    current ? h('section.app-section', { id: 'vd-order' }, h('h2.app-h2', 'Order'),
      h('a.card.card--link.vd-ordercard', { href: '#/vendor/orders/' + current.id },
        h('div', h('p.app-list__title', d?.ngo?.name || 'An NGO'),
          h('p.app-list__text', `Order ${ref(current.id)} · ${rs(current.price_rs)}`),
          d?.collector?.name ? h('p.app-list__meta', 'Collector: ' + d.collector.name) : null),
        h('div.vd-item__end', badge(current.status), icon('arrow')))) : null,
    h('section.app-section', h('h2.app-h2', 'Details'),
      h('dl.key-facts',
        fact('Price', rs(l.price_rs), h('span.vd-sub', `You receive ${rs(current ? current.vendor_share_rs : sp.share)} · Rizq Rasan ${rs(current ? current.commission_rs : sp.commission)}`)),
        fact('Retail value', rs(l.retail_value_rs)),
        fact('Quantity', qty(l.quantity, l.unit), h('span.vd-sub', `About ${l.weight_kg} kg${l.feeds_about ? ` · feeds about ${l.feeds_about}` : ''}`)),
        fact('Pickup', windowText(l.pickup_start, l.pickup_end)),
        fact('Kept', STORAGE[l.storage] || l.storage),
        fact('Prepared', dateTime(l.prepared_at)),
        fact('Safe until', dateTime(l.safe_until)),
        fact('Dietary', dietText(l.dietary)),
        l.description ? fact('Description', l.description) : null,
        l.instructions ? fact('Packaging and pickup notes', l.instructions) : null)),
    h('section.app-section', h('h2.app-h2', 'Timeline'),
      h('ol.timeline.vd-timeline', events.map((e) => h('li', h('h3', e.title), e.text ? h('p', e.text) : null, h('span.meta', dateTime(e.at)))))));
  tickTimes(root);
  return root;
}

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------
const PICKUP_TABS = [
  { id: 'hand', label: 'To hand over', statuses: ['paid', 'awaiting_collection_answer'], empty: ['Nothing to hand over', 'Paid orders show here, ready for the collector.'] },
  { id: 'payment', label: 'Awaiting payment', statuses: ['payment_due', 'payment_processing'], empty: ['No claims waiting for payment', 'When an NGO claims your food it shows here until it has paid.'] },
  { id: 'done', label: 'Handed over', statuses: ['picked_up', 'completed', 'completed_unconfirmed'], empty: ['Nothing handed over yet', 'Orders show here after you enter the pickup code.'] },
  { id: 'problems', label: 'Problems', statuses: ['refused_at_pickup', 'no_show', 'cancelled_by_vendor', 'cancelled_by_ngo'], empty: ['No problems', 'Cancelled orders, no-shows and problem reports show here.'] },
];

async function pickups({ query }) {
  resetScreen();
  const org = state.org;
  let active = PICKUP_TABS.some((t) => t.id === query.tab) ? query.tab : 'hand';
  let orders = [], disputed = new Set();
  const cache = new Map();
  const holder = h('div');
  const root = h('section.vd',
    pageHead('Pickups', 'Check the collector\'s code before you hand over food.'),
    h('a.btn.btn--primary.btn--block.vd-codebtn', { href: '#/vendor/pickups/code' }, icon('key', 24), h('span', 'Enter pickup code')),
    holder);
  const inTab = (t, o) => t.statuses.includes(o.status) || (t.id === 'problems' && disputed.has(o.id));

  async function load() {
    const [rows, disputes] = await Promise.all([
      select(db.from('orders').select(ORDER_WITH_LISTING).eq('vendor_id', org.id).not('status', 'in', '(expired_unpaid,released)').order('created_at', { ascending: false }).limit(200)),
      select(db.from('disputes').select('order_id, status').in('status', ['open', 'awaiting_reply'])),
    ]);
    orders = rows;
    disputed = new Set(disputes.map((x) => x.order_id));
    for (const o of rows) if (ACTIVE.includes(o.status)) cache.delete(o.id);
    await draw();
  }
  async function draw() {
    const tab = PICKUP_TABS.find((t) => t.id === active);
    let list = orders.filter((o) => inTab(tab, o));
    if (tab.id === 'hand') list = list.slice().sort((a, b) => new Date(a.listings?.pickup_start) - new Date(b.listings?.pickup_start));
    const need = list.filter((o) => !cache.has(o.id));
    const got = await partiesFor(need);
    for (const [k, v] of got) cache.set(k, v);
    const bar = tabs(PICKUP_TABS.map((t) => ({ id: t.id, label: t.label, count: orders.filter((o) => inTab(t, o)).length })), active, (id) => {
      active = id;
      history.replaceState(null, '', '#/vendor/pickups?tab=' + id);
      draw().catch((e) => toast(friendly(e), 'error'));
    });
    holder.replaceChildren(bar, list.length
      ? h('ul.app-list', list.map((o) => orderItem(o, cache.get(o.id), actionsFor(o, load))))
      : empty(tab.empty[0], tab.empty[1]));
  }
  await load();
  watchOrders(root, load);
  tickTimes(root);
  return root;
}

// ---------------------------------------------------------------------------
// Enter pickup code (keypad)
// ---------------------------------------------------------------------------
async function codeScreen() {
  resetScreen();
  const org = state.org;
  let digits = '';
  const boxes = [0, 1, 2, 3].map(() => h('span.app-keypad__digit', ''));
  const display = h('div.app-keypad__display', { role: 'status', 'aria-label': 'Code entered' }, boxes);
  const msg = h('div.vd-code-msg', { role: 'alert', hidden: true });
  const lessCheck = field({ name: 'less', label: 'I\'m handing over less than listed', type: 'checkbox' });
  const lessQty = field({ name: 'quantity', label: 'Quantity handed over', type: 'number', min: 0, step: 'any', inputmode: 'decimal' });
  lessQty.wrap.hidden = true;
  lessCheck.input.addEventListener('change', () => { lessQty.wrap.hidden = !lessCheck.value(); if (lessCheck.value()) lessQty.input.focus(); });
  const confirmBtn = h('button.btn.btn--accent.btn--block.vd-confirm', { type: 'button', disabled: true, onclick: () => submit() }, 'Confirm handover');
  const keypadArea = h('div.vd-code');
  const result = h('div');

  function draw() {
    boxes.forEach((b, i) => { b.textContent = digits[i] || ''; b.classList.toggle('is-filled', i < digits.length); });
    display.setAttribute('aria-label', `Code entered: ${digits.split('').join(' ') || 'none'}`);
    confirmBtn.disabled = digits.length !== 4;
  }
  function press(k) {
    if (k === 'back') digits = digits.slice(0, -1);
    else if (k === 'clear') digits = '';
    else if (digits.length < 4) digits += k;
    msg.hidden = true;
    draw();
  }
  const key = (label, value, aria) => h('button', { type: 'button', 'aria-label': aria || label, 'data-key': value, onclick: () => press(value) }, label);
  const pad = h('div.app-keypad', display,
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => key(n, n)),
    key('Clear', 'clear', 'Clear the code'), key('0', '0'), h('button', { type: 'button', 'aria-label': 'Delete last digit', 'data-key': 'back', onclick: () => press('back') }, icon('back', 24)));

  const onKey = (e) => {
    if (!keypadArea.isConnected || keypadArea.hidden || e.target.closest?.('input, textarea, select, dialog')) return;
    if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
    else if (e.key === 'Enter' && digits.length === 4) { submit(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  function say(kind, text) {
    msg.className = 'vd-code-msg vd-code-msg--' + kind;
    msg.replaceChildren(icon(kind === 'lock' ? 'shield' : 'alert'), h('p', text));
    msg.hidden = false;
  }

  function submit() {
    if (digits.length !== 4) return;
    let quantity = null;
    if (lessCheck.value()) {
      quantity = lessQty.value();
      if (!(Number(quantity) > 0)) { lessQty.error('Enter how much you are handing over.'); lessQty.input.focus(); return; }
    }
    busy(confirmBtn, async () => {
      let res;
      try {
        res = await rpc('verify_pickup_code', { p_vendor: org.id, p_code: digits, p_quantity: quantity });
      } catch (e) {
        const m = friendly(e);
        say(/locked/i.test(m) ? 'lock' : 'error', /locked/i.test(m) ? m + ' Ask the collector to check the code in their app, or call the NGO.' : m);
        digits = ''; draw();
        return;
      }
      if (!res?.ok) {
        say('error', res?.message || 'That code doesn\'t match a paid order. Check it with the collector.');
        pad.classList.remove('is-wrong'); void pad.offsetWidth; pad.classList.add('is-wrong');
        digits = ''; draw();
        return;
      }
      const d = await rpc('order_details', { p_order: res.order_id }).catch(() => null);
      showMatch(res, d);
    });
  }

  function showMatch(res, d) {
    keypadArea.hidden = true;
    const again = h('button.btn.btn--primary', { type: 'button', onclick: () => {
      digits = ''; lessCheck.input.checked = false; lessQty.wrap.hidden = true; lessQty.input.value = '';
      result.replaceChildren(); keypadArea.hidden = false; draw(); loadExpected();
    } }, 'Enter another code');
    const handed = d?.quantity_handed_over != null ? qty(d.quantity_handed_over, d.listing?.unit) : '';
    const full = d && Number(d.quantity_handed_over) === Number(d.listing?.quantity);
    result.replaceChildren(h('div.card.vd-match', { role: 'status' },
      h('div.vd-match__head', h('span.vd-match__icon', icon('check', 28)), h('div', h('p.vd-match__title', 'Code matches. Hand over the food.'), h('p.app-muted', res.title))),
      h('dl.key-facts',
        fact('NGO', d?.ngo?.name || 'NGO'),
        fact('Collector', d?.collector?.name || 'Not named', d?.collector?.phone ? h('span.vd-sub', h('a', { href: 'tel:' + d.collector.phone }, phoneDisplay(d.collector.phone))) : null),
        fact('Paid', rs(res.price_rs)),
        fact('Quantity handed over', handed, h('span.vd-sub', full ? 'Everything listed' : `Listed: ${qty(d?.listing?.quantity, d?.listing?.unit)}`))),
      h('p.app-muted', 'The NGO has been told. If anything goes wrong, report it from the order within 24 hours.'),
      h('div.vd-actions', again, h('a.btn.btn--secondary', { href: '#/vendor/orders/' + res.order_id }, 'View order'))));
  }

  // Who is expected: paid orders, so staff can recognise the collector.
  const expected = h('section.app-section', { id: 'vd-expected' });
  async function loadExpected() {
    const rows = await select(db.from('orders').select(ORDER_WITH_LISTING).eq('vendor_id', org.id).in('status', ['paid', 'awaiting_collection_answer']).order('created_at'));
    const parties = await partiesFor(rows);
    expected.replaceChildren(h('h2.app-h2', 'Expected pickups'), rows.length
      ? h('ul.app-list', rows.map((o) => {
        const d = parties.get(o.id);
        const call = d?.ngo?.phone ? h('a.btn.btn--secondary.btn--sm', { href: 'tel:' + d.ngo.phone }, icon('phone', 18), ' Call NGO') : null;
        return h('li.app-list__item.vd-item',
          thumb(firstPhoto(o.listings?.listing_photos)),
          h('div.vd-item__body',
            h('p.app-list__title', o.listings?.title),
            h('p.app-list__text', d?.ngo?.name || 'An NGO', d?.collector?.name ? ` · Collector: ${d.collector.name}` : ''),
            h('p.app-list__meta', windowText(o.listings?.pickup_start, o.listings?.pickup_end), ' · ', rs(o.price_rs))),
          h('div.vd-item__end', call));
      }))
      : h('p.app-muted', 'No paid orders are waiting. A code only works once the NGO has paid.'));
  }
  await loadExpected();

  keypadArea.append(h('div.card.vd-codecard', h('p.vd-code-intro', 'Ask the collector for the 4-digit code from their app.'), pad, msg,
    h('div.vd-less', lessCheck.wrap, lessQty.wrap), confirmBtn));
  const root = h('section.app-narrow.vd', back('/vendor/pickups', 'Pickups'), pageHead('Enter pickup code'), keypadArea, result, expected);
  watchOrders(root, loadExpected);
  draw();
  return root;
}

// ---------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------
const PROBLEM_KINDS = [
  { value: 'payment', label: 'A payment problem' },
  { value: 'conduct', label: 'The collector\'s or NGO\'s behaviour' },
  { value: 'other', label: 'Something else' },
];

async function order({ params, app }) {
  resetScreen();
  const d = await rpc('order_details', { p_order: params.id });
  const [disputes, photos] = await Promise.all([
    select(db.from('disputes').select('id, kind, status, created_at, raised_by_org').eq('order_id', d.id).order('created_at')),
    select(db.from('listing_photos').select('file_path, sort').eq('listing_id', d.listing.id)),
  ]);
  const L = d.listing;
  const o = { ...d, listings: L };
  const refresh = () => app.refresh();
  const status = d.status;

  let banner = null, actions = [];
  if (status === 'payment_due') banner = notice('info', `Waiting for ${d.ngo.name} to pay. They have until ${time(d.payment_deadline)}. Don't hand over the food until it shows as paid.`);
  if (status === 'payment_processing' && d.payment_mode === 'direct') {
    banner = notice('warning', `${d.ngo.name} says it paid ${rs(d.price_rs)}${d.ngo_payment_reference ? ` with reference ${d.ngo_payment_reference}` : ''}. Check your bank or Raast account, then confirm.`);
    actions = paymentButtons(o, refresh);
  } else if (status === 'payment_processing') banner = notice('info', 'The payment is being confirmed by the payment gateway.');
  if (status === 'paid') {
    banner = notice('info', `Paid. Hand over the food only when the collector gives you the right code. Pickup ${windowText(L.pickup_start, L.pickup_end)}.`);
    actions = [h('a.btn.btn--primary', { href: '#/vendor/pickups/code' }, icon('key', 18), ' Enter pickup code')];
  }
  if (status === 'awaiting_collection_answer') { banner = notice('warning', 'The pickup window has ended and no code was entered. Did the NGO collect the food?'); actions = collectionButtons(o, refresh); }
  if (status === 'picked_up') banner = notice('info', 'Handed over. The order completes 24 hours after pickup unless a problem is reported.');

  const cancellable = ACTIVE.includes(status);
  const afterPay = status !== 'payment_due';
  const cancelBtn = cancellable ? h('button.btn.btn--secondary.vd-danger-text', { type: 'button', onclick: async () => {
    const v = await dialog({
      title: 'Cancel this order?',
      text: afterPay
        ? `${d.ngo.name} has already paid. Cancelling now gives your business a strike, ` + (d.payment_mode === 'direct' ? 'and you must return their payment within 1 working day.' : 'and they are refunded in full from your share.')
        : 'The NGO hasn\'t paid yet, so nothing is charged. The listing is withdrawn.',
      confirm: 'Cancel order', cancel: 'Keep order', danger: true,
      fields: [{ name: 'reason', label: 'Reason (the NGO will see it)', type: 'textarea', required: true }],
    });
    if (v) busy(cancelBtn, async () => { await rpc('vendor_cancel_order', { p_order: d.id, p_reason: v.reason }); toast('Order cancelled.'); refresh(); });
  } }, 'Cancel order') : null;

  const reportBtn = !ENDED_ORDER.includes(status) || ['completed', 'completed_unconfirmed', 'no_show'].includes(status)
    ? h('button.btn.btn--secondary', { type: 'button', onclick: async () => {
      const v = await dialog({ title: 'Report a problem', text: 'Our team reads every report. The NGO is asked for its side.', confirm: 'Send report', fields: [
        { name: 'kind', label: 'What went wrong', type: 'select', required: true, options: PROBLEM_KINDS },
        { name: 'details', label: 'What happened', type: 'textarea', required: true, hint: 'A sentence or two. Include times and names if you can.' },
      ] });
      if (v) busy(reportBtn, async () => { const id = await rpc('report_problem', { p_order: d.id, p_kind: v.kind, p_details: v.details }); toast('Problem reported.'); go('/disputes/' + id); });
    } }, icon('alert', 18), ' Report a problem') : null;

  const events = [
    { at: d.created_at, title: 'Claimed', text: `${d.ngo.name} claimed it for ${rs(d.price_rs)}.` },
    d.paid_at ? { at: d.paid_at, title: 'Paid', text: d.payment_mode === 'direct' ? 'You confirmed the payment arrived.' : 'Payment confirmed by the gateway.' } : null,
    d.picked_up_at ? { at: d.picked_up_at, title: 'Handed over', text: d.quantity_handed_over != null ? `${qty(d.quantity_handed_over, L.unit)} handed over` : '' } : null,
    d.completed_at ? { at: d.completed_at, title: statusLabel(status), text: '' } : null,
  ].filter(Boolean);
  if (!d.completed_at && ENDED_ORDER.includes(status)) events.push({ at: null, title: statusLabel(status), text: d.ended_reason || '' });

  const photo = firstPhoto(photos);
  return h('section.app-narrow.vd',
    back('/vendor/pickups', 'Pickups'),
    pageHead(L.title, `Order ${d.reference}`, badge(status)),
    banner,
    actions.length ? h('div.vd-actions.vd-actions--page', actions) : null,
    h('section.app-section',
      h('div.vd-orderhead', thumb(photo, L.title), h('div', h('p.app-list__title', h('a', { href: '#/vendor/listings/' + L.id }, L.title)), h('p.app-list__text', qty(L.quantity, L.unit), ' · ', windowText(L.pickup_start, L.pickup_end)))),
      h('dl.key-facts',
        fact('NGO', d.ngo.name, h('span.vd-sub', d.ngo.badge)),
        fact('Contact', d.ngo.phone ? h('a', { href: 'tel:' + d.ngo.phone }, phoneDisplay(d.ngo.phone)) : 'Shown once paid'),
        fact('Collector', d.collector?.name || 'Not named yet', d.collector?.phone ? h('span.vd-sub', h('a', { href: 'tel:' + d.collector.phone }, phoneDisplay(d.collector.phone))) : null),
        fact('Price', rs(d.price_rs), h('span.vd-sub', `You receive ${rs(d.vendor_share_rs)} · Rizq Rasan ${rs(d.commission_rs)}`)),
        fact('Payment', d.payment_mode === 'direct' ? 'Paid to you directly' : 'Through Rizq Rasan, paid out to your bank', d.ngo_payment_reference ? h('span.vd-sub', `NGO reference ${d.ngo_payment_reference}`) : null),
        fact(status === 'payment_due' ? 'Pay by' : 'Pickup', status === 'payment_due' ? dateTime(d.payment_deadline) : windowText(L.pickup_start, L.pickup_end)))),
    h('section.app-section', h('h2.app-h2', 'Timeline'),
      h('ol.timeline.vd-timeline', events.map((e) => h('li', h('h3', e.title), e.text ? h('p', e.text) : null, e.at ? h('span.meta', dateTime(e.at)) : null)))),
    disputes.length ? h('section.app-section', { id: 'vd-disputes' }, h('h2.app-h2', 'Problem reports'),
      h('ul.app-list', disputes.map((x) => h('li.app-list__item',
        h('div', h('p.app-list__title', x.raised_by_org === state.org.id ? 'You reported a problem' : 'The NGO reported a problem'),
          h('p.app-list__meta', `${x.kind.replace(/_/g, ' ')} · ${dateTime(x.created_at)} · ${x.status === 'decided' ? 'Decided' : x.status === 'awaiting_reply' ? 'Waiting for a reply' : 'With our team'}`)),
        h('a.btn.btn--secondary.btn--sm', { href: '#/disputes/' + x.id }, 'View report'))))) : null,
    reportBtn || cancelBtn ? h('section.app-section', h('h2.app-h2', 'Something wrong?'),
      afterPay && cancellable ? h('p.app-muted', 'Cancelling after the NGO has paid gives your business a strike. Three active strikes suspend the account.') : null,
      h('div.vd-actions', reportBtn, cancelBtn)) : null);
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------
const LINE_STATUS = { pending: ['Pending', 'muted'], eligible: ['Eligible', 'wait'], in_batch: ['In batch', 'wait'], paid: ['Paid', 'good'], on_hold: ['On hold', 'bad'] };
const lineBadge = (st) => h('span.badge', { class: 'badge--' + (LINE_STATUS[st]?.[1] || 'muted') }, LINE_STATUS[st]?.[0] || st);

function csvDownload(name, rows) {
  const text = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function earnings() {
  resetScreen();
  const org = state.org;
  const [s, lines, direct] = await Promise.all([
    loadSettings(),
    select(db.from('payout_lines').select('id, order_id, gross_rs, commission_rs, tax_withheld_rs, deductions_rs, net_rs, status, hold_reason, bank_reference, created_at, paid_at, orders(created_at, picked_up_at, listings(title))')
      .eq('vendor_id', org.id).order('created_at', { ascending: false })),
    select(db.from('orders').select('id, status, price_rs, commission_rs, vendor_share_rs, paid_at, picked_up_at, ngo_payment_reference, listings(title)')
      .eq('vendor_id', org.id).eq('payment_mode', 'direct').not('paid_at', 'is', null).order('paid_at', { ascending: false })),
  ]);
  const directMode = s.payment_mode === 'direct';
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
  const by = (st) => lines.filter((l) => st.includes(l.status));
  const keptDirect = direct.filter((o) => !['cancelled_by_vendor', 'refused_at_pickup', 'cancelled_by_ngo'].includes(o.status));

  const tiles = directMode && !lines.length
    ? h('div.app-stats',
      h('div.app-stat', h('p.app-stat__value', rs(sum(keptDirect, 'price_rs'))), h('p.app-stat__label', 'Paid to you directly')),
      h('div.app-stat', h('p.app-stat__value', String(keptDirect.length)), h('p.app-stat__label', keptDirect.length === 1 ? 'Paid order' : 'Paid orders')))
    : h('div.app-stats',
      h('div.app-stat', h('p.app-stat__value', rs(sum(by(['eligible', 'in_batch']), 'net_rs'))), h('p.app-stat__label', 'Due in your next payout')),
      h('div.app-stat', h('p.app-stat__value', rs(sum(by(['paid']), 'net_rs'))), h('p.app-stat__label', 'Paid to your bank')),
      h('div.app-stat', h('p.app-stat__value', rs(sum(by(['on_hold']), 'net_rs'))), h('p.app-stat__label', 'On hold')));

  const lineRows = lines.map((l) => ({
    title: l.orders?.listings?.title || 'Order', id: l.order_id, ref: ref(l.order_id), when: l.orders?.picked_up_at || l.created_at,
    gross: l.gross_rs, commission: l.commission_rs, tax: l.tax_withheld_rs + l.deductions_rs, net: l.net_rs, status: l.status, hold: l.hold_reason, bank: l.bank_reference,
  }));
  const td = (label, content, cls) => h('td', { 'data-label': label, class: cls || null }, content);
  const payoutTable = lines.length ? h('section.app-section', { id: 'vd-payouts' },
    h('div.vd-section-head', h('h2.app-h2', 'Payouts'), h('button.btn.btn--secondary.btn--sm', { type: 'button', onclick: () => csvDownload('rizq-rasan-earnings.csv',
      [['Order', 'Reference', 'Date', 'Gross', 'Commission', 'Tax and deductions', 'Net', 'Status', 'Bank reference'],
        ...lineRows.map((r) => [r.title, r.ref, date(r.when), r.gross, r.commission, r.tax, r.net, LINE_STATUS[r.status]?.[0] || r.status, r.bank || ''])]) }, 'Download CSV')),
    h('p.app-muted', 'Payouts go to your bank account on Mondays and Thursdays, once the order is complete.'),
    h('div.app-table-wrap.vd-tablewrap', h('table.app-table.vd-table',
      h('thead', h('tr', h('th', 'Order'), h('th.num', 'Gross'), h('th.num', 'Commission'), h('th.num', 'Net'), h('th', 'Status'), h('th', 'Bank reference'))),
      h('tbody', lineRows.map((r) => h('tr',
        td('Order', [h('a', { href: '#/vendor/orders/' + r.id }, r.title), h('span.vd-sub', `${r.ref} · ${date(r.when)}`)]),
        td('Gross', rs(r.gross), 'num'), td('Commission', rs(r.commission), 'num'),
        td('Net', h('strong', rs(r.net)), 'num'),
        td('Status', [lineBadge(r.status), r.hold ? h('span.vd-sub', r.hold) : null]),
        td('Bank reference', r.bank || '-')))),
      h('tfoot', h('tr.vd-total', td('Order', 'Total'), td('Gross', rs(sum(lineRows, 'gross')), 'num'), td('Commission', rs(sum(lineRows, 'commission')), 'num'),
        td('Net', h('strong', rs(sum(lineRows, 'net'))), 'num'), td('Status', ''), td('Bank reference', '')))))) : null;

  const directTable = direct.length ? h('section.app-section', { id: 'vd-direct' },
    h('h2.app-h2', 'Paid to you directly'),
    h('div.app-table-wrap.vd-tablewrap', h('table.app-table.vd-table',
      h('thead', h('tr', h('th', 'Order'), h('th.num', 'Paid'), h('th.num', 'Commission'), h('th.num', 'You keep'), h('th', 'Status'), h('th', 'NGO reference'))),
      h('tbody', direct.map((o) => h('tr',
        td('Order', [h('a', { href: '#/vendor/orders/' + o.id }, o.listings?.title || 'Order'), h('span.vd-sub', `${ref(o.id)} · ${date(o.paid_at)}`)]),
        td('Paid', rs(o.price_rs), 'num'), td('Commission', rs(o.commission_rs), 'num'), td('You keep', h('strong', rs(o.vendor_share_rs)), 'num'),
        td('Status', badge(o.status)), td('NGO reference', o.ngo_payment_reference || '-')))),
      h('tfoot', h('tr.vd-total', td('Order', 'Total'), td('Paid', rs(sum(keptDirect, 'price_rs')), 'num'), td('Commission', rs(sum(keptDirect, 'commission_rs')), 'num'),
        td('You keep', h('strong', rs(sum(keptDirect, 'vendor_share_rs'))), 'num'), td('Status', ''), td('NGO reference', '')))))) : null;

  return h('section.vd',
    pageHead('Earnings', directMode ? 'What NGOs have paid you.' : 'One row per order, from sale to payout.'),
    directMode ? notice('info', 'During the pilot NGOs pay you directly by Raast or bank transfer, so Rizq Rasan sends you no payouts. You confirm each payment when it arrives.' + (s.charge_commission_in_direct_mode === true ? ' Commission on these sales is billed to you separately.' : ' There is no commission on these sales.')) : null,
    tiles,
    payoutTable,
    directTable,
    !payoutTable && !directTable ? empty('No earnings yet', directMode ? 'Payments you confirm show here.' : 'Each completed order shows here with its payout status.', h('a.btn.btn--primary', { href: '#/vendor/new' }, 'List food')) : null);
}
