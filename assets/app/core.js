// Rizq Rasan app: shared core. Every screen module imports from here.
//
// Contract for screen modules:
//   export function routes(register) { register('/vendor/listings', { title, roles: ['vendor'], render }) }
//   render(ctx) receives { params, query, app, state } and returns a Node (or a Promise of one).
//   Use h() to build elements, rpc() for database functions, db for table reads.

const cfgEl = document.getElementById('app-config');
export const config = cfgEl ? JSON.parse(cfgEl.textContent) : {};
export const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);

// The sign-in library can be blocked by an extension or a bad connection.
export const clientMissing = configured && !window.supabase;
export const db = configured && !clientMissing
  ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce',
        // The default cross-tab browser lock can wait forever when another tab is stuck,
        // which leaves the app blank. Run auth steps directly instead.
        lock: async (_name, _timeout, fn) => fn(),
      },
    })
  : null;

// ---------------------------------------------------------------------------
// State: who is signed in, their organisation, and whether they are an admin.
// ---------------------------------------------------------------------------
export const state = { session: null, user: null, profile: null, org: null, role: null, membershipRole: null, admin: false, loaded: false };

export async function loadState() {
  state.loaded = false;
  const { data: { session } } = await db.auth.getSession();
  state.session = session;
  state.user = session?.user ?? null;
  state.profile = state.org = state.role = state.membershipRole = null;
  state.admin = false;
  if (state.user) {
    const results = await Promise.all([
      db.from('profiles').select('*').eq('id', state.user.id).maybeSingle(),
      // A list, not a single row: an account with more than one (from before
      // one-per-person was enforced) must still load.
      db.from('memberships').select('role, organisation_id, created_at, organisations(*)').eq('user_id', state.user.id).order('created_at'),
      db.rpc('is_admin'),
    ]);
    // A failed lookup must not look like "no organisation yet": say so instead.
    const failed = results.find((r) => r.error);
    if (failed) throw new AppError(friendly(failed.error));
    const [{ data: profile }, { data: memberships }, { data: admin }] = results;
    // The organisation furthest along wins: approved, then anything past set-up, then the oldest.
    const rank = (m) => (m.organisations?.status === 'approved' ? 0 : m.organisations?.status === 'onboarding' ? 2 : 1);
    const membership = (memberships || []).filter((m) => m.organisations).sort((a, b) => rank(a) - rank(b))[0] || null;
    state.profile = profile;
    state.admin = Boolean(admin);
    if (membership) {
      state.org = membership.organisations;
      state.membershipRole = membership.role;
      state.role = state.org.type; // 'vendor' or 'ngo'
    }
  }
  state.loaded = true;
  return state;
}

// Sign out and forget everything about the previous person straight away.
export async function signOut(scope = 'local') {
  await db.auth.signOut({ scope });
  Object.assign(state, { session: null, user: null, profile: null, org: null, role: null, membershipRole: null, admin: false });
  sessionStorage.removeItem('rr-after-login');
  location.hash = '#/login';
}

export async function refreshOrg() {
  if (!state.org) return;
  const { data } = await db.from('organisations').select('*').eq('id', state.org.id).single();
  if (data) state.org = data;
}

// ---------------------------------------------------------------------------
// Calling database functions, with messages people can act on.
// ---------------------------------------------------------------------------
export class AppError extends Error {}

export function friendly(error) {
  if (!error) return '';
  const msg = String(error.message || error);
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'You seem to be offline. Check your connection and try again.';
  if (/JWT|not authenticated|Please sign in/i.test(msg)) return 'Your session has ended. Please sign in again.';
  if (/duplicate key/i.test(msg)) return 'That already exists.';
  if (/violates check constraint/i.test(msg)) return 'One of the values isn\'t allowed. Check the form and try again.';
  return msg.replace(/^.*?ERROR:\s*/, '');
}

export async function rpc(fn, args = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new AppError(friendly(error));
  return data;
}

export async function select(query) {
  const { data, error } = await query;
  if (error) throw new AppError(friendly(error));
  return data;
}

