// Admin screens: queues, verification, organisations, orders, problems, payments, payouts, settings and the audit log.
// Every change goes through an admin_* database function, which checks admin rights and writes the audit log.
import {
  db, state, h, field, dialog, busy, toast, rpc, select, pageHead, notice, empty, badge, icon, link, go,
  rs, dateTime, date, untilText, minutesLeft, statusLabel, phoneDisplay, AppError, friendly,
} from './core.js';
import { DOC_LABELS } from './onboarding.js';

export function routes(register) {
  const r = (path, title, render) => register(path, { title, roles: ['admin'], render });
  r('/admin', 'Overview', overview);
  r('/admin/verifications', 'Verifications', verifications);
  r('/admin/organisations', 'Organisations', organisations);
  r('/admin/organisations/:id', 'Organisation', organisation);
  r('/admin/orders', 'Orders', orders);
  r('/admin/orders/:id', 'Order', order);
  r('/admin/disputes', 'Problems', disputes);
  r('/admin/disputes/:id', 'Problem report', dispute);
  r('/admin/payments', 'Payments', payments);
  r('/admin/payouts', 'Payouts', payouts);
  r('/admin/payouts/:id', 'Payout batch', payout);
  r('/admin/settings', 'Settings', settings);
  r('/admin/audit', 'Audit log', audit);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const ORDER_COLS = 'id, listing_id, vendor_id, ngo_id, status, payment_mode, price_rs, commission_rs, vendor_share_rs, payment_deadline, held_until, ngo_payment_reference, ngo_marked_paid_at, paid_at, quantity_handed_over, picked_up_at, completed_at, collection_asked_at, ended_at, ended_reason, created_at';
const ORDER_STATUSES = ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer', 'picked_up', 'completed', 'completed_unconfirmed',
  'expired_unpaid', 'released', 'cancelled_by_ngo', 'cancelled_by_vendor', 'refused_at_pickup', 'no_show'];
const ACTIVE = ['payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer', 'picked_up'];
const ENDED = ['completed', 'completed_unconfirmed', 'expired_unpaid', 'released', 'cancelled_by_ngo', 'cancelled_by_vendor', 'refused_at_pickup', 'no_show'];
const ORG_STATUSES = ['onboarding', 'pending_review', 'needs_changes', 'approved', 'rejected', 'suspended', 'removed'];
const DISPUTE_KINDS = { food_safety: 'Food safety', short_handover: 'Less than listed', vendor_closed: 'Business closed', not_ready: 'Food not ready',
  wrong_food: 'Not as described', payment: 'Payment problem', conduct: 'Behaviour', other: 'Other' };
const TIER_TEXT = { A: 'Tier A (trusted)', B: 'Tier B (established)', C: 'Tier C (new)' };

const ref = (id) => 'RR-' + String(id).slice(0, 8).toUpperCase();
const typeLabel = (t) => (t === 'vendor' ? 'Business' : 'NGO');
const iban = (v) => (v ? String(v).replace(/(.{4})/g, '$1 ').trim() : '');
const humanKey = (k) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ').replace(/\brs\b/, '(Rs)').replace(/\bkm\b/, '(km)');
const pktDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(d);

