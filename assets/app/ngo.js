// NGO screens: find food, claim it, pay, collect, and manage collectors.
import {
  db, config, state, h, rpc, select, field, dialog, busy, toast, tabs, badge, pageHead, notice, empty, spinner,
  photoUrl, rs, time, date, dateTime, untilText, minutesLeft, go, link, icon, normalisePhone, phoneDisplay,
  refreshOrg, friendly, AppError,
} from './core.js';

export function routes(register) {
  register('/ngo', { title: 'Find food', roles: ['ngo'], render: findFood });
  register('/ngo/listings/:id', { title: 'Listing', roles: ['ngo'], render: listingDetail });
  register('/ngo/claims', { title: 'My claims', roles: ['ngo'], render: claims });
  register('/ngo/claims/:id', { title: 'Claim', roles: ['ngo'], render: claimPage });
  register('/ngo/collectors', { title: 'Collectors', roles: ['ngo'], render: collectors });
}

// ---------------------------------------------------------------------------
// Timers and live channels belong to one render. Leaving the page (or
// re-rendering it) stops them.
// ---------------------------------------------------------------------------
let gen = 0;
let cleanups = [];
function cleanup() { for (const f of cleanups.splice(0)) { try { f(); } catch { /* already gone */ } } }
function begin() { cleanup(); return ++gen; }
window.addEventListener('hashchange', () => { gen++; cleanup(); });
const alive = (token) => token === gen;
function every(token, ms, fn) {
  const t = setInterval(() => { if (!alive(token)) { clearInterval(t); return; } fn(); }, ms);
  cleanups.push(() => clearInterval(t));
}
function onWindow(token, event, fn, target = window) {
  const handler = () => { if (alive(token)) fn(); };
  target.addEventListener(event, handler);
  cleanups.push(() => target.removeEventListener(event, handler));
}
function liveOrder(token, orderId, fn) {
  const channel = db.channel(`ngo-order-${orderId}-${token}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` }, () => { if (alive(token)) fn(); })
    .subscribe();
  if (!alive(token)) { db.removeChannel(channel); return; }
  cleanups.push(() => db.removeChannel(channel));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const inFuture = (t) => t && new Date(t) > new Date();
const pkDay = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'short' }).format(new Date(t));
const sameDay = (t) => pkDay(t) === pkDay(Date.now());
const windowText = (s, e) => `${time(s)} to ${time(e)}${sameDay(e) ? '' : ', ' + date(e)}`;
const endsText = (e) => (minutesLeft(e) > 0 ? `Ends in ${untilText(e)} (${time(e)})` : `Ended at ${time(e)}`);
const shortCategory = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const STORAGE = { room: 'Room temperature', hot: 'Kept hot', chilled: 'Chilled' };

function dietChips(d) {
  const out = [];
  if (!d || typeof d !== 'object') return out;
  for (const [k, v] of Object.entries(d)) {
    const label = cap(k.replace(/_/g, ' '));
    if (k === 'halal' && v) out.push(v === 'certified' ? 'Halal certified' : 'Halal (business declared)');
    else if (v === true) out.push(label);
    else if (Array.isArray(v) && v.length) out.push((k === 'contains' ? 'Contains ' : label + ': ') + v.join(', '));
    else if (typeof v === 'string' && v) out.push(`${label}: ${v.replace(/_/g, ' ')}`);
  }
  return out;
}
const chips = (list) => (list.length ? h('ul.ngo-chips', list.map((c) => h('li.chip', c))) : null);

const fact = (label, value) => (value === null || value === undefined || value === '' ? null : h('div', h('dt', label), h('dd', value)));