// ---------------------------------------------------------------------------
// Formatting (Pakistan time, rupees, phone numbers)
// ---------------------------------------------------------------------------
const TZ = 'Asia/Karachi';
export const rs = (n) => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-US');
export function time(t) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t)).replace(' ', ' ').toLowerCase();
}
export function date(t) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(t));
}
export const dateTime = (t) => `${time(t)}, ${date(t)}`;
export function minutesLeft(t) { return Math.round((new Date(t) - Date.now()) / 60000); }
export function untilText(t) {
  const m = minutesLeft(t);
  if (m <= 0) return 'ended';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
export function phoneDisplay(p) {
  const d = String(p || '').replace(/\D/g, '');
  const local = d.startsWith('92') ? '0' + d.slice(2) : d;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4)}` : p || '';
}
export { normalisePhone } from './validate.js';
// datetime-local input value in Pakistan time <-> ISO
export function toLocalInput(t) {
  const d = new Date(new Date(t).getTime() + 5 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}
export function fromLocalInput(v) {
  if (!v) return null;
  return new Date(new Date(v + ':00Z').getTime() - 5 * 3600 * 1000).toISOString();
}

export const STATUS_LABELS = {
  payment_due: 'Waiting for payment', payment_processing: 'Payment being confirmed', paid: 'Paid, ready to collect',
  awaiting_collection_answer: 'Did they collect?', picked_up: 'Handed over', completed: 'Completed',
  completed_unconfirmed: 'Completed (unconfirmed)', expired_unpaid: 'Expired unpaid', released: 'Released',
  cancelled_by_ngo: 'Cancelled by NGO', cancelled_by_vendor: 'Cancelled by business', refused_at_pickup: 'Refused at pickup',
  no_show: 'Not collected', live: 'Live', claimed: 'Claimed', expired: 'Ended', withdrawn: 'Withdrawn', removed: 'Removed', draft: 'Draft',
  onboarding: 'Setting up', pending_review: 'Waiting for review', needs_changes: 'Needs changes', approved: 'Approved',
  rejected: 'Not approved', suspended: 'Suspended',
};
export const statusLabel = (s) => STATUS_LABELS[s] || s;
export function statusTone(s) {
  if (['completed', 'paid', 'approved', 'live', 'picked_up'].includes(s)) return 'good';
  if (['payment_due', 'payment_processing', 'awaiting_collection_answer', 'pending_review', 'needs_changes', 'claimed', 'onboarding'].includes(s)) return 'wait';
  if (['refused_at_pickup', 'no_show', 'suspended', 'rejected', 'removed', 'cancelled_by_vendor'].includes(s)) return 'bad';
  return 'muted';
}

export function photoUrl(path) {
  return path ? db.storage.from('listing-photos').getPublicUrl(path).data.publicUrl : null;
}

// ---------------------------------------------------------------------------
// Building elements
//   h('div.card', { onclick }, 'text', child)  — tag with optional .classes and #id
// ---------------------------------------------------------------------------
export function h(spec, attrs, ...children) {
  const m = /^([a-z0-9-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.id = m[2].slice(1);
  if (m[3]) el.className = m[3].slice(1).split('.').join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, size = 20) {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 004 0"/>', key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 004.5 4.5L14.5 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z"/>',
    alert: '<path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17.5v.01"/>', camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>', users: '<circle cx="9" cy="9" r="3.5"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.5a3.5 3.5 0 010 7M18 14c2 .7 3 2.6 3 5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', back: '<path d="M19 12H5M11 6l-6 6 6 6"/>', doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z"/><path d="M5 19l7-7"/>', shield: '<path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
    'chevron-down': '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>', 'chevron-right': '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  };
  const span = document.createElement('span');
  span.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
  return span.firstChild;
}

export const badge = (status) => h('span.badge', { class: 'badge--' + statusTone(status) }, statusLabel(status));
export const empty = (title, text, action) => h('div.app-empty', h('p.app-empty__title', title), text ? h('p', text) : null, action || null);
export const spinner = () => h('div.app-loading', { role: 'status' }, h('span.activity.activity--large', { 'aria-hidden': 'true' }), h('span.visually-hidden', 'Loading'));

export function pageHead(title, lead, actions) {
  return h('header.app-page-head', h('div', h('h1.app-title', title), lead ? h('p.app-lead', lead) : null), actions ? h('div.app-page-actions', actions) : null);
}

export function notice(kind, text) {
  return h('div.notice', { class: kind === 'warning' ? 'notice--warning' : 'notice--info', role: kind === 'warning' ? 'alert' : 'note' }, icon(kind === 'warning' ? 'alert' : 'doc'), h('p', text));
}

// Tabs that filter a list in place.
export function tabs(items, active, onChange) {
  const bar = h('div.app-tabs', { role: 'tablist' });
  for (const it of items) {
    bar.append(h('button.app-tab', {
      type: 'button', role: 'tab', 'aria-selected': it.id === active ? 'true' : 'false',
      onclick: () => onChange(it.id),
    }, it.label, it.count !== undefined ? h('span.app-tab__count', String(it.count)) : null));
  }
  return bar;
}

// ---------------------------------------------------------------------------
// Toasts and dialogs
// ---------------------------------------------------------------------------
// The toast area exists from the start, so screen readers announce the first toast too.
const toastHost = h('div.app-toasts', { 'aria-live': 'polite' });
document.body.append(toastHost);
export function toast(text, kind = 'ok') {
  const t = h('div.app-toast', { class: 'app-toast--' + kind, role: kind === 'error' ? 'alert' : 'status' }, text);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('is-in'));
  setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3500);
}

// Promise-based dialog. fields: [{ name, label, type, required, options, value, hint }]
export function dialog({ title, text, confirm = 'Confirm', cancel = 'Cancel', danger = false, fields = [] }) {
  return new Promise((resolve) => {
    const form = h('form.app-dialog__body', { novalidate: true });
    const close = (value) => { d.close(); d.remove(); resolve(value); };
    const inputs = fields.map((f) => field(f));
    form.append(h('h2.app-dialog__title', title), text ? h('p', text) : null, ...inputs.map((i) => i.wrap),
      h('div.app-dialog__actions',
        h('button.btn.btn--secondary', { type: 'button', onclick: () => close(null) }, cancel),
        h('button.btn', { type: 'submit', class: danger ? 'btn--danger' : 'btn--primary' }, confirm)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const i of inputs) {
        const v = i.value();
        if (i.f.required && (v === '' || v === null || v === false)) { i.error('This is needed.'); i.input.focus(); return; }
        values[i.f.name] = v;
      }
      close(fields.length ? values : true);
    });
    const d = h('dialog.app-dialog', { onclose: () => resolve(null) }, form);
    document.body.append(d);
    d.showModal();
    (inputs[0]?.input || form.querySelector('[type=submit]')).focus();
  });
}

// One labelled form field. Returns { wrap, input, value(), error(), f }
export function field(f) {
  const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
  let input;
  if (f.type === 'select') {
    input = h('select.field__input', { id, name: f.name, required: f.required },
      h('option', { value: '' }, f.placeholder || 'Choose one'),
      (f.options || []).map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
  } else if (f.type === 'textarea') {
    input = h('textarea.field__input', { id, name: f.name, rows: f.rows || 3, required: f.required, placeholder: f.placeholder || '' }, f.value || '');
  } else if (f.type === 'checkbox') {
    input = h('input.check', { id, name: f.name, type: 'checkbox', checked: Boolean(f.value) });
  } else {
    input = h('input.field__input', { id, name: f.name, type: f.type || 'text', required: f.required, value: f.value ?? '',
      placeholder: f.placeholder || '', inputmode: f.inputmode, autocomplete: f.autocomplete, min: f.min, max: f.max, step: f.step, accept: f.accept });
  }
  const err = h('p.field__error', { id: id + '-error', hidden: true });
  const hint = f.hint ? h('p.field__hint', { id: id + '-hint' }, f.hint) : null;
  // Screen readers read the error when there is one, otherwise the hint.
  const describe = (bad) => {
    const ref = bad ? err.id : hint?.id;
    if (ref) input.setAttribute('aria-describedby', ref); else input.removeAttribute('aria-describedby');
  };
  describe(false);
  const wrap = f.type === 'checkbox'
    ? h('div.field.field--check', { class: f.full ? 'field--full' : '' }, input, h('label', { for: id }, f.label), err)
    : h('div.field', { class: f.full ? 'field--full' : '' }, h('label.field__label', { for: id }, f.label, f.required ? null : h('span.field__optional', ' (optional)')), input, hint, err);
  const api = {
    f, wrap, input,
    value: () => f.type === 'checkbox' ? input.checked : f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : f.type === 'file' ? input.files : input.value.trim(),
    error: (m) => { err.textContent = m || ''; err.hidden = !m; input.setAttribute('aria-invalid', m ? 'true' : 'false'); describe(Boolean(m)); },
  };
  input.addEventListener('input', () => api.error(''));
  return api;
}

// Disable a button while an async action runs, showing errors as toasts.
// The button shows a spinner (and `working` text, if given) and ignores
// further presses until the action finishes. It stays focusable, so keyboard
// and screen reader users don't lose their place.
export async function busy(button, fn, { working } = {}) {
  if (button.disabled || button.getAttribute('aria-busy') === 'true') return undefined;
  const label = button.innerHTML;
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  if (working) button.textContent = working;
  try { return await fn(); }
  catch (e) { toast(friendly(e), 'error'); return undefined; }
  finally {
    button.removeAttribute('aria-busy'); button.removeAttribute('aria-disabled');
    if (button.isConnected) button.innerHTML = label;
  }
}

export function go(path) { location.hash = '#' + path; }
// Like go(), but replaces the current history entry, so Back doesn't return to a screen that only forwards you on.
export function redirect(path) { location.replace('#' + path); }
export const link = (path, ...children) => h('a', { href: '#' + path }, ...children);

// Upload a file into a bucket under the organisation's folder. Images are
// resized on the phone first (which also strips location data).
export async function uploadFile(bucket, orgId, file, prefix = '') {
  let blob = file, ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
    blob = await shrinkImage(file, bucket === 'listing-photos' ? 1600 : 2200);
    ext = 'jpg';
  }
  const path = `${orgId}/${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from(bucket).upload(path, blob, { contentType: blob.type || file.type, upsert: false });
  if (error) throw new AppError(friendly(error));
  return path;
}

function shrinkImage(file, max) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}