// "12 min", "3 h", "2 days" since a time.
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} days`;
}

const tone = (kind, text) => h('span.badge', { class: 'badge--' + kind }, text);
const statusBadge = (s) => badge(s);

async function profileNames(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await select(db.from('profiles').select('id, full_name, phone').in('id', list));
  const out = Object.fromEntries(rows.map((p) => [p.id, p.full_name || 'Unnamed admin']));
  if (state.user && out[state.user.id] !== undefined) out[state.user.id] += ' (you)';
  return out;
}
async function orgNames(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await select(db.from('organisations').select('id, name, type').in('id', list));
  return Object.fromEntries(rows.map((o) => [o.id, o]));
}

// One row in a list: the whole row is a link.
function row(href, { title, text, meta, end, cls }) {
  return h('li', h('a.adm-row', { href: '#' + href, class: cls || '' },
    h('div.adm-row__main', h('p.adm-row__title', title), text ? h('p.adm-row__text', text) : null, meta ? h('p.adm-row__meta', meta) : null),
    end ? h('div.adm-row__end', end) : null));
}
const rows = (items, emptyNode) => (items.length ? h('ul.adm-rows', items) : emptyNode);

function facts(pairs) {
  return h('dl.adm-facts', pairs.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => h('div', h('dt', k), h('dd', v))));
}

function section(title, ...children) { return h('section.app-section', h('h2.app-h2', title), ...children); }
const backLink = (path, text) => h('p.adm-back', h('a.text-link', { href: '#' + path }, icon('back', 18), text));

// Ask for a reason, then run fn(reason). Returns true when done.
async function withReason(btn, { title, text, confirm, label = 'Reason', hint, danger = true, required = true }, fn) {
  const v = await dialog({ title, text, confirm, danger, fields: [{ name: 'reason', label, type: 'textarea', required, hint }] });
  if (!v) return false;
  let done = false;
  await busy(btn, async () => { await fn(v.reason); done = true; });
  return done;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function queue(q, at = 'created_at') {
  const { data, count, error } = await q.order(at, { ascending: true }).limit(1000);
  if (error) throw new AppError(friendly(error));
  return { count: count ?? data.length, oldest: data[0]?.[at], rows: data };
}

async function overview() {
  const [apps, problems, safety, unpaid, direct, refunds, lines, mismatches, impact] = await Promise.all([
    queue(db.from('organisations').select('created_at', { count: 'exact' }).eq('status', 'pending_review')),
    queue(db.from('disputes').select('created_at', { count: 'exact' }).in('status', ['open', 'awaiting_reply'])),
    queue(db.from('disputes').select('created_at', { count: 'exact' }).in('status', ['open', 'awaiting_reply']).eq('kind', 'food_safety')),
    queue(db.from('orders').select('created_at', { count: 'exact' }).eq('status', 'payment_due')),
    queue(db.from('orders').select('ngo_marked_paid_at', { count: 'exact' }).eq('status', 'payment_processing').eq('payment_mode', 'direct'), 'ngo_marked_paid_at'),
    queue(db.from('refunds').select('created_at, amount_rs', { count: 'exact' }).eq('status', 'pending_approval')),
    queue(db.from('payout_lines').select('created_at, net_rs', { count: 'exact' }).eq('status', 'eligible')),
    queue(db.from('payment_events').select('received_at', { count: 'exact' }).eq('result', 'amount_mismatch'), 'received_at'),
    rpc('impact_totals'),
  ]);
  const sum = (q, k) => q.rows.reduce((a, r) => a + (r[k] || 0), 0);
  const tiles = [
    ['/admin/verifications', apps, 'Applications waiting for review', 'Target: 2 working days'],
    ['/admin/disputes', problems, 'Open problem reports', 'Decide within 48 hours'],
    ['/admin/disputes', safety, 'Food safety reports', 'Decide within 24 hours', 'bad'],
    ['/admin/orders?status=payment_due', unpaid, 'Unpaid claims', 'They expire on their own at the deadline'],
    ['/admin/orders?status=payment_processing&mode=direct', direct, 'Direct payments waiting for the business', 'Phone the business after 15 min'],
    ['/admin/payments?tab=refunds', refunds, 'Refunds needing a second admin', refunds.count ? rs(sum(refunds, 'amount_rs')) + ' in total' : null],
    ['/admin/payouts', lines, 'Payout lines ready for a batch', lines.count ? rs(sum(lines, 'net_rs')) + ' to pay' : null],
    ['/admin/payments?tab=mismatches', mismatches, 'Payment amount mismatches', 'Check against PayFast', 'bad'],
  ];
  const queues = h('div.adm-queues', tiles.map(([href, q, label, hint, alert]) => h('a.adm-queue', {
    href: '#' + href, class: q.count ? (alert ? 'adm-queue--alert' : 'adm-queue--busy') : 'adm-queue--clear',
  },
  h('span.adm-queue__value', String(q.count)),
  h('span.adm-queue__label', label),
  h('span.adm-queue__meta', q.count && q.oldest ? `Oldest ${ago(q.oldest)}` : q.count ? '' : 'Nothing waiting'),
  hint && q.count ? h('span.adm-queue__hint', hint) : null)));

  const totals = h('div.app-stats',
    [[Number(impact.kg_rescued).toLocaleString('en-US') + ' kg', 'Food rescued'], [Number(impact.meals).toLocaleString('en-US'), 'Meals'],
      [Number(impact.co2e_kg).toLocaleString('en-US') + ' kg', 'CO2e avoided'], [rs(impact.rupees_saved), 'Saved by NGOs'],
      [String(impact.orders), 'Completed orders'], [String(impact.active_partners), 'Approved partners']]
      .map(([v, l]) => h('div.app-stat', h('div.app-stat__value', v), h('div.app-stat__label', l))));

  const waiting = tiles.reduce((a, [, q]) => a + q.count, 0);
  return h('section',
    pageHead('Overview', waiting ? 'Work through the queues from the top. Each one opens its screen.' : 'Every queue is clear.',
      h('a.btn.btn--secondary.btn--sm', { href: '#/admin/audit' }, 'Audit log')),
    h('h2.app-h2', 'Queues'), queues,
    section('Impact so far', h('p.app-muted', 'Worked out from completed orders.'), totals));
}

// ---------------------------------------------------------------------------
// Verifications
// ---------------------------------------------------------------------------
async function verifications({ query }) {
  const tab = query.tab === 'changes' ? 'changes' : 'review';
  const all = await select(db.from('organisations').select('id, name, type, business_kind, sector, status, status_reason, created_at, documents(count)')
    .in('status', ['pending_review', 'needs_changes']).order('created_at', { ascending: true }));
  const list = all.filter((o) => o.status === (tab === 'review' ? 'pending_review' : 'needs_changes'));
  const counts = { review: all.filter((o) => o.status === 'pending_review').length, changes: all.filter((o) => o.status === 'needs_changes').length };
  return h('section',
    pageHead('Verifications', 'Oldest first. Check the details against the documents, then decide.'),
    tabs2([['review', 'Waiting for review', counts.review], ['changes', 'Waiting for changes', counts.changes]], tab, (id) => go('/admin/verifications' + (id === 'changes' ? '?tab=changes' : ''))),
    rows(list.map((o) => row('/admin/organisations/' + o.id, {
      title: o.name,
      text: [typeLabel(o.type), o.business_kind, o.sector].filter(Boolean).join(' · '),
      meta: tab === 'review' ? `Started ${ago(o.created_at)} ago · ${o.documents?.[0]?.count ?? 0} documents` : 'Asked for: ' + (o.status_reason || 'changes'),
      end: [h('span.chip', typeLabel(o.type)), icon('arrow', 18)],
    })), empty(tab === 'review' ? 'No applications waiting' : 'Nobody is making changes', tab === 'review' ? 'New applications show up here when they are submitted.' : null)));
}

function tabs2(items, active, onChange) {
  const bar = h('div.app-tabs', { role: 'tablist' });
  for (const [id, label, count] of items) {
    bar.append(h('button.app-tab', { type: 'button', role: 'tab', 'aria-selected': id === active ? 'true' : 'false', onclick: () => onChange(id) },
      label, count !== undefined ? h('span.app-tab__count', String(count)) : null));
  }
  return bar;
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------
async function organisations({ query }) {
  const f = {
    q: field({ name: 'q', label: 'Search by name', type: 'search', value: query.q || '', placeholder: 'Bakery, kitchen...' }),
    type: field({ name: 'type', label: 'Type', type: 'select', value: query.type || '', placeholder: 'All types', options: [{ value: 'vendor', label: 'Businesses' }, { value: 'ngo', label: 'NGOs' }] }),
    status: field({ name: 'status', label: 'Status', type: 'select', value: query.status || '', placeholder: 'All statuses', options: ORG_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })) }),
  };
  const results = h('div.adm-results');
  let token = 0;
  async function load() {
    const t = ++token;
    let q = db.from('organisations').select('id, name, type, status, sector, tier, business_kind, created_at').order('name').limit(200);
    if (f.q.value()) q = q.ilike('name', `%${f.q.value().replace(/[%_,()]/g, ' ')}%`);
    if (f.type.value()) q = q.eq('type', f.type.value());
    if (f.status.value()) q = q.eq('status', f.status.value());
    const params = new URLSearchParams(Object.entries({ q: f.q.value(), type: f.type.value(), status: f.status.value() }).filter(([, v]) => v));
    history.replaceState(null, '', '#/admin/organisations' + (params.toString() ? '?' + params : ''));
    try {
      const list = await select(q);
      if (t !== token) return;
      results.replaceChildren(
        h('p.app-muted.adm-count', { role: 'status' }, list.length === 200 ? 'Showing the first 200. Narrow the search.' : `${list.length} organisation${list.length === 1 ? '' : 's'}`),
        rows(list.map((o) => row('/admin/organisations/' + o.id, {
          title: o.name,
          text: [typeLabel(o.type), o.business_kind, o.sector, o.type === 'ngo' && o.tier ? 'Tier ' + o.tier : null].filter(Boolean).join(' · '),
          meta: 'Joined ' + date(o.created_at),
          end: statusBadge(o.status),
        })), empty('No organisations match', 'Try a shorter name or clear the filters.')));
    } catch (e) { results.replaceChildren(notice('warning', friendly(e))); }
  }
  let timer;
  f.q.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  f.type.input.addEventListener('change', load);
  f.status.input.addEventListener('change', load);
  const form = h('form.app-filters.adm-filters', { role: 'search', onsubmit: (e) => { e.preventDefault(); load(); } }, f.q.wrap, f.type.wrap, f.status.wrap);
  await load();
  return h('section', pageHead('Organisations', 'Every business and NGO. Open one to see its documents, strikes and orders.'), form, results);
}

async function organisation({ params, app }) {
  const o = await select(db.from('organisations').select('*').eq('id', params.id).maybeSingle());
  if (!o) return empty('Organisation not found', null, link('/admin/organisations', 'Back to organisations'));
  const [members, docs, strikes, score, recent] = await Promise.all([
    select(db.from('memberships').select('user_id, role, created_at').eq('organisation_id', o.id)),
    select(db.from('documents').select('*').eq('organisation_id', o.id).order('created_at', { ascending: false })),
    select(db.from('strikes').select('*').eq('organisation_id', o.id).order('created_at', { ascending: false })),
    rpc('reliability_score', { p_org: o.id }),
    select(db.from('orders').select('id, status, price_rs, created_at, listings(title)').or(`vendor_id.eq.${o.id},ngo_id.eq.${o.id}`).order('created_at', { ascending: false }).limit(10)),
  ]);
  const people = members.length ? await select(db.from('profiles').select('id, full_name, phone').in('id', members.map((m) => m.user_id))) : [];
  const docLabels = DOC_LABELS;
  const activeStrikes = strikes.filter((s) => !s.forgiven_at && new Date(s.expires_at) > new Date());

  // Details
  const details = facts([
    ['Type', typeLabel(o.type) + (o.business_kind ? ' · ' + o.business_kind : '')],
    ['Registered name', o.legal_name], ['Registration', [o.registration_kind, o.registration_number].filter(Boolean).join(' ')], ['NTN', o.ntn],
    ['Phone', phoneDisplay(o.phone)], ['Email', o.email], ['Address', o.address], ['Area', o.sector],
    ['Map pin', o.lat ? h('a', { href: `https://www.google.com/maps?q=${o.lat},${o.lng}`, target: '_blank', rel: 'noopener' }, `${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}`) : 'Not set'],
    ['Pickup instructions', o.pickup_instructions], ['People served each day', o.people_served_per_day],
    ['Raast ID', o.raast_id], ['Account title', o.bank_account_title], ['IBAN', iban(o.bank_iban)],
    ['Trust tier', o.type === 'ngo' ? TIER_TEXT[o.tier] || 'Not set' : null],
    ['Joined', dateTime(o.created_at)], ['Approved', o.approved_at ? dateTime(o.approved_at) : null],
    ['Frozen until', o.frozen_until && new Date(o.frozen_until) > new Date() ? dateTime(o.frozen_until) : null],
    ['Claims paused until', o.claims_paused_until && new Date(o.claims_paused_until) > new Date() ? dateTime(o.claims_paused_until) : null],
    ['Payouts paused until', o.payouts_paused_until && new Date(o.payouts_paused_until) > new Date() ? dateTime(o.payouts_paused_until) : null],
  ]);

  // Decision buttons depend on the status.
  const act = (label, cls, fn) => { const b = h('button.btn', { type: 'button', class: cls }, label); b.addEventListener('click', () => fn(b)); return b; };
  const setStatus = async (btn, status, reason, tier) => {
    await busy(btn, async () => {
      await rpc('admin_set_org_status', { p_org: o.id, p_status: status, p_reason: reason || null, p_tier: tier || null });
      toast({ approved: 'Approved. They have been told.', needs_changes: 'Sent back for changes.', rejected: 'Application rejected.', suspended: 'Suspended. Live listings were removed.' }[status] || 'Status changed.');
      app.refresh();
    });
  };
  const approve = async (btn, restore = false) => {
    if (o.type === 'ngo' && !restore) {
      const v = await dialog({ title: `Approve ${o.name}`, text: 'New NGOs usually start in Tier C. Choose a higher tier only if you have checked their track record.', confirm: 'Approve',
        fields: [{ name: 'tier', label: 'Trust tier', type: 'select', required: true, value: o.tier || 'C', options: ['C', 'B', 'A'].map((t) => ({ value: t, label: TIER_TEXT[t] })) }] });
      if (v) await setStatus(btn, 'approved', null, v.tier);
      return;
    }
    const ok = await dialog({ title: restore ? `Restore ${o.name}` : `Approve ${o.name}`, text: restore ? 'They can use Rizq Rasan again straight away.' : 'They can start using Rizq Rasan straight away. We email them now.', confirm: restore ? 'Restore' : 'Approve' });
    if (ok) await setStatus(btn, 'approved');
  };
  const reasonAction = (status, title, text, confirm) => async (btn) => {
    const v = await dialog({ title, text, confirm, danger: status !== 'needs_changes', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, hint: 'They will see this, so write it for them.' }] });
    if (v) await setStatus(btn, status, v.reason);
  };
  const decisions = [];
  if (['onboarding', 'pending_review', 'needs_changes'].includes(o.status)) {
    decisions.push(act('Approve', 'btn--primary', (b) => approve(b)),
      act('Needs changes', 'btn--secondary', reasonAction('needs_changes', 'Ask for changes', 'Say exactly what to fix. The application goes back to them.', 'Send back')),
      act('Reject', 'btn--secondary', reasonAction('rejected', `Reject ${o.name}`, 'Use this only when they cannot join. They can contact us if they think it is a mistake.', 'Reject')));
  }
  if (o.status === 'approved') {
    if (o.type === 'ngo') {
      decisions.push(act('Change tier', 'btn--secondary', async (b) => {
        const v = await dialog({ title: 'Change trust tier', confirm: 'Save tier', fields: [{ name: 'tier', label: 'Trust tier', type: 'select', required: true, value: o.tier || 'C', options: ['C', 'B', 'A'].map((t) => ({ value: t, label: TIER_TEXT[t] })) }] });
        if (v) await setStatus(b, 'approved', null, v.tier);
      }));
    }
    decisions.push(act('Suspend', 'btn--danger', reasonAction('suspended', `Suspend ${o.name}`, 'They cannot list or claim while suspended, and live listings are removed. They can appeal within 7 days.', 'Suspend')));
  }
  if (['suspended', 'rejected', 'removed'].includes(o.status)) decisions.push(act('Restore', 'btn--primary', (b) => approve(b, true)));

  // Documents
  const docList = h('ul.app-doclist', docs.map((d) => {
    const viewBtn = h('button.btn.btn--secondary.btn--sm', { type: 'button' }, 'View');
    viewBtn.addEventListener('click', () => openDocument(viewBtn, d.file_path));
    const okBtn = h('button.btn.btn--secondary.btn--sm', { type: 'button', disabled: d.status === 'approved' }, 'Approve');
    okBtn.addEventListener('click', () => busy(okBtn, async () => { await rpc('admin_review_document', { p_doc: d.id, p_status: 'approved', p_reason: null }); toast('Document checked.'); app.refresh(); }));
    const badBtn = h('button.btn.btn--secondary.btn--sm', { type: 'button' }, 'Needs a new file');
    badBtn.addEventListener('click', () => withReason(badBtn, { title: 'Ask for a new file', text: docLabels[d.kind] || d.kind, confirm: 'Ask for a new file', label: 'What is wrong with it', hint: 'They will see this next to the document.' },
      async (reason) => { await rpc('admin_review_document', { p_doc: d.id, p_status: 'rejected', p_reason: reason }); toast('They will be asked for a new file.'); app.refresh(); }));
    const st = { uploaded: tone('wait', 'To check'), approved: tone('good', 'Checked'), rejected: tone('bad', 'Needs a new file'), expired: tone('muted', 'Expired') }[d.status];
    return h('li.app-doc',
      h('div', h('p.app-doc__name', docLabels[d.kind] || d.kind), h('p.app-doc__hint', 'Uploaded ' + dateTime(d.created_at) + (d.expires_on ? ' · expires ' + d.expires_on : '')),
        d.status === 'rejected' && d.reason ? h('p.field__error', d.reason) : null),
      h('div.app-doc__end.adm-doc__end', st, viewBtn, okBtn, badBtn));
  }));

  // Strikes
  const strikeList = strikes.length ? h('ul.adm-rows', strikes.map((s) => {
    const active = !s.forgiven_at && new Date(s.expires_at) > new Date();
    const btn = active ? h('button.btn.btn--secondary.btn--sm', { type: 'button' }, 'Forgive') : null;
    btn?.addEventListener('click', async () => {
      const ok = await dialog({ title: 'Forgive this strike?', text: 'Only one strike per organisation can be forgiven every 90 days. They will be told.', confirm: 'Forgive strike' });
      if (ok) busy(btn, async () => { await rpc('admin_forgive_strike', { p_strike: s.id }); toast('Strike forgiven.'); app.refresh(); });
    });
    return h('li.adm-row.adm-row--static', h('div.adm-row__main', h('p.adm-row__title', s.reason),
      h('p.adm-row__meta', `Given ${dateTime(s.created_at)} · ` + (s.forgiven_at ? `forgiven ${dateTime(s.forgiven_at)}` : active ? `expires ${date(s.expires_at)}` : 'expired'))),
    h('div.adm-row__end', active ? tone('bad', 'Active') : tone('muted', s.forgiven_at ? 'Forgiven' : 'Expired'), btn));
  })) : h('p.app-muted', 'No strikes.');

  const scoreTone = score >= 90 ? 'good' : score >= 60 ? 'wait' : 'bad';
  return h('section',
    backLink('/admin/organisations', 'Organisations'),
    pageHead(o.name, typeLabel(o.type) + (o.sector ? ' in ' + o.sector : ''), statusBadge(o.status)),
    o.status_reason ? notice(['suspended', 'rejected'].includes(o.status) ? 'warning' : 'info', 'Reason given: ' + o.status_reason) : null,
    h('div.app-stats.adm-mini-stats',
      h('div.app-stat', h('div.app-stat__value', h('span', { class: 'adm-score adm-score--' + scoreTone }, String(score))), h('div.app-stat__label', 'Reliability (of 100)')),
      h('div.app-stat', h('div.app-stat__value', String(activeStrikes.length)), h('div.app-stat__label', 'Active strikes')),
      h('div.app-stat', h('div.app-stat__value', String(recent.length === 10 ? '10+' : recent.length)), h('div.app-stat__label', 'Orders'))),
    decisions.length ? section('Decision', h('div.adm-actions', decisions)) : null,
    section('Details', details),
    section('Members', members.length ? h('ul.adm-rows', members.map((m) => {
      const p = people.find((x) => x.id === m.user_id);
      return h('li.adm-row.adm-row--static', h('div.adm-row__main', h('p.adm-row__title', p?.full_name || 'Unnamed'), h('p.adm-row__meta', [phoneDisplay(p?.phone), 'joined ' + date(m.created_at)].filter(Boolean).join(' · '))),
        h('div.adm-row__end', h('span.chip', m.role === 'owner' ? 'Owner' : 'Staff')));
    })) : h('p.app-muted', 'No members.')),
    section('Documents', docs.length ? [h('p.app-muted', 'Files open in a new tab through a link that works for 5 minutes.'), docList] : h('p.app-muted', 'No documents uploaded yet.')),
    section('Strikes', strikeList),
    section('Recent orders', rows(recent.map((r) => row('/admin/orders/' + r.id, {
      title: r.listings?.title || ref(r.id), text: ref(r.id) + ' · ' + rs(r.price_rs), meta: dateTime(r.created_at), end: statusBadge(r.status),
    })), h('p.app-muted', 'No orders yet.'))));
}