async function settings(keys) {
  const rows = await select(db.from('settings').select('key, value').in('key', keys));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// Claiming paused (3 unpaid expiries) or account frozen (strikes).
function pauseState() {
  const o = state.org || {};
  if (inFuture(o.frozen_until)) return { frozen: true, until: o.frozen_until };
  if (inFuture(o.claims_paused_until)) return { frozen: false, until: o.claims_paused_until };
  return null;
}
function pauseNotice(p) {
  if (!p) return null;
  return p.frozen
    ? notice('warning', `Your account is paused until ${dateTime(p.until)} because of strikes. You can't find or claim food until then. Contact us if you think this is wrong.`)
    : notice('warning', `Claiming is paused until ${dateTime(p.until)} because 3 claims expired unpaid this week. You can still look at food near you.`);
}
function pinNotice() {
  if (state.org?.lat) return null;
  return notice('warning', ['Your organisation has no map pin, so we can\'t work out distances and show food from all over Islamabad. ',
    h('a', { href: '#/onboarding' }, 'Add your map pin'), '.']);
}

// ---------------------------------------------------------------------------
// Find food
// ---------------------------------------------------------------------------
const RADII = [2, 3, 5, 8, 10, 15];
const PRICES = [1000, 1500, 2000, 3000, 5000];

async function findFood() {
  const token = begin();
  await refreshOrg();
  const [conf, cats, active] = await Promise.all([
    settings(['browse_radius_km', 'cooked_food_open']),
    select(db.from('categories').select('id, name, opens').order('sort')),
    select(db.from('orders').select('id, status, payment_deadline, listings(title, pickup_start, pickup_end)')
      .eq('ngo_id', state.org.id).in('status', ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer']).order('created_at', { ascending: false })),
  ]);
  const defaultRadius = Number(conf.browse_radius_km) || 5;
  const saved = store.get('rr-ngo-filters') || {};
  const filters = { radius: saved.radius || defaultRadius, category: saved.category || '', maxPrice: saved.maxPrice || '' };
  const radii = [...new Set([...RADII, defaultRadius])].sort((a, b) => a - b);
  const cooked = conf.cooked_food_open === true;
  const catOptions = cats.filter((c) => c.opens === 'pilot' || (c.opens === 'cooked' && cooked)).map((c) => ({ value: c.id, label: shortCategory(c.name) }));

  const fRadius = field({ name: 'radius', label: 'Distance', type: 'select', required: true, value: String(filters.radius),
    options: radii.map((r) => ({ value: String(r), label: `Within ${r} km` })) });
  fRadius.input.querySelector('option[value=""]')?.remove();
  const fCat = field({ name: 'category', label: 'Food', type: 'select', required: true, value: filters.category, placeholder: 'All food', options: catOptions });
  const fPrice = field({ name: 'max_price', label: 'Price', type: 'select', required: true, value: String(filters.maxPrice), placeholder: 'Any price',
    options: PRICES.map((p) => ({ value: String(p), label: `Up to ${rs(p)}` })) });
  const bar = h('form.app-filters.ngo-filters', { role: 'search', 'aria-label': 'Filter food', onsubmit: (e) => e.preventDefault() },
    state.org.lat ? fRadius.wrap : null, fCat.wrap, fPrice.wrap);

  const summary = h('p.app-muted.ngo-summary', { 'aria-live': 'polite' });
  const results = h('div.ngo-results', spinner());
  const pause = pauseState();

  async function search() {
    if (pause?.frozen) { results.replaceChildren(empty('Finding food is paused', 'You can browse again once the pause ends.')); summary.textContent = ''; return; }
    let rows;
    try {
      rows = await rpc('search_listings', {
        p_ngo: state.org.id, p_radius_km: state.org.lat ? filters.radius : null,
        p_category: filters.category || null, p_max_price: filters.maxPrice ? Number(filters.maxPrice) : null,
      });
    } catch (e) {
      if (!alive(token)) return;
      results.replaceChildren(empty('Couldn\'t load food', friendly(e), h('button.btn.btn--secondary', { type: 'button', onclick: search }, 'Try again')));
      return;
    }
    if (!alive(token)) return;
    const where = state.org.lat ? `within ${filters.radius} km` : 'in Islamabad';
    summary.textContent = rows.length
      ? `${rows.length} listing${rows.length > 1 ? 's' : ''} ${where}, ending soonest first. Updated ${time(Date.now())}.`
      : '';
    if (!rows.length) {
      const wider = radii.find((r) => r > filters.radius);
      const filtered = filters.category || filters.maxPrice;
      results.replaceChildren(empty('No food near you right now',
        `Businesses list surplus through the day, so check back soon. Email alerts for food near you are coming later. ${
          wider && state.org.lat ? 'Until then, try a wider distance' : 'Until then, check this page'}${filtered ? ' or clear the filters' : ''}.`,
        h('div.ngo-empty-actions',
          wider && state.org.lat ? h('button.btn.btn--primary', { type: 'button', onclick: () => { fRadius.input.value = String(wider); apply(); } }, `Show food within ${wider} km`) : null,
          filtered ? h('button.btn.btn--secondary', { type: 'button', onclick: () => { fCat.input.value = ''; fPrice.input.value = ''; apply(); } }, 'Clear filters') : null)));
      return;
    }
    results.replaceChildren(h('div.app-grid.ngo-grid', rows.map(card)));
  }
  function apply() {
    filters.radius = Number(fRadius.input.value) || defaultRadius;
    filters.category = fCat.input.value;
    filters.maxPrice = fPrice.input.value;
    store.set('rr-ngo-filters', filters);
    results.replaceChildren(spinner());
    search();
  }
  [fRadius, fCat, fPrice].forEach((f) => f.input.addEventListener('change', apply));

  search();
  every(token, 30000, search);
  onWindow(token, 'focus', search);
  onWindow(token, 'visibilitychange', () => { if (document.visibilityState === 'visible') search(); }, document);

  return h('section.ngo-find',
    pageHead('Find food', 'Surplus food from verified businesses near you.', h('a.btn.btn--secondary.btn--sm', { href: '#/ngo/claims' }, 'My claims')),
    pauseNotice(pause), pinNotice(),
    active.length ? activeClaims(active) : null,
    bar, summary, results);
}

function activeClaims(rows) {
  return h('section.ngo-active', { 'aria-label': 'Your active claims' },
    h('h2.app-h2', 'Your active claims'),
    h('ul.ngo-active__list', rows.map((o) => {
      const l = o.listings || {};
      const next = o.status === 'payment_due' ? `Pay by ${time(o.payment_deadline)}`
        : o.status === 'payment_processing' ? 'Payment being confirmed'
        : `Collect ${windowText(l.pickup_start, l.pickup_end)}`;
      return h('li', h('a.ngo-active__item', { href: '#/ngo/claims/' + o.id },
        h('span.ngo-active__title', l.title || 'Claim'), h('span.ngo-active__next', next), icon('arrow', 18)));
    })));
}

function card(l) {
  const photo = photoUrl(l.photo_path);
  const started = !inFuture(l.pickup_start);
  return h('a.app-card.ngo-card', { href: '#/ngo/listings/' + l.id, dataset: { id: l.id } },
    photo ? h('img.app-card__photo', { src: photo, alt: '', loading: 'lazy' }) : h('div.app-card__photo.ngo-nophoto', icon('leaf', 36)),
    h('div.app-card__body',
      h('h3.app-card__title', l.title),
      h('p.app-card__meta', h('span', l.vendor_name), l.vendor_sector ? h('span', l.vendor_sector) : null,
        l.distance_km !== null && l.distance_km !== undefined ? h('span', icon('pin', 16), `${Number(l.distance_km).toFixed(1)} km away`) : null),
      h('p.app-card__meta', h('span.ngo-vbadge', icon('shield', 16), l.vendor_badge)),
      h('p.app-card__meta.ngo-when', h('span', icon('clock', 16), endsText(l.pickup_end)),
        started ? null : h('span', `Pickup from ${time(l.pickup_start)}`)),
      chips(dietChips(l.dietary)),
      h('div.app-card__foot',
        h('p.app-card__price', h('span.app-card__amount', rs(l.price_rs)), h('span.app-card__retail', h('span.visually-hidden', 'Retail value '), rs(l.retail_value_rs))),
        l.can_claim ? h('span.ngo-card__cta', 'Claim', icon('arrow', 16)) : h('span.badge.badge--muted', 'Too late to claim'))));
}

// ---------------------------------------------------------------------------
// Listing detail and claiming
// ---------------------------------------------------------------------------
async function listingDetail({ params }) {
  const token = begin();
  await refreshOrg();
  const pause = pauseState();
  if (pause?.frozen) return h('section.app-narrow', pageHead('Listing'), pauseNotice(pause), h('p', link('/ngo', 'Back to Find food')));

  const [rows, photos, mine, cols, conf] = await Promise.all([
    rpc('search_listings', { p_ngo: state.org.id, p_radius_km: 1000, p_category: null, p_max_price: null }),
    select(db.from('listing_photos').select('file_path, sort').eq('listing_id', params.id).order('sort')),
    select(db.from('orders').select('id').eq('ngo_id', state.org.id).eq('listing_id', params.id)
      .in('status', ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer', 'picked_up']).limit(1)),
    select(db.from('collectors').select('id, name, phone').eq('organisation_id', state.org.id).eq('active', true).order('name')),
    settings(['payment_window_minutes', 'payment_cutoff_before_end_minutes']),
  ]);
  if (mine.length) { go('/ngo/claims/' + mine[0].id); return h('div'); }
  const l = rows.find((r) => r.id === params.id);
  const back = h('p.ngo-back', h('a', { href: '#/ngo' }, icon('back', 18), 'Find food'));
  if (!l) {
    return h('section.app-narrow', back, empty('This food is no longer available',
      'Another NGO claimed it or its pickup time has ended. Other food near you may still be free.', h('a.btn.btn--primary', { href: '#/ngo' }, 'Find other food')));
  }

  const timeLeft = h('span.ngo-timeleft');
  const tick = () => { timeLeft.textContent = endsText(l.pickup_end); };
  tick();
  every(token, 15000, tick);

  // Collector (optional)
  let collector = null;
  if (cols.length) {
    collector = field({ name: 'collector', label: 'Who will collect it?', type: 'select', placeholder: 'Choose later',
      options: cols.map((c) => ({ value: c.id, label: `${c.name}, ${phoneDisplay(c.phone)}` })), hint: 'They get the pickup code once you pay.' });
  }

  const err = h('div.ngo-claim-error', { role: 'alert', hidden: true });
  const claimBtn = h('button.btn.btn--accent.btn--block.ngo-claim-btn', { type: 'button', disabled: !l.can_claim || Boolean(pause) }, `Claim for ${rs(l.price_rs)}`);
  claimBtn.addEventListener('click', async () => {
    err.hidden = true;
    const holdMins = Math.min(Number(conf.payment_window_minutes) || 30, minutesLeft(l.pickup_end) - (Number(conf.payment_cutoff_before_end_minutes) || 15));
    const holdUntil = Date.now() + holdMins * 60000;
    const ok = await dialog({
      title: 'Claim this food?',
      text: `We'll hold it for you until ${time(holdUntil)} while you pay ${rs(l.price_rs)}. If you don't pay in time, it goes back to other organisations.`,
      confirm: `Claim for ${rs(l.price_rs)}`, cancel: 'Not now',
    });
    if (!ok) return;
    await busy(claimBtn, async () => {
      try {
        const orderId = await rpc('claim_listing', { p_ngo: state.org.id, p_listing: l.id, p_collector: collector?.input.value || null });
        toast('Claimed. Pay before the deadline to get your pickup code.');
        go('/ngo/claims/' + orderId);
      } catch (e) {
        const msg = friendly(e);
        err.replaceChildren(icon('alert'), h('div', h('p', msg),
          /just claimed|ended/i.test(msg) ? h('p', h('a', { href: '#/ngo' }, 'See other food near you')) : null,
          /Pay for your current claim/i.test(msg) ? h('p', h('a', { href: '#/ngo/claims' }, 'Go to My claims')) : null));
        err.hidden = false;
      }
    });
  });

  const gallery = photos.length
    ? h('div.ngo-gallery', { class: photos.length > 1 ? 'ngo-gallery--multi' : '' }, photos.map((p) => h('img', { src: photoUrl(p.file_path), alt: '', loading: 'lazy' })))
    : h('div.ngo-gallery.ngo-nophoto', icon('leaf', 48));
  const started = !inFuture(l.pickup_start);

  return h('section.app-narrow.ngo-listing',
    back,
    gallery,
    h('header.ngo-listing__head',
      h('h1.app-title', l.title),
      h('p.app-card__meta', h('span', l.vendor_name), l.vendor_sector ? h('span', l.vendor_sector) : null,
        l.distance_km !== null && l.distance_km !== undefined ? h('span', icon('pin', 16), `${Number(l.distance_km).toFixed(1)} km away`) : null,
        h('span.ngo-vbadge', icon('shield', 16), l.vendor_badge))),
    h('div.ngo-when-box', icon('clock', 22), h('div',
      h('p.ngo-when-box__main', timeLeft),
      h('p.app-muted', started ? `Pickup ${windowText(l.pickup_start, l.pickup_end)}` : `Pickup starts ${time(l.pickup_start)}. Window ${windowText(l.pickup_start, l.pickup_end)}`))),
    l.description ? h('p.ngo-desc', l.description) : null,
    chips(dietChips(l.dietary)),
    h('dl.key-facts.ngo-facts',
      fact('Quantity', `${Number(l.quantity)} ${l.unit}`),
      fact('Weight', `About ${Number(l.weight_kg)} kg`),
      fact('Feeds about', l.feeds_about ? `${l.feeds_about} people` : null),
      fact('Food', shortCategory(l.category_name)),
      fact('Storage', STORAGE[l.storage] || l.storage),
      fact('Safe until', dateTime(l.safe_until)),
      fact('Price', h('span', rs(l.price_rs), ' ', h('s.app-muted', rs(l.retail_value_rs)))),
      fact('Pickup address', 'Shown after you pay')),
    h('section.app-section.ngo-claim-box',
      pauseNotice(pause),
      l.can_claim ? null : notice('warning', 'There isn\'t enough time left to pay before pickup ends, so this can\'t be claimed.'),
      collector ? collector.wrap : h('p.app-muted', 'No collectors yet. ', link('/ngo/collectors', 'Add a collector'), ' so you can send them the pickup code.'),
      claimBtn,
      h('p.app-muted.ngo-claim-note', 'You pay the business directly or online after claiming. The address and pickup code appear once you have paid.'),
      err));
}

// ---------------------------------------------------------------------------
// One claim: pay, wait, collect, confirm
// ---------------------------------------------------------------------------
const ACTIVE = ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer', 'picked_up'];
const PROBLEM_KINDS = [
  { value: 'wrong_food', label: 'Not as described' },
  { value: 'short_handover', label: 'Less than we paid for' },
  { value: 'food_safety', label: 'Spoiled or unsafe' },
  { value: 'vendor_closed', label: 'Business was closed' },
  { value: 'not_ready', label: 'Food wasn\'t ready' },
  { value: 'payment', label: 'Payment problem' },
  { value: 'conduct', label: 'Behaviour' },
  { value: 'other', label: 'Something else' },
];

async function claimPage({ params, query }) {
  const token = begin();
  const id = params.id;
  const root = h('section.app-narrow.ngo-claim');
  let sig = '';
  let returning = query.payment === 'success' || query.payment === 'failed' ? query.payment : null;
  let countdownTimer = null;

  async function load() {
    const d = await rpc('order_details', { p_order: id });
    let pay = null;
    if (d.payment_mode === 'direct' && ['payment_due', 'payment_processing'].includes(d.status)) {
      pay = (await rpc('direct_payment_details', { p_order: id }))?.[0] || null;
    }
    const disputes = await select(db.from('disputes').select('id, kind, status, created_at').eq('order_id', id).order('created_at'));
    return { d, pay, disputes };
  }

  async function draw(force = false) {
    let data;
    try { data = await load(); } catch (e) { if (force) throw e; return; }
    if (!alive(token)) return;
    const s = JSON.stringify([data.d.status, data.d.paid_at, data.d.picked_up_at, data.d.completed_at, data.d.pickup_code, data.d.held_until,
      data.d.ngo_payment_reference, data.disputes.map((x) => x.id + x.status), returning]);
    if (!force && s === sig) return;
    sig = s;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (returning === 'success' && isPaid(data.d.status)) {
      returning = null;
      history.replaceState(null, '', location.pathname + location.search + '#/ngo/claims/' + id);
    }
    root.replaceChildren(...build(data));
  }

  const isPaid = (st) => ['paid', 'awaiting_collection_answer', 'picked_up', 'completed', 'completed_unconfirmed'].includes(st);

  function build({ d, pay, disputes }) {
    const l = d.listing;
    const out = [
      h('p.ngo-back', h('a', { href: '#/ngo/claims' }, icon('back', 18), 'My claims')),
      pageHead(l.title, `${d.vendor.name}${d.vendor.sector ? ', ' + d.vendor.sector : ''} · ${d.reference}`, badge(d.status)),
    ];

    if (d.status === 'payment_due' || (d.status === 'payment_processing' && d.payment_mode === 'payfast')) {
      if (returning === 'success') out.push(confirmingBox());
      else {
        if (returning === 'failed') out.push(notice('warning', 'The payment didn\'t go through. Nothing was taken. You can try again before the deadline.'));
        out.push(countdown(d.payment_deadline));
        out.push(d.payment_mode === 'direct' ? directPay(d, pay) : gatewayPay(d));
      }
    }
    if (d.status === 'payment_processing' && d.payment_mode === 'direct') out.push(waitingBox(d));
    if (['paid', 'awaiting_collection_answer'].includes(d.status)) out.push(...pickupSection(d));
    if (d.status === 'picked_up') out.push(receivedSection(d));
    if (['completed', 'completed_unconfirmed'].includes(d.status)) {
      out.push(notice('info', d.status === 'completed' ? 'Completed. Thanks for collecting this food.' : 'Completed. Nobody confirmed receipt within 48 hours, so it closed automatically.'));
    }
    const ended = endedText(d);
    if (ended) out.push(notice(d.status === 'released' || d.status === 'cancelled_by_ngo' ? 'info' : 'warning', ended));

    out.push(h('section.app-section', h('h2.app-h2', 'Details'), h('dl.key-facts',
      fact('Amount', rs(d.price_rs)),
      fact('Pickup', windowText(l.pickup_start, l.pickup_end)),
      fact('Quantity', `${Number(l.quantity)} ${l.unit}${d.quantity_handed_over !== null && d.quantity_handed_over !== undefined && Number(d.quantity_handed_over) !== Number(l.quantity) ? ` (handed over ${Number(d.quantity_handed_over)})` : ''}`),
      fact('Safe until', dateTime(l.safe_until)),
      fact('Claimed', dateTime(d.created_at)),
      fact('Paid', d.paid_at ? dateTime(d.paid_at) : null),
      fact('Your payment reference', d.ngo_payment_reference),
      fact('Collected', d.picked_up_at ? dateTime(d.picked_up_at) : null),
      fact('Business', `${d.vendor.name} (${d.vendor.badge})`),
      fact('Collector', d.collector ? `${d.collector.name}${d.collector.phone ? ', ' + phoneDisplay(d.collector.phone) : ''}` : 'Not chosen'))));

    if (disputes.length) {
      out.push(h('section.app-section', h('h2.app-h2', 'Problem reports'), h('ul.app-list', disputes.map((x) => h('li.app-list__item',
        h('div', h('p.app-list__title', PROBLEM_KINDS.find((k) => k.value === x.kind)?.label || x.kind.replace(/_/g, ' ')),
          h('p.app-list__meta', `Reported ${dateTime(x.created_at)} · ${x.status === 'decided' ? 'Decided' : x.status === 'awaiting_reply' ? 'Waiting for the business' : x.status === 'withdrawn' ? 'Withdrawn' : 'With our team'}`)),
        h('a.btn.btn--secondary.btn--sm', { href: '#/disputes/' + x.id }, 'Open'))))));
    }

    const actions = actionButtons(d);
    if (actions.length) out.push(h('section.app-section', h('h2.app-h2', 'Something changed?'), h('div.ngo-actions', actions)));
    return out;
  }

  // ----- Countdown to the payment deadline -----
  function countdown(deadline) {
    const value = h('span.app-countdown__value');
    const sr = h('span.visually-hidden', { 'aria-live': 'assertive' });
    const box = h('div.app-countdown.ngo-countdown', { role: 'timer' },
      h('div', h('p.ngo-countdown__label', 'Time left to pay'), h('p.ngo-countdown__sub', `Pay by ${time(deadline)}`)), value, sr);
    let announced = null;
    const tickFn = () => {
      const ms = new Date(deadline) - Date.now();
      if (ms <= 0) {
        value.textContent = '0:00';
        box.classList.add('ngo-countdown--critical');
        box.querySelector('.ngo-countdown__label').textContent = 'Payment time is up';
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        setTimeout(() => { if (alive(token)) draw(); }, 5000);
        return;
      }
      const total = Math.floor(ms / 1000);
      const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
      value.textContent = hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
      const mins = Math.ceil(ms / 60000);
      box.classList.toggle('ngo-countdown--warn', mins <= 5 && mins > 2);
      box.classList.toggle('ngo-countdown--critical', mins <= 2);
      if ([10, 5, 2, 1].includes(mins) && announced !== mins) { announced = mins; sr.textContent = `${mins} minute${mins > 1 ? 's' : ''} left to pay`; }
    };
    tickFn();
    countdownTimer = setInterval(() => { if (!alive(token)) { clearInterval(countdownTimer); return; } tickFn(); }, 1000);
    cleanups.push(() => clearInterval(countdownTimer));
    return box;
  }

  // ----- Direct payment (pilot): pay the business, then tell us the reference -----
  function directPay(d, pay) {
    if (!pay) return notice('warning', 'We couldn\'t load the business\'s payment details. Refresh the page or contact us.');
    const iban = pay.bank_iban ? pay.bank_iban.replace(/(.{4})/g, '$1 ').trim() : null;
    const ref = field({ name: 'reference', label: 'Transaction reference', required: true, autocomplete: 'off',
      placeholder: 'For example 0123456789', hint: 'The ID your banking app shows after the transfer.' });
    const submit = h('button.btn.btn--accent.btn--block', { type: 'submit' }, 'I\'ve paid');
    const form = h('form.app-form.card.ngo-paid-form', { novalidate: true }, h('h3.app-h2', 'Step 2: tell the business you paid'), ref.wrap, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (ref.value().length < 4) { ref.error('Enter the transaction reference from your banking app.'); ref.input.focus(); return; }
      busy(submit, async () => {
        await rpc('ngo_mark_paid', { p_order: d.id, p_reference: ref.value() });
        toast('Thanks. The business will confirm when the money arrives.');
        await draw(true);
      });
    });
    return h('div.ngo-pay',
      h('div.card.ngo-pay__card',
        h('h3.app-h2', 'Step 1: send the payment'),
        h('p.app-muted', 'Send exactly this amount from your bank or wallet app, by Raast or bank transfer, to the business.'),
        h('p.ngo-pay__amount', rs(pay.amount_rs)),
        h('dl.ngo-pay__list',
          copyRow('Raast ID', pay.raast_id),
          pay.bank_account_title ? h('div.ngo-pay__row', h('dt', 'Account title'), h('dd', h('span.ngo-pay__value', pay.bank_account_title))) : null,
          copyRow('IBAN', iban, pay.bank_iban),
          copyRow('Payment note', pay.reference)),
        h('p.app-muted', `Put ${pay.reference} in the payment note so the business can match your payment.`)),
      form);
  }

  function copyRow(label, shown, raw) {
    if (!shown) return null;
    const btn = h('button.btn.btn--secondary.btn--sm.ngo-copy', { type: 'button', 'aria-label': `Copy ${label}` }, 'Copy');
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(raw || shown); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
      catch { toast('Copying didn\'t work. Press and hold the text to copy it.', 'error'); }
    });
    return h('div.ngo-pay__row', h('dt', label), h('dd', h('span.ngo-pay__value', shown), btn));
  }

  function waitingBox(d) {
    return h('div.ngo-wait', { role: 'status' },
      h('span.activity', { 'aria-hidden': 'true' }),
      h('div', h('p.ngo-wait__title', 'Waiting for the business to confirm'),
        h('p.app-muted', `You told us you paid ${rs(d.price_rs)} with reference ${d.ngo_payment_reference || ''}. Your pickup code appears here as soon as the business confirms the money arrived. You can leave this page.`)));
  }

  // ----- Gateway payment (PayFast) -----
  function gatewayPay(d) {
    const btn = h('button.btn.btn--accent.btn--block', { type: 'button' }, `Pay ${rs(d.price_rs)}`);
    btn.addEventListener('click', () => busy(btn, async () => {
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new AppError('Your session has ended. Please sign in again.');
      const res = await fetch(`${config.supabaseUrl}/functions/v1/payfast-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: config.supabaseAnonKey },
        body: JSON.stringify({ order_id: d.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.action) throw new AppError(body.error || 'The payment service is not responding. Please try again in a minute.');
      const form = h('form', { method: 'POST', action: body.action, hidden: true },
        Object.entries(body.fields || {}).map(([k, v]) => h('input', { type: 'hidden', name: k, value: String(v ?? '') })));
      document.body.append(form);
      form.submit();
      await new Promise(() => {}); // keep the button busy while the browser leaves
    }));
    return h('div.card.ngo-pay__card',
      h('p.ngo-pay__amount', rs(d.price_rs)),
      h('p.app-muted', 'Pay by Raast, bank account, JazzCash, Easypaisa or card on PayFast\'s secure page. You come back here afterwards.'),
      btn);
  }

  function confirmingBox() {
    return h('div.ngo-wait', { role: 'status' }, h('span.activity', { 'aria-hidden': 'true' }),
      h('div', h('p.ngo-wait__title', 'Confirming payment'),
        h('p.app-muted', 'We\'re checking with the payment service. This usually takes under a minute. Your pickup code appears here once it is confirmed.')));
  }

  // ----- Paid: the pickup code and where to go -----
  function pickupSection(d) {
    const l = d.listing, v = d.vendor;
    const mapUrl = v.lat && v.lng ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((v.address || '') + ', Islamabad')}`;
    const when = h('span');
    const tickWhen = () => {
      when.textContent = inFuture(l.pickup_start) ? `Pickup starts in ${untilText(l.pickup_start)} (${time(l.pickup_start)})` : endsText(l.pickup_end);
    };
    tickWhen();
    every(token, 15000, tickWhen);
    const share = [
      `Rizq Rasan pickup for ${state.org.name}`,
      `Pickup code: ${d.pickup_code}`,
      `Food: ${l.title}`,
      `Where: ${v.name}, ${v.address || ''}${v.sector ? ' (' + v.sector + ')' : ''}`,
      `When: ${windowText(l.pickup_start, l.pickup_end)}`,
      v.phone ? `Business phone: ${phoneDisplay(v.phone)}` : null,
      `Map: ${mapUrl}`,
      'Show the code at the counter. Check the food before you take it.',
    ].filter(Boolean).join('\n');
    return [
      d.status === 'awaiting_collection_answer' ? notice('warning', 'The pickup window has ended. The business has been asked whether you collected. If you did, nothing more is needed.') : null,
      h('div.app-code.ngo-code', h('p.app-code__label', 'Pickup code'), h('p.app-code__value', { 'aria-label': 'Pickup code ' + String(d.pickup_code).split('').join(' ') }, d.pickup_code),
        h('p.ngo-code__hint', 'Show this at the counter. The business types it in to hand over the food.')),
      h('div.ngo-when-box', icon('clock', 22), h('div', h('p.ngo-when-box__main', when), h('p.app-muted', `Collect between ${windowText(l.pickup_start, l.pickup_end)}`))),
      h('section.app-section.ngo-where',
        h('h2.app-h2', 'Where to collect'),
        h('div.card.ngo-where__card',
          h('p.ngo-where__name', v.name),
          h('p.ngo-where__address', v.address || 'Address not given', v.sector ? h('span.app-muted', ', ' + v.sector) : null),
          v.pickup_instructions ? h('p.app-muted', v.pickup_instructions) : null,
          l.instructions ? h('p.app-muted', l.instructions) : null,
          h('div.ngo-where__actions',
            h('a.btn.btn--primary.btn--sm', { href: mapUrl, target: '_blank', rel: 'noopener' }, icon('pin', 18), 'Open in Google Maps'),
            v.phone ? h('a.btn.btn--secondary.btn--sm', { href: 'tel:' + v.phone }, icon('phone', 18), `Call ${phoneDisplay(v.phone)}`) : null))),
      h('section.app-section.ngo-collector',
        h('h2.app-h2', 'Collector'),
        h('p', d.collector ? `${d.collector.name}${d.collector.phone ? ', ' + phoneDisplay(d.collector.phone) : ''}` : 'No collector chosen. Send the code to whoever will collect.'),
        h('a.btn.btn--secondary.ngo-wa', { href: 'https://wa.me/?text=' + encodeURIComponent(share), target: '_blank', rel: 'noopener' }, 'Send to collector on WhatsApp')),
    ];
  }

  function receivedSection(d) {
    const btn = h('button.btn.btn--primary.btn--block', { type: 'button' }, 'Confirm we received it');
    btn.addEventListener('click', () => busy(btn, async () => {
      await rpc('ngo_confirm_receipt', { p_order: d.id });
      toast('Thanks. This order is complete.');
      await draw(true);
    }));
    return h('div.card.ngo-received',
      h('h2.app-h2', 'Did you receive everything?'),
      h('p.app-muted', `Handed over at ${dateTime(d.picked_up_at)}. If something is wrong, report it within 24 hours. Otherwise the order completes on its own.`),
      btn);
  }

  function endedText(d) {
    const direct = d.payment_mode === 'direct';
    switch (d.status) {
      case 'released': return 'You released this claim before paying. Nothing was charged and the food went back to other organisations.';
      case 'expired_unpaid': return 'The payment time ran out, so the food went back to other organisations. Three unpaid claims in 7 days pause claiming for 24 hours.';
      case 'cancelled_by_ngo': return direct ? 'You cancelled in good time. The business should return your payment. Contact us if it hasn\'t arrived within 1 working day.'
        : 'You cancelled in good time. Your full refund is on its way.';
      case 'cancelled_by_vendor': return `The business cancelled this order${d.ended_reason ? ': ' + d.ended_reason : ''}. ` + (d.paid_at
        ? (direct ? 'They must return your payment. Contact us if they don\'t within 1 working day.' : 'You will get a full refund.') : 'Nothing was charged.');
      case 'refused_at_pickup': return 'You refused this food at pickup as unsafe. Our team reviews it within 24 hours and you get a full refund if it is upheld.';
      case 'no_show': return `${d.ended_reason || 'Marked as not collected'}. Payments are not refunded for no-shows. If this is wrong, report a problem within 24 hours.`;
      default: return null;
    }
  }

  // ----- Actions -----
  function actionButtons(d) {
    const out = [];
    const l = d.listing;
    if (d.status === 'payment_due') {
      const b = h('button.btn.btn--secondary', { type: 'button' }, 'Release this claim');
      b.addEventListener('click', async () => {
        const ok = await dialog({ title: 'Release this claim?', text: 'The food goes back to other organisations. You haven\'t paid, so nothing is charged.', confirm: 'Release claim', danger: true });
        if (!ok) return;
        busy(b, async () => { await rpc('release_claim', { p_order: d.id }); toast('Claim released.'); await draw(true); });
      });
      out.push(b);
    }
    if (['paid', 'payment_processing'].includes(d.status)) {
      const b = h('button.btn.btn--secondary', { type: 'button' }, 'Cancel claim');
      b.addEventListener('click', async () => {
        const mins = minutesLeft(l.pickup_start);
        const late = mins < 60;
        const ok = await dialog(late ? {
          title: 'Cancel this late?',
          text: `Pickup ${mins > 0 ? 'starts in ' + untilText(l.pickup_start) : 'has already started'}. Cancelling within 60 minutes of pickup counts as a no-show: you won't get a refund, the business is still paid, and your organisation gets a strike.`,
          confirm: 'Cancel without refund', cancel: 'Keep my claim', danger: true,
        } : {
          title: 'Cancel this claim?',
          text: d.payment_mode === 'direct' ? 'Pickup is more than 60 minutes away, so the business will return your payment in full.' : 'Pickup is more than 60 minutes away, so you get a full refund.',
          confirm: 'Cancel claim', cancel: 'Keep my claim', danger: true,
        });
        if (!ok) return;
        busy(b, async () => {
          const r = await rpc('ngo_cancel_order', { p_order: d.id });
          toast(r === 'cancelled_no_refund' ? 'Cancelled. This counts as a no-show.' : 'Cancelled.');
          await draw(true);
        });
      });
      out.push(b);
    }
    if (['paid', 'awaiting_collection_answer'].includes(d.status)) {
      const b = h('button.btn.btn--secondary', { type: 'button' }, 'Refuse unsafe food');
      b.addEventListener('click', async () => {
        const v = await dialog({
          title: 'Refuse unsafe food?',
          text: 'Only refuse food that looks, smells or feels unsafe. Don\'t take it. You get a full refund and our team checks it within 24 hours.',
          confirm: 'Refuse food', danger: true,
          fields: [{ name: 'details', label: 'What is wrong with it?', type: 'textarea', required: true, placeholder: 'Sour smell, mould on the bread' }],
        });
        if (!v) return;
        if (v.details.length < 5) { toast('Describe what is wrong in a few words.', 'error'); return; }
        busy(b, async () => { await rpc('refuse_at_pickup', { p_order: d.id, p_details: v.details }); toast('Food refused. Our team will review it.'); await draw(true); });
      });
      out.push(b);
    }
    if (['paid', 'awaiting_collection_answer', 'picked_up', 'completed', 'completed_unconfirmed', 'no_show', 'cancelled_by_vendor'].includes(d.status)) {
      const b = h('button.btn.btn--secondary', { type: 'button' }, 'Report a problem');
      b.addEventListener('click', async () => {
        const v = await dialog({
          title: 'Report a problem',
          text: 'Tell us what went wrong. The business can reply, and our team decides within 48 hours (24 hours for food safety). If someone may be ill from the food, call 1122 first.',
          confirm: 'Send report',
          fields: [
            { name: 'kind', label: 'What went wrong?', type: 'select', required: true, options: PROBLEM_KINDS },
            { name: 'details', label: 'Details', type: 'textarea', required: true, rows: 4, placeholder: 'What happened, and how much you received' },
          ],
        });
        if (!v) return;
        if (v.details.length < 10) { toast('Describe what went wrong in a sentence or two.', 'error'); return; }
        busy(b, async () => {
          const disputeId = await rpc('report_problem', { p_order: d.id, p_kind: v.kind, p_details: v.details });
          toast('Problem reported.');
          go('/disputes/' + disputeId);
        });
      });
      out.push(b);
    }
    return out;
  }

  await draw(true);
  liveOrder(token, id, () => draw());
  // Fallback for weak connections: check again now and then while the claim is moving.
  every(token, 15000, () => { if (ACTIVE.includes(JSON.parse(sig || '[]')[0])) draw(); });
  if (returning === 'success') every(token, 3000, () => draw());
  onWindow(token, 'focus', () => draw());
  return root;
}

// ---------------------------------------------------------------------------
// My claims
// ---------------------------------------------------------------------------
const GROUPS = [
  { id: 'pay', label: 'To pay', statuses: ['payment_due', 'payment_processing'] },
  { id: 'collect', label: 'To collect', statuses: ['paid', 'awaiting_collection_answer'] },
  { id: 'done', label: 'Done', statuses: ['picked_up', 'completed', 'completed_unconfirmed', 'released', 'expired_unpaid', 'cancelled_by_ngo', 'cancelled_by_vendor'] },
  { id: 'problems', label: 'Problems', statuses: ['refused_at_pickup', 'no_show'] },
];

async function claims() {
  begin();
  const [rows, disputes] = await Promise.all([
    select(db.from('orders').select('id, status, price_rs, payment_deadline, created_at, listing_id, listings(title, pickup_start, pickup_end)')
      .eq('ngo_id', state.org.id).order('created_at', { ascending: false }).limit(200)),
    select(db.from('disputes').select('order_id, status').eq('raised_by_org', state.org.id)),
  ]);
  const withProblem = new Set(disputes.filter((x) => ['open', 'awaiting_reply'].includes(x.status)).map((x) => x.order_id));
  const groupOf = (o) => (withProblem.has(o.id) ? 'problems' : GROUPS.find((g) => g.statuses.includes(o.status))?.id || 'done');
  const by = Object.fromEntries(GROUPS.map((g) => [g.id, rows.filter((o) => groupOf(o) === g.id)]));
  let active = store.get('rr-ngo-claims-tab') || GROUPS.find((g) => by[g.id].length)?.id || 'pay';
  if (!GROUPS.some((g) => g.id === active)) active = 'pay';

  const host = h('div');
  const draw = () => {
    store.set('rr-ngo-claims-tab', active);
    const list = by[active];
    const emptyText = {
      pay: ['Nothing to pay', 'Claims waiting for payment show here.'],
      collect: ['Nothing to collect', 'Paid claims with a pickup code show here.'],
      done: ['Nothing done yet', 'Collected, released and cancelled claims show here.'],
      problems: ['No problems', 'Refused food, no-shows and problem reports show here.'],
    }[active];
    host.replaceChildren(
      tabs(GROUPS.map((g) => ({ id: g.id, label: g.label, count: by[g.id].length })), active, (t) => { active = t; draw(); }),
      list.length ? h('ul.app-list.ngo-claims', list.map(row))
        : empty(emptyText[0], emptyText[1], active === 'pay' || active === 'collect' ? h('a.btn.btn--primary', { href: '#/ngo' }, 'Find food') : null));
  };
  draw();
  return h('section.app-narrow', pageHead('My claims', 'Everything you have claimed, newest first.'), host);
}

function row(o) {
  const l = o.listings || {};
  const meta = o.status === 'payment_due' ? `Pay by ${time(o.payment_deadline)}`
    : ['paid', 'awaiting_collection_answer'].includes(o.status) ? `Collect ${windowText(l.pickup_start, l.pickup_end)}`
    : `Claimed ${dateTime(o.created_at)}`;
  return h('li', h('a.app-list__item.ngo-claim-row', { href: '#/ngo/claims/' + o.id },
    h('div', h('p.app-list__title', l.title || 'Claim'), h('p.app-list__text', `${rs(o.price_rs)} · ${meta}`)),
    badge(o.status)));
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------
const MAX_COLLECTORS = 5;

async function collectors({ app }) {
  begin();
  const rows = await select(db.from('collectors').select('*').eq('organisation_id', state.org.id).order('active', { ascending: false }).order('created_at'));
  const activeCount = rows.filter((c) => c.active).length;
  const full = activeCount >= MAX_COLLECTORS;

  const name = field({ name: 'name', label: 'Name', required: true, autocomplete: 'off' });
  const phone = field({ name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', placeholder: '0300 1234567', autocomplete: 'off' });
  const add = h('button.btn.btn--primary', { type: 'submit', disabled: full }, 'Add collector');
  const form = h('form.app-form.card', { novalidate: true },
    h('div.form__grid', name.wrap, phone.wrap),
    full ? h('p.app-muted', `You have ${MAX_COLLECTORS} active collectors, the most allowed. Deactivate one to add someone new.`) : null,
    add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (full) return;
    if (name.value().length < 2) { name.error('Enter their name.'); return; }
    const tel = normalisePhone(phone.value());
    if (!tel) { phone.error('Enter a Pakistani mobile number, like 0300 1234567.'); return; }
    if (rows.some((c) => c.active && c.phone === tel)) { phone.error('This number is already one of your collectors.'); return; }
    busy(add, async () => {
      const { error } = await db.from('collectors').insert({ organisation_id: state.org.id, name: name.value(), phone: tel });
      if (error) throw new AppError(/row-level security/i.test(error.message) ? `You can have up to ${MAX_COLLECTORS} active collectors.` : friendly(error));
      toast(`${name.value()} added.`);
      app.refresh();
    });
  });

  const list = rows.length ? h('ul.app-list.ngo-collectors', rows.map((c) => {
    const toggle = h('button.btn.btn--secondary.btn--sm', { type: 'button' }, c.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', () => {
      if (!c.active && full) { toast(`You already have ${MAX_COLLECTORS} active collectors. Deactivate one first.`, 'error'); return; }
      busy(toggle, async () => {
        const { error } = await db.from('collectors').update({ active: !c.active }).eq('id', c.id);
        if (error) throw error;
        toast(c.active ? `${c.name} deactivated.` : `${c.name} reactivated.`);
        app.refresh();
      });
    });
    const remove = h('button.btn.btn--secondary.btn--sm.ngo-remove', { type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => {
      const ok = await dialog({ title: `Remove ${c.name}?`, text: 'They won\'t be offered as a collector any more.', confirm: 'Remove', danger: true });
      if (!ok) return;
      busy(remove, async () => {
        const { data, error } = await db.from('collectors').delete().eq('id', c.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new AppError(`${c.name} is on past claims, so they can't be removed. Deactivate them instead.`);
        toast(`${c.name} removed.`);
        app.refresh();
      });
    });
    return h('li.app-list__item.ngo-collector', { class: c.active ? '' : 'is-inactive' },
      h('div', h('p.app-list__title', c.name, ' ', c.active ? null : h('span.badge.badge--muted', 'Inactive')), h('p.app-list__text', phoneDisplay(c.phone))),
      h('div.ngo-collector__actions', toggle, remove));
  })) : empty('No collectors yet', 'Add the people who pick up food for you. You can send them the pickup code by WhatsApp.');

  return h('section.app-narrow',
    pageHead('Collectors', `The drivers and volunteers who pick up food for you. Up to ${MAX_COLLECTORS} at a time.`),
    h('section.app-section', h('h2.app-h2', `Your collectors (${activeCount} of ${MAX_COLLECTORS} active)`), list),
    h('section.app-section', h('h2.app-h2', 'Add a collector'), form));
}