// Open a private document through a 5-minute signed link, in a new tab.
async function openDocument(btn, path) {
  const tab = window.open('', '_blank');
  await busy(btn, async () => {
    const { data, error } = await db.storage.from('documents').createSignedUrl(path, 300);
    if (error || !data?.signedUrl) { tab?.close(); throw new AppError('The file could not be opened. It may have been deleted.'); }
    if (tab) { tab.opener = null; tab.location.href = data.signedUrl; }
    else {
      btn.parentElement.append(h('a.btn.btn--secondary.btn--sm', { href: data.signedUrl, target: '_blank', rel: 'noopener' }, 'Open file'));
      toast('Your browser blocked the new tab. Use Open file.');
    }
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
async function orders({ query }) {
  const status = query.status || 'active';
  const mode = query.mode || '';
  let q = db.from('orders').select('id, status, payment_mode, price_rs, created_at, payment_deadline, listings(title), vendor:organisations!orders_vendor_id_fkey(name), ngo:organisations!orders_ngo_id_fkey(name)')
    .order('created_at', { ascending: false }).limit(100);
  if (status === 'active') q = q.in('status', ACTIVE);
  else if (status === 'ended') q = q.in('status', ENDED);
  else if (status !== 'all') q = q.eq('status', status);
  if (mode) q = q.eq('payment_mode', mode);
  const list = await select(q);
  const setQuery = (k, v) => {
    const p = new URLSearchParams({ status, mode, [k]: v });
    for (const [key, val] of [...p]) if (!val || (key === 'status' && val === 'active')) p.delete(key);
    go('/admin/orders' + (p.toString() ? '?' + p : ''));
  };
  const st = field({ name: 'status', label: 'Status', type: 'select', value: status, placeholder: 'Choose',
    options: [{ value: 'active', label: 'Active' }, { value: 'ended', label: 'Ended' }, { value: 'all', label: 'All' }, ...ORDER_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))] });
  const md = field({ name: 'mode', label: 'Payment', type: 'select', value: mode, placeholder: 'Both', options: [{ value: 'direct', label: 'Direct' }, { value: 'payfast', label: 'PayFast' }] });
  st.input.addEventListener('change', () => setQuery('status', st.value() || 'active'));
  md.input.addEventListener('change', () => setQuery('mode', md.value()));
  return h('section',
    pageHead('Orders', 'The latest 100 orders matching the filters.'),
    h('div.app-filters', st.wrap, md.wrap),
    rows(list.map((o) => row('/admin/orders/' + o.id, {
      title: o.listings?.title || ref(o.id),
      text: `${o.vendor?.name || 'Business'} to ${o.ngo?.name || 'NGO'}`,
      meta: [ref(o.id), rs(o.price_rs), o.payment_mode === 'direct' ? 'Direct' : 'PayFast', dateTime(o.created_at),
        o.status === 'payment_due' ? 'pay by ' + dateTime(o.payment_deadline) : null].filter(Boolean).join(' · '),
      end: statusBadge(o.status),
    })), empty('No orders match', 'Change the filters to see more.')));
}

async function order({ params, app }) {
  const d = await rpc('order_details', { p_order: params.id });
  const [o, pays, refunds, disputes, listing] = await Promise.all([
    select(db.from('orders').select(ORDER_COLS).eq('id', params.id).single()),
    select(db.from('payments').select('*').eq('order_id', params.id).order('created_at')),
    select(db.from('refunds').select('*').eq('order_id', params.id).order('created_at')),
    select(db.from('disputes').select('*').eq('order_id', params.id).order('created_at')),
    select(db.from('listings').select('id, status, status_reason').eq('id', d.listing.id).maybeSingle()),
  ]);
  const paid = pays.some((p) => ['succeeded', 'partly_refunded', 'refunded'].includes(p.status));

  // Timeline, oldest first.
  const ev = [
    [o.created_at, 'Claimed', `${d.ngo.name} claimed it for ${rs(o.price_rs)}`],
    [o.ngo_marked_paid_at, 'NGO says it paid', o.ngo_payment_reference ? 'Reference ' + o.ngo_payment_reference : null],
    ...pays.map((p) => [p.succeeded_at || p.created_at, p.status === 'failed' ? 'Payment failed' : 'Payment received', `${rs(p.amount_rs)} by ${p.method || p.gateway}${p.gateway_reference ? ' · ' + p.gateway_reference : ''}`]),
    [o.paid_at, 'Paid, ready to collect', null],
    [o.collection_asked_at, 'Business asked if it was collected', null],
    [o.picked_up_at, 'Handed over', o.quantity_handed_over ? `Quantity ${o.quantity_handed_over} ${d.listing.unit}` : null],
    ...disputes.map((x) => [x.created_at, 'Problem reported', DISPUTE_KINDS[x.kind] || x.kind]),
    ...disputes.filter((x) => x.decided_at).map((x) => [x.decided_at, 'Problem decided', x.decision]),
    ...refunds.map((r) => [r.created_at, 'Refund ' + (r.status === 'pending_approval' ? 'requested' : 'approved'), `${rs(r.amount_rs)} · ${r.reason}`]),
    ...refunds.filter((r) => r.sent_at).map((r) => [r.sent_at, 'Refund sent', `${rs(r.amount_rs)}${r.gateway_reference ? ' · ' + r.gateway_reference : ''}`]),
    [o.completed_at, 'Completed', null],
    [o.ended_at, 'Ended', o.ended_reason],
  ].filter(([t]) => t).sort((a, b) => new Date(a[0]) - new Date(b[0]));
  if (o.status === 'payment_due' || o.status === 'payment_processing') ev.push([o.payment_deadline, 'Payment deadline', minutesLeft(o.payment_deadline) > 0 ? untilText(o.payment_deadline) + ' left' : 'passed']);
  const timeline = h('ol.adm-timeline', ev.map(([t, title, text]) => h('li', h('p.adm-timeline__title', title), text ? h('p.adm-timeline__text', text) : null, h('p.adm-timeline__time', dateTime(t)))));

  // Actions
  const actions = [];
  if (!ENDED.includes(o.status)) {
    const cancel = (refund) => async (btn) => {
      await withReason(btn, {
        title: refund ? 'Cancel and refund' : 'Cancel without refund',
        text: refund ? `The NGO gets ${rs(o.price_rs)} back. Both sides are told.` : 'Nothing is refunded. Both sides are told.',
        confirm: refund ? 'Cancel and refund' : 'Cancel order', hint: 'Both sides will see this.',
      }, async (reason) => { await rpc('admin_cancel_order', { p_order: o.id, p_reason: reason, p_refund: refund }); toast('Order cancelled.'); app.refresh(); });
    };
    const b1 = h('button.btn.btn--danger', { type: 'button' }, paid ? `Cancel and refund ${rs(o.price_rs)}` : 'Cancel order');
    b1.addEventListener('click', () => cancel(paid)(b1));
    actions.push(b1);
    if (paid) { const b2 = h('button.btn.btn--secondary', { type: 'button' }, 'Cancel without refund'); b2.addEventListener('click', () => cancel(false)(b2)); actions.push(b2); }
  }
  if (['paid', 'awaiting_collection_answer'].includes(o.status)) {
    const b = h('button.btn.btn--secondary', { type: 'button' }, 'Reissue pickup code');
    b.addEventListener('click', async () => {
      const ok = await dialog({ title: 'Reissue the pickup code?', text: 'The old code stops working and wrong-code locks are cleared. The NGO is told to open the order for the new code.', confirm: 'Reissue code' });
      if (ok) busy(b, async () => { const code = await rpc('admin_reissue_code', { p_order: o.id }); toast('New pickup code: ' + code); app.refresh(); });
    });
    actions.push(b);
  }
  if (listing && ['live', 'draft'].includes(listing.status)) {
    const b = h('button.btn.btn--secondary', { type: 'button' }, 'Remove listing');
    b.addEventListener('click', () => withReason(b, { title: 'Remove this listing?', text: 'It disappears from Find food straight away. The business is told why.', confirm: 'Remove listing', hint: 'The business will see this.' },
      async (reason) => { await rpc('admin_remove_listing', { p_listing: listing.id, p_reason: reason }); toast('Listing removed.'); app.refresh(); }));
    actions.push(b);
  }

  const money = h('dl.app-split',
    h('div', h('dt', 'NGO pays'), h('dd', rs(o.price_rs))),
    h('div', h('dt', 'Business receives'), h('dd', rs(o.vendor_share_rs))),
    h('div', h('dt', 'Rizq Rasan'), h('dd', rs(o.commission_rs))));

  return h('section',
    backLink('/admin/orders', 'Orders'),
    pageHead(d.listing.title, `${d.reference} · ${o.payment_mode === 'direct' ? 'Direct payment' : 'PayFast'}`, statusBadge(o.status)),
    h('div.adm-two',
      h('div',
        d.pickup_code ? h('div.app-code.adm-code', h('span.app-code__label', 'Pickup code'), h('span.app-code__value', d.pickup_code)) : null,
        section('Money', money),
        section('People', facts([
          ['Business', h('span', d.vendor.name, ' · ', d.vendor.badge)], ['Business phone', phoneDisplay(d.vendor.phone)], ['Pickup address', d.vendor.address],
          ['NGO', h('span', d.ngo.name, ' · ', d.ngo.badge)], ['NGO phone', phoneDisplay(d.ngo.phone)],
          ['Collector', d.collector ? `${d.collector.name} · ${phoneDisplay(d.collector.phone)}` : null],
        ]), h('p.adm-links', link('/admin/organisations/' + o.vendor_id, 'Open business'), link('/admin/organisations/' + o.ngo_id, 'Open NGO'))),
        section('Food', facts([
          ['Quantity', `${d.listing.quantity} ${d.listing.unit} · ${d.listing.weight_kg} kg`], ['Pickup', `${dateTime(d.listing.pickup_start)} to ${dateTime(d.listing.pickup_end)}`],
          ['Safe until', dateTime(d.listing.safe_until)], ['Storage', d.listing.storage], ['Listing', listing ? statusLabel(listing.status) + (listing.status_reason ? ' · ' + listing.status_reason : '') : null],
        ]))),
      h('div',
        actions.length ? section('Actions', h('div.adm-actions', actions)) : null,
        section('Timeline', timeline))),
    section('Payments', pays.length ? h('ul.adm-rows', pays.map((p) => h('li.adm-row.adm-row--static',
      h('div.adm-row__main', h('p.adm-row__title', rs(p.amount_rs) + ' · ' + (p.method || p.gateway)), h('p.adm-row__meta', [p.gateway, p.gateway_reference, dateTime(p.created_at)].filter(Boolean).join(' · '))),
      h('div.adm-row__end', paymentBadge(p.status)))))
      : h('p.app-muted', 'No payment recorded.')),
    refunds.length ? section('Refunds', h('ul.adm-rows', refunds.map((r) => h('li.adm-row.adm-row--static',
      h('div.adm-row__main', h('p.adm-row__title', rs(r.amount_rs) + ' · ' + r.reason), h('p.adm-row__meta', `Paid by ${r.borne_by} · ${dateTime(r.created_at)}`)),
      h('div.adm-row__end', refundBadge(r.status)))))) : null,
    disputes.length ? section('Problem reports', rows(disputes.map((x) => row('/admin/disputes/' + x.id, {
      title: DISPUTE_KINDS[x.kind] || x.kind, text: x.details, meta: dateTime(x.created_at), end: disputeBadge(x),
    })))) : null);
}

const paymentBadge = (s) => tone({ succeeded: 'good', pending: 'wait', failed: 'bad', refunded: 'muted', partly_refunded: 'wait' }[s] || 'muted',
  { succeeded: 'Received', pending: 'Pending', failed: 'Failed', refunded: 'Refunded', partly_refunded: 'Partly refunded' }[s] || s);
const refundBadge = (s) => tone({ pending_approval: 'wait', approved: 'wait', sent: 'good', rejected: 'muted' }[s] || 'muted',
  { pending_approval: 'Needs a second admin', approved: 'Approved, not sent', sent: 'Sent', rejected: 'Rejected' }[s] || s);
const disputeBadge = (x) => (x.status === 'decided' ? tone('good', 'Decided') : x.status === 'withdrawn' ? tone('muted', 'Withdrawn')
  : x.kind === 'food_safety' ? tone('bad', 'Food safety') : tone('wait', x.status === 'awaiting_reply' ? 'Waiting for reply' : 'To decide'));

// ---------------------------------------------------------------------------
// Problems (disputes)
// ---------------------------------------------------------------------------
const targetHours = (x) => (x.kind === 'food_safety' ? 24 : 48);
function targetText(x) {
  const due = new Date(new Date(x.created_at).getTime() + targetHours(x) * 3600000);
  const left = minutesLeft(due);
  return { due, late: left <= 0, text: left > 0 ? `Decide by ${dateTime(due)} (${untilText(due)} left, ${targetHours(x)}-hour target)` : `Overdue by ${ago(due)} (${targetHours(x)}-hour target)` };
}

async function disputes({ query }) {
  const tab = query.tab === 'decided' ? 'decided' : 'open';
  const list = await select(db.from('disputes').select('*, orders(id, price_rs, vendor_id, ngo_id, listings(title))').order('created_at', { ascending: true }).limit(300));
  const names = await orgNames(list.map((x) => x.raised_by_org));
  const open = list.filter((x) => ['open', 'awaiting_reply'].includes(x.status))
    .sort((a, b) => (a.kind === 'food_safety') === (b.kind === 'food_safety') ? new Date(a.created_at) - new Date(b.created_at) : a.kind === 'food_safety' ? -1 : 1);
  const done = list.filter((x) => !['open', 'awaiting_reply'].includes(x.status)).reverse();
  const shown = tab === 'open' ? open : done;
  return h('section',
    pageHead('Problems', 'Food safety reports come first. Decide them within 24 hours; others within 48 hours.'),
    tabs2([['open', 'Open', open.length], ['decided', 'Decided', done.length]], tab, (id) => go('/admin/disputes' + (id === 'decided' ? '?tab=decided' : ''))),
    rows(shown.map((x) => {
      const t = targetText(x);
      const raiser = names[x.raised_by_org];
      return row('/admin/disputes/' + x.id, {
        cls: x.kind === 'food_safety' && tab === 'open' ? 'adm-row--alert' : '',
        title: (DISPUTE_KINDS[x.kind] || x.kind) + ' · ' + (x.orders?.listings?.title || ref(x.order_id)),
        text: `Reported by ${raiser ? `${raiser.name} (${typeLabel(raiser.type)})` : 'unknown'}: ${x.details}`,
        meta: tab === 'open' ? h('span', { class: t.late ? 'adm-late' : '' }, t.text) : `Decided ${x.decided_at ? dateTime(x.decided_at) : ''}${x.refund_rs ? ' · refund ' + rs(x.refund_rs) : ''}`,
        end: disputeBadge(x),
      });
    }), empty(tab === 'open' ? 'No open problems' : 'Nothing decided yet', tab === 'open' ? 'New reports show up here and in your notifications.' : null)));
}

async function dispute({ params, app }) {
  const x = await select(db.from('disputes').select('*').eq('id', params.id).maybeSingle());
  if (!x) return empty('Report not found', null, link('/admin/disputes', 'Back to problems'));
  const [d, o, refunds] = await Promise.all([
    rpc('order_details', { p_order: x.order_id }),
    select(db.from('orders').select(ORDER_COLS).eq('id', x.order_id).single()),
    select(db.from('refunds').select('amount_rs, status').eq('order_id', x.order_id)),
  ]);
  const names = await profileNames([x.decided_by]);
  const byNgo = x.raised_by_org === o.ngo_id;
  const raiser = byNgo ? `${d.ngo.name} (NGO)` : `${d.vendor.name} (business)`;
  const other = byNgo ? `${d.vendor.name} (business)` : `${d.ngo.name} (NGO)`;
  const refunded = refunds.filter((r) => r.status !== 'rejected').reduce((a, r) => a + r.amount_rs, 0);
  const maxRefund = Math.max(0, o.price_rs - refunded);
  const t = targetText(x);
  const decided = x.status === 'decided';

  let form = null;
  if (!decided) {
    const fDecision = field({ name: 'decision', label: 'Decision', type: 'textarea', rows: 4, required: true, full: true, hint: 'Both sides see this. Say what you found and what happens next.' });
    const fRefund = field({ name: 'refund', label: 'Refund to the NGO (Rs)', type: 'number', min: 0, max: maxRefund, step: 1, value: 0, inputmode: 'numeric',
      hint: maxRefund ? `Up to ${rs(maxRefund)}${refunded ? ` (${rs(refunded)} already refunded)` : ''}. Taken from the business's share.` : 'Already refunded in full.' });
    if (!maxRefund) fRefund.input.disabled = true;
    const fStrike = field({ name: 'strike', label: 'Strike', type: 'select', placeholder: 'No strike',
      options: [{ value: o.vendor_id, label: `Strike for ${d.vendor.name} (business)` }, { value: o.ngo_id, label: `Strike for ${d.ngo.name} (NGO)` }] });
    const submit = h('button.btn.btn--primary', { type: 'submit' }, 'Record decision');
    form = h('form.app-form.card', { novalidate: true }, h('div.form__grid', fDecision.wrap, fRefund.wrap, fStrike.wrap), submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (fDecision.value().length < 10) return fDecision.error('Write the decision in a sentence or two.');
      const amount = fRefund.value() === '' ? 0 : fRefund.value();
      if (!Number.isInteger(amount) || amount < 0) return fRefund.error('Enter whole rupees, or 0 for no refund.');
      if (amount > maxRefund) return fRefund.error(`The refund can be at most ${rs(maxRefund)}.`);
      const strikeOrg = fStrike.value() || null;
      const summary = [amount ? `Refund ${rs(amount)} to the NGO.` : 'No refund.', strikeOrg ? `Strike for ${strikeOrg === o.vendor_id ? d.vendor.name : d.ngo.name}.` : 'No strike.'].join(' ');
      const ok = await dialog({ title: 'Record this decision?', text: summary + ' Both sides are told and it cannot be changed here.', confirm: 'Record decision' });
      if (!ok) return;
      busy(submit, async () => {
        await rpc('admin_decide_dispute', { p_dispute: x.id, p_decision: fDecision.value(), p_refund_rs: amount, p_strike_org: strikeOrg });
        toast('Decision recorded. Both sides have been told.');
        app.refresh();
      });
    });
  }

  return h('section.app-narrow',
    backLink('/admin/disputes', 'Problems'),
    pageHead(DISPUTE_KINDS[x.kind] || x.kind, `${d.listing.title} · ${d.reference}`, disputeBadge(x)),
    !decided ? h('div.adm-target', { class: x.kind === 'food_safety' || t.late ? 'adm-target--alert' : '' }, icon(x.kind === 'food_safety' ? 'alert' : 'clock'), h('p', t.text)) : null,
    facts([['Reported', dateTime(x.created_at)], ['Order', link('/admin/orders/' + x.order_id, d.reference)], ['Order status', statusLabel(o.status)], ['Price', rs(o.price_rs)]]),
    h('div.adm-sides',
      h('article.adm-side', h('p.adm-side__who', 'Reported by ' + raiser), h('p.adm-side__text', x.details)),
      h('article.adm-side', h('p.adm-side__who', 'Reply from ' + other), x.reply ? h('p.adm-side__text', x.reply) : h('p.app-muted', 'No reply yet.'))),
    decided ? section('Decision', h('div.card.adm-decision', h('p', x.decision),
      facts([['Refund', x.refund_rs ? rs(x.refund_rs) : 'None'], ['Strike', x.strike_org ? (x.strike_org === o.vendor_id ? d.vendor.name : d.ngo.name) : 'None'],
        ['Decided', x.decided_at ? `${dateTime(x.decided_at)} by ${names[x.decided_by] || 'an admin'}` : null]])))
      : section('Your decision', form));
}

// ---------------------------------------------------------------------------
// Payments and refunds
// ---------------------------------------------------------------------------
async function payments({ query, app }) {
  const tab = ['payments', 'mismatches'].includes(query.tab) ? query.tab : 'refunds';
  const [refunds, pays, events] = await Promise.all([
    select(db.from('refunds').select('*, orders(id, listings(title))').order('created_at', { ascending: false }).limit(200)),
    tab === 'payments' ? select(db.from('payments').select('*, orders(id, payment_mode, listings(title))').order('created_at', { ascending: false }).limit(100)) : [],
    select(db.from('payment_events').select('*').eq('result', 'amount_mismatch').order('received_at', { ascending: false }).limit(100)),
  ]);
  const order = { pending_approval: 0, approved: 1, sent: 2, rejected: 3 };
  refunds.sort((a, b) => order[a.status] - order[b.status] || new Date(b.created_at) - new Date(a.created_at));
  const names = await profileNames(refunds.flatMap((r) => [r.requested_by, r.approved_by]));
  const waiting = refunds.filter((r) => r.status === 'pending_approval').length;
  const toSend = refunds.filter((r) => r.status === 'approved').length;

  let body;
  if (tab === 'refunds') {
    body = rows(refunds.map((r) => {
      const actions = [];
      if (r.status === 'pending_approval') {
        const mine = r.requested_by === state.user.id;
        const b = h('button.btn.btn--primary.btn--sm', { type: 'button', disabled: mine }, 'Approve refund');
        b.addEventListener('click', async () => {
          const ok = await dialog({ title: `Approve a refund of ${rs(r.amount_rs)}?`, text: 'After approval, send the money and record the reference.', confirm: 'Approve refund' });
          if (ok) busy(b, async () => { await rpc('admin_approve_refund', { p_refund: r.id }); toast('Refund approved. Send it, then mark it sent.'); app.refresh(); });
        });
        actions.push(b);
        if (mine) actions.push(h('p.adm-note', 'You asked for this refund, so a different admin must approve it.'));
      }
      if (r.status === 'approved') {
        const b = h('button.btn.btn--secondary.btn--sm', { type: 'button' }, 'Mark sent');
        b.addEventListener('click', async () => {
          const v = await dialog({ title: `Mark ${rs(r.amount_rs)} as sent`, text: 'Record the bank or gateway reference for this refund.', confirm: 'Mark sent', fields: [{ name: 'ref', label: 'Reference', required: true }] });
          if (v) busy(b, async () => { await rpc('admin_mark_refund_sent', { p_refund: r.id, p_reference: v.ref }); toast('Refund marked as sent.'); app.refresh(); });
        });
        actions.push(b);
      }
      return h('li.adm-row.adm-row--static', { dataset: { refund: r.id } },
        h('div.adm-row__main',
          h('p.adm-row__title', rs(r.amount_rs), ' · ', link('/admin/orders/' + r.order_id, r.orders?.listings?.title || ref(r.order_id))),
          h('p.adm-row__text', r.reason),
          h('p.adm-row__meta', [ref(r.order_id), `paid by ${r.borne_by}`, `asked by ${names[r.requested_by] || 'the system'}`, r.approved_by ? `approved by ${names[r.approved_by]}` : null,
            r.gateway_reference ? 'ref ' + r.gateway_reference : null, dateTime(r.created_at)].filter(Boolean).join(' · '))),
        h('div.adm-row__end.adm-row__end--stack', refundBadge(r.status), actions));
    }), empty('No refunds yet', 'Refunds appear here when orders are cancelled or problems are decided.'));
  } else if (tab === 'payments') {
    body = rows(pays.map((p) => row('/admin/orders/' + p.order_id, {
      title: rs(p.amount_rs) + ' · ' + (p.orders?.listings?.title || ref(p.order_id)),
      text: [p.gateway === 'direct' ? 'Direct' : 'PayFast', p.method, p.gateway_reference].filter(Boolean).join(' · '),
      meta: ref(p.order_id) + ' · ' + dateTime(p.created_at), end: paymentBadge(p.status),
    })), empty('No payments yet', null));
  } else {
    body = [h('p.app-muted', 'PayFast told us an amount that does not match the order. Check the payment in the PayFast portal and refund or contact the NGO.'),
      rows(events.map((e) => {
        const b = e.body || {};
        const orderId = /^[0-9a-f-]{36}$/i.test(b.basket_id || '') ? b.basket_id : null;
        const inner = [h('p.adm-row__title', `${b.transaction_amount ? 'Rs ' + b.transaction_amount : 'Amount not given'} · event ${e.event_id}`),
          h('p.adm-row__meta', [orderId ? ref(orderId) : null, b.transaction_id, dateTime(e.received_at)].filter(Boolean).join(' · '))];
        return orderId ? row('/admin/orders/' + orderId, { title: inner[0].textContent, meta: inner[1].textContent, end: tone('bad', 'Mismatch') })
          : h('li.adm-row.adm-row--static', h('div.adm-row__main', inner), h('div.adm-row__end', tone('bad', 'Mismatch')));
      }), empty('No mismatches', 'Good. Every gateway payment matched its order.'))];
  }
  return h('section',
    pageHead('Payments', 'Refunds over the limit need a second admin. Payments and mismatches are for checking against PayFast.'),
    tabs2([['refunds', 'Refunds', waiting + toSend || undefined], ['payments', 'Payments'], ['mismatches', 'Mismatches', events.length || undefined]], tab, (id) => go('/admin/payments' + (id === 'refunds' ? '' : '?tab=' + id))),
    body);
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------
async function payouts({ app }) {
  const [batches, waiting] = await Promise.all([
    select(db.from('payouts').select('*').order('run_date', { ascending: false }).limit(50)),
    select(db.from('payout_lines').select('id, vendor_id, net_rs, status, hold_reason, created_at').in('status', ['eligible', 'on_hold', 'pending'])),
  ]);
  const names = await profileNames(batches.flatMap((b) => [b.prepared_by, b.approved_by]));
  const vendors = await orgNames(waiting.map((l) => l.vendor_id));
  const eligible = waiting.filter((l) => l.status === 'eligible');
  const held = waiting.filter((l) => l.status === 'on_hold');

  const prep = h('button.btn.btn--primary', { type: 'button' }, 'Prepare batch now');
  prep.addEventListener('click', async () => {
    // Default to today in Pakistan, or the next day without a finished batch.
    const used = new Set(batches.filter((b) => b.status !== 'draft').map((b) => b.run_date));
    let d = new Date();
    while (used.has(pktDate(d))) d = new Date(d.getTime() + 86400000);
    const v = await dialog({ title: 'Prepare a payout batch', text: 'Every eligible line goes into the batch, except lines with an open problem report or a recent payout account change. A different admin then approves it.',
      confirm: 'Prepare batch', fields: [{ name: 'day', label: 'Batch date', type: 'date', required: true, value: pktDate(d), hint: 'Usually today. A draft batch with the same date is topped up.' }] });
    if (!v) return;
    const existing = batches.find((b) => b.run_date === v.day);
    if (existing && existing.status !== 'draft') { toast('The batch for that date has already been approved. Choose another date.', 'error'); return; }
    busy(prep, async () => {
      const id = await rpc('prepare_payout', { p_run_date: v.day });
      toast('Batch prepared. A different admin must approve it.');
      go('/admin/payouts/' + id);
    });
  });

  const byVendor = {};
  for (const l of eligible) (byVendor[l.vendor_id] ||= []).push(l);
  return h('section',
    pageHead('Payouts', 'Batches go out on Mondays and Thursdays. One admin prepares, a different admin approves, then someone records the bank references.', prep),
    h('div.app-stats',
      h('div.app-stat', h('div.app-stat__value', rs(eligible.reduce((a, l) => a + l.net_rs, 0))), h('div.app-stat__label', `Ready for the next batch (${eligible.length} line${eligible.length === 1 ? '' : 's'})`)),
      h('div.app-stat', h('div.app-stat__value', String(Object.keys(byVendor).length)), h('div.app-stat__label', 'Businesses to pay')),
      h('div.app-stat', h('div.app-stat__value', String(held.length)), h('div.app-stat__label', 'Lines on hold'))),
    held.length ? section('On hold', h('ul.adm-rows', held.map((l) => h('li.adm-row.adm-row--static',
      h('div.adm-row__main', h('p.adm-row__title', link('/admin/organisations/' + l.vendor_id, vendors[l.vendor_id]?.name || 'Business')), h('p.adm-row__meta', l.hold_reason || 'On hold')),
      h('div.adm-row__end', h('span.adm-amount', rs(l.net_rs))))))) : null,
    section('Batches', rows(batches.map((b) => row('/admin/payouts/' + b.id, {
      title: `${date(b.run_date + 'T12:00:00+05:00')} batch · ${rs(b.total_rs)}`,
      text: [`Prepared by ${b.prepared_by ? names[b.prepared_by] : 'the scheduler'}`, b.approved_by ? `approved by ${names[b.approved_by]}` : null, b.sent_at ? `sent ${dateTime(b.sent_at)}` : null].filter(Boolean).join(' · '),
      end: payoutBadge(b.status),
    })), empty('No batches yet', 'Prepare one when lines are ready.'))));
}

const payoutBadge = (s) => tone({ draft: 'wait', approved: 'wait', sent: 'good' }[s] || 'muted', { draft: 'Waiting for approval', approved: 'Approved, not sent', sent: 'Sent' }[s] || s);

async function payout({ params, app }) {
  const p = await select(db.from('payouts').select('*').eq('id', params.id).maybeSingle());
  if (!p) return empty('Batch not found', null, link('/admin/payouts', 'Back to payouts'));
  const lines = await select(db.from('payout_lines').select('*, orders(id, listings(title))').eq('payout_id', p.id).order('created_at'));
  const vendorIds = [...new Set(lines.map((l) => l.vendor_id))];
  const vendors = vendorIds.length ? await select(db.from('organisations').select('id, name, bank_iban, bank_account_title, raast_id, payouts_paused_until').in('id', vendorIds)) : [];
  const names = await profileNames([p.prepared_by, p.approved_by]);
  const groups = vendors.map((v) => ({ v, lines: lines.filter((l) => l.vendor_id === v.id) })).sort((a, b) => a.v.name.localeCompare(b.v.name));
  const refInputs = {};

  const groupCards = groups.map(({ v, lines: ls }) => {
    const total = ls.reduce((a, l) => a + l.net_rs, 0);
    let refField = null;
    if (p.status === 'approved') {
      refField = field({ name: 'ref-' + v.id, label: `Bank reference for ${v.name}`, required: true, placeholder: 'From your bank\'s transfer receipt' });
      refInputs[v.id] = refField;
    }
    return h('article.card.adm-vendor', { dataset: { vendor: v.id } },
      h('header.adm-vendor__head', h('div', h('h3.adm-vendor__name', link('/admin/organisations/' + v.id, v.name)), h('p.app-muted', `${ls.length} order${ls.length === 1 ? '' : 's'}`)), h('p.adm-vendor__total', rs(total))),
      facts([['Account title', v.bank_account_title || 'Not given'], ['IBAN', v.bank_iban ? h('span.adm-iban', iban(v.bank_iban)) : 'Missing']]),
      v.bank_iban ? null : notice('warning', 'This business has no IBAN. Do not send until they add one.'),
      h('ul.adm-lines', ls.map((l) => h('li',
        h('span', link('/admin/orders/' + l.order_id, l.orders?.listings?.title || ref(l.order_id)), h('span.adm-lines__sub', `${rs(l.gross_rs)} less ${rs(l.commission_rs)} commission${l.deductions_rs ? ` and ${rs(l.deductions_rs)}` : ''}`)),
        h('span.adm-amount', rs(l.net_rs))))),
      ls[0]?.bank_reference ? h('p.adm-row__meta', 'Bank reference: ' + ls[0].bank_reference) : null,
      refField ? refField.wrap : null);
  });

  let actions = null;
  if (p.status === 'draft') {
    const mine = p.prepared_by && p.prepared_by === state.user.id;
    const b = h('button.btn.btn--primary', { type: 'button', disabled: mine || !lines.length }, `Approve ${rs(p.total_rs)}`);
    b.addEventListener('click', async () => {
      const ok = await dialog({ title: `Approve ${rs(p.total_rs)} to ${groups.length} business${groups.length === 1 ? '' : 'es'}?`, text: 'Check the IBANs and totals first. After approval, make the bank transfers and record the references.', confirm: 'Approve batch' });
      if (ok) busy(b, async () => { await rpc('admin_approve_payout', { p_payout: p.id }); toast('Batch approved. Make the transfers, then record the references.'); app.refresh(); });
    });
    const topUp = h('button.btn.btn--secondary', { type: 'button' }, 'Add newly eligible lines');
    topUp.addEventListener('click', () => busy(topUp, async () => { await rpc('prepare_payout', { p_run_date: p.run_date }); toast('Batch updated.'); app.refresh(); }));
    actions = h('div.card.adm-approve',
      h('p', mine ? h('strong', 'You prepared this batch, so a different admin must approve it.') : 'A different admin from the one who prepared the batch must approve it.',
        ' This two-person check protects payouts.'),
      h('div.adm-actions', b, topUp));
  } else if (p.status === 'approved') {
    const send = h('button.btn.btn--primary', { type: 'submit' }, 'Record payout');
    actions = h('p.app-muted', 'Make one bank transfer per business, then enter each bank reference below and record the payout.');
    const form = h('form.app-form.adm-send', { novalidate: true }, groupCards, h('div.adm-actions', send));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const refs = {};
      for (const [vid, f] of Object.entries(refInputs)) {
        if (!f.value()) { f.error('Enter the bank reference.'); f.input.focus(); return; }
        refs[vid] = f.value();
      }
      busy(send, async () => { await rpc('admin_mark_payout_sent', { p_payout: p.id, p_references: refs }); toast('Payout recorded. Each business has been told.'); app.refresh(); });
    });
    return wrap(form);
  }
  return wrap(groupCards.length ? h('div.adm-vendors', groupCards) : empty('This batch is empty', 'No lines were eligible when it was prepared.'));

  function wrap(content) {
    return h('section',
      backLink('/admin/payouts', 'Payouts'),
      pageHead(`${date(p.run_date + 'T12:00:00+05:00')} batch`, `${rs(p.total_rs)} to ${groups.length} business${groups.length === 1 ? '' : 'es'}`, payoutBadge(p.status)),
      facts([['Prepared by', p.prepared_by ? names[p.prepared_by] : 'The scheduler'], ['Prepared', dateTime(p.created_at)],
        ['Approved by', p.approved_by ? names[p.approved_by] : null], ['Sent', p.sent_at ? dateTime(p.sent_at) : null]]),
      actions ? h('div.app-section', actions) : null,
      section('By business', content));
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function settings({ app }) {
  const [rowsList, cats] = await Promise.all([
    select(db.from('settings').select('*').order('key')),
    select(db.from('categories').select('*').order('sort')),
  ]);
  const names = await profileNames(rowsList.map((s) => s.updated_by));
  const first = rowsList.filter((s) => s.key === 'payment_mode');
  const rest = rowsList.filter((s) => s.key !== 'payment_mode');

  const save = async (btn, s, value) => {
    await busy(btn, async () => { await rpc('admin_update_setting', { p_key: s.key, p_value: value }); toast(`${humanKey(s.key)} saved.`); app.refresh(); });
  };
  const changed = (s) => (s.updated_by ? h('p.adm-setting__meta', `Changed ${dateTime(s.updated_at)} by ${names[s.updated_by] || 'an admin'}`) : null);

  const card = (s) => {
    const t = typeof s.value === 'object' && s.value !== null ? (Array.isArray(s.value) ? 'array' : 'object') : typeof s.value;
    const head = h('div.adm-setting__head', h('h3.adm-setting__key', humanKey(s.key)), h('code.adm-setting__code', s.key));
    const desc = h('p.adm-setting__desc', s.description);
    const id = 'set-' + s.key;
    let control;
    if (t === 'boolean') {
      const input = h('input.adm-switch__input', { type: 'checkbox', role: 'switch', id, checked: s.value, 'aria-describedby': id + '-d' });
      const text = h('span.adm-switch__text', s.value ? 'On' : 'Off');
      input.addEventListener('change', async () => {
        const v = input.checked;
        const ok = await dialog({ title: `Turn ${v ? 'on' : 'off'} ${humanKey(s.key).toLowerCase()}?`, text: s.description, confirm: v ? 'Turn on' : 'Turn off' });
        if (!ok) { input.checked = !v; return; }
        input.disabled = true;
        try { await rpc('admin_update_setting', { p_key: s.key, p_value: v }); text.textContent = v ? 'On' : 'Off'; toast(`${humanKey(s.key)} turned ${v ? 'on' : 'off'}.`); app.refresh(); }
        catch (e) { input.checked = !v; toast(friendly(e), 'error'); }
        finally { input.disabled = false; }
      });
      control = h('label.adm-switch', { for: id }, input, h('span.adm-switch__track', { 'aria-hidden': 'true' }), text);
    } else {
      const multi = t === 'object' || t === 'array';
      const input = multi
        ? h('textarea.field__input.adm-json-input', { id, rows: Math.min(8, JSON.stringify(s.value, null, 2).split('\n').length + 1), spellcheck: 'false', 'aria-describedby': id + '-d' }, JSON.stringify(s.value, null, 2))
        : h('input.field__input', { id, type: t === 'number' ? 'number' : 'text', step: t === 'number' ? 'any' : null, inputmode: t === 'number' ? 'decimal' : null, value: String(s.value), 'aria-describedby': id + '-d' });
      const err = h('p.field__error', { hidden: true });
      const btn = h('button.btn.btn--secondary.btn--sm', { type: 'submit', disabled: true }, 'Save');
      const original = input.value;
      input.addEventListener('input', () => { btn.disabled = input.value === original; err.hidden = true; input.removeAttribute('aria-invalid'); });
      control = h('form.adm-setting__form', { novalidate: true, onsubmit: (e) => {
        e.preventDefault();
        let v;
        const fail = (m) => { err.textContent = m; err.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); };
        if (t === 'number') { if (input.value.trim() === '' || !Number.isFinite(Number(input.value))) return fail('Enter a number.'); v = Number(input.value); }
        else if (multi) {
          try { v = JSON.parse(input.value); } catch { return fail('This isn\'t valid JSON. Check the brackets, commas and quotes.'); }
          if ((t === 'array') !== Array.isArray(v) || typeof v !== 'object' || v === null) return fail(t === 'array' ? 'Keep it as a list in square brackets.' : 'Keep it as an object in curly brackets.');
        } else { if (!input.value.trim()) return fail('Enter a value.'); v = input.value.trim(); }
        save(btn, s, v);
      } }, h('label.visually-hidden', { for: id }, humanKey(s.key)), input, btn, err);
    }
    desc.id = id + '-d';
    return h('article.adm-setting', { dataset: { key: s.key } }, head, desc, control, changed(s));
  };

  const modeCard = (s) => {
    const current = s.value;
    const opts = [['direct', 'Direct', 'NGOs pay the business by Raast or bank transfer, and the business confirms the money arrived. No payouts.'],
      ['payfast', 'PayFast', 'NGOs pay through the gateway. We hold the money and pay businesses in Monday and Thursday batches.']];
    const radios = opts.map(([v, title, text]) => h('label.adm-choice', { class: v === current ? 'is-current' : '' },
      h('input', { type: 'radio', name: 'payment_mode', value: v, checked: v === current }),
      h('span', h('span.adm-choice__title', title, v === current ? h('span.chip', 'Current') : null), h('span.adm-choice__text', text))));
    const btn = h('button.btn.btn--danger.btn--sm', { type: 'submit', disabled: true }, 'Switch payment mode');
    const form = h('form.adm-setting__form.adm-setting__form--stack', { novalidate: true }, h('fieldset.adm-choices', h('legend.visually-hidden', 'Payment mode'), radios), btn);
    form.addEventListener('change', () => { btn.disabled = form.payment_mode.value === current; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = form.payment_mode.value;
      const ok = await dialog({ title: `Switch to ${v === 'payfast' ? 'PayFast' : 'direct'} payments?`, danger: true, confirm: 'Switch payment mode',
        text: 'Every new claim uses the new mode straight away. Claims already made keep their mode. Only switch after telling businesses and NGOs.' });
      if (ok) save(btn, s, v);
    });
    return h('article.adm-setting.adm-setting--mode', { dataset: { key: s.key } },
      h('div.adm-setting__head', h('h3.adm-setting__key', 'Payment mode'), h('code.adm-setting__code', s.key)),
      h('p.adm-setting__desc', s.description),
      notice('warning', 'This changes how every NGO pays from the next claim. Switch only when the gateway is ready and partners have been told.'),
      form, changed(s));
  };

  const hours = (v) => (v === null || v === undefined ? 'not allowed' : `${v} h`);
  return h('section.app-narrow',
    pageHead('Settings', 'Every change is saved straight away and recorded in the audit log.', h('a.btn.btn--secondary.btn--sm', { href: '#/admin/audit' }, 'Audit log')),
    h('div.adm-settings', first.map(modeCard), rest.map(card)),
    section('Food categories', h('p.app-muted', 'Read-only. Time limits are hours from preparation or opening. They change only with a database update.'),
      h('ul.adm-rows', cats.map((c) => h('li.adm-row.adm-row--static', h('div.adm-row__main', h('p.adm-row__title', c.name),
        h('p.adm-row__meta', c.uses_label_date ? 'Uses the label date' : `Room ${hours(c.max_hours_room)} · Hot ${hours(c.max_hours_hot)} · Chilled ${hours(c.max_hours_chilled)}`)),
      h('div.adm-row__end', h('span.chip', { 'data-opens': c.opens }, { pilot: 'Open in pilot', cooked: 'Opens with cooked food', phase2: 'Phase 2' }[c.opens] || c.opens)))))));
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
const ACTIONS = {
  create_organisation: 'Organisation created', update_organisation: 'Organisation details changed', set_org_status: 'Organisation status changed',
  review_document: 'Document reviewed', remove_listing: 'Listing removed', cancel_order: 'Order cancelled', decide_dispute: 'Problem decided',
  forgive_strike: 'Strike forgiven', update_setting: 'Setting changed', approve_refund: 'Refund approved', refund_sent: 'Refund sent',
  approve_payout: 'Payout approved', payout_sent: 'Payout sent', reissue_code: 'Pickup code reissued',
};
const AUDIT_LINKS = { organisations: '/admin/organisations/', orders: '/admin/orders/', disputes: '/admin/disputes/', payouts: '/admin/payouts/', settings: '/admin/settings' };

async function audit({ query }) {
  const list = await select(db.from('audit_log').select('*').order('id', { ascending: false }).limit(200));
  const names = await profileNames(list.map((a) => a.actor));
  const actions = [...new Set(list.map((a) => a.action))].sort();
  const filter = field({ name: 'action', label: 'Action', type: 'select', value: query.action || '', placeholder: 'All actions', options: actions.map((a) => ({ value: a, label: ACTIONS[a] || a })) });
  const box = h('div');
  const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
  const render = () => {
    const a = filter.value();
    history.replaceState(null, '', '#/admin/audit' + (a ? '?action=' + encodeURIComponent(a) : ''));
    const shown = list.filter((x) => !a || x.action === a);
    box.replaceChildren(shown.length ? h('ul.adm-rows.adm-audit', shown.map((x) => {
      const target = AUDIT_LINKS[x.table_name];
      const what = x.table_name === 'settings' ? x.row_id : x.row_id ? (x.table_name === 'orders' ? ref(x.row_id) : String(x.row_id).slice(0, 8)) : null;
      return h('li.adm-row.adm-row--static', { dataset: { action: x.action } }, h('div.adm-row__main',
        h('p.adm-row__title', ACTIONS[x.action] || x.action, what ? [' · ', target ? h('a', { href: '#' + target + (x.table_name === 'settings' ? '' : x.row_id) }, what) : what] : null),
        h('p.adm-row__meta', `${dateTime(x.created_at)} · ${x.actor ? names[x.actor] || 'A user' : 'System'}`),
        x.before !== null || x.after !== null ? h('div.adm-json',
          x.before !== null ? h('p', h('span.adm-json__label', 'Before'), h('code', json(x.before))) : null,
          x.after !== null ? h('p', h('span.adm-json__label', 'After'), h('code', json(x.after))) : null) : null));
    })) : empty('Nothing recorded', a ? 'Choose another action.' : null));
  };
  filter.input.addEventListener('change', render);
  render();
  return h('section', pageHead('Audit log', 'The latest 200 admin actions and changes. Read-only.'), h('div.app-filters', filter.wrap), box);
}

