// Rizq Rasan app: routing, the app header and start-up.
import { db, configured, clientMissing, state, loadState, h, icon, spinner, empty, toast, friendly, go, link } from './core.js';
import * as auth from './auth.js';
import * as onboarding from './onboarding.js';
import * as account from './account.js';
import * as vendor from './vendor.js';
import * as ngo from './ngo.js';
import * as admin from './admin.js';

const view = document.getElementById('app-view');
const nav = document.getElementById('app-nav');
const routes = [];

function register(path, def) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ path, re, keys, ...def });
}
[auth, onboarding, account, vendor, ngo, admin].forEach((m) => m.routes(register));

// Where someone lands, given who they are.
function homeFor() {
  if (!state.user) return '/login';
  if (state.admin && !state.org) return '/admin';
  if (!state.org) return '/start';
  if (state.org.status !== 'approved') return '/onboarding';
  return state.role === 'vendor' ? '/vendor' : '/ngo';
}

const NAV = {
  vendor: [['/vendor', 'Today'], ['/vendor/listings', 'Listings'], ['/vendor/new', 'List food'], ['/vendor/pickups', 'Pickups'], ['/vendor/earnings', 'Earnings']],
  ngo: [['/ngo', 'Find food'], ['/ngo/claims', 'My claims'], ['/ngo/collectors', 'Collectors']],
  admin: [['/admin', 'Overview'], ['/admin/verifications', 'Verifications'], ['/admin/organisations', 'Organisations'], ['/admin/orders', 'Orders'],
    ['/admin/disputes', 'Problems'], ['/admin/payments', 'Payments'], ['/admin/payouts', 'Payouts'], ['/admin/settings', 'Settings']],
};

let unread = 0;
function renderNav(current) {
  nav.replaceChildren();
  if (!state.user) return;
  const items = [];
  if (state.org && state.org.status === 'approved') items.push(...NAV[state.role]);
  if (state.admin) items.push(...(state.org ? [['/admin', 'Admin']] : NAV.admin));
  const list = h('ul.app-nav__list');
  for (const [path, label] of items) {
    const active = current === path || (path !== '/vendor' && path !== '/ngo' && path !== '/admin' && current.startsWith(path));
    list.append(h('li', h('a.app-nav__link', { href: '#' + path, 'aria-current': active ? 'page' : null }, label)));
  }
  const bell = h('a.app-bell', { href: '#/notifications', 'aria-label': unread ? `Notifications, ${unread} unread` : 'Notifications' },
    icon('bell', 22), unread ? h('span.app-bell__count', unread > 9 ? '9+' : String(unread)) : null);
  const me = h('a.app-me', { href: '#/account' }, h('span.app-me__name', state.profile?.full_name || state.user.email), state.org ? h('span.app-me__org', state.org.name) : null);
  nav.append(list, h('div.app-nav__end', bell, me));
}

async function countUnread() {
  if (!state.user) return;
  const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  unread = count || 0;
}

let realtime;
function listen() {
  if (realtime || !state.user) return;
  realtime = db.channel('me')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.user.id}` }, (p) => {
      unread++; renderNav(currentPath());
      toast(p.new.title);
    })
    .subscribe();
}

const currentPath = () => (location.hash.slice(1) || '/').split('?')[0];

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  if (path === '/' || path === '') { go(homeFor()); return; }
  const match = routes.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  renderNav(path);
  if (!match) { document.body.dataset.layout = ''; show(empty('Page not found', 'This page doesn\'t exist in the app.', link(homeFor(), 'Go to your home page'))); return; }
  const { r, m } = match;

  // Access rules for screens (the database enforces the real rules).
  if (!r.public && !state.user) { sessionStorage.setItem('rr-after-login', path); go('/login'); return; }
  if (r.guestOnly && state.user) { go(homeFor()); return; }
  if (r.roles) {
    const allowed = r.roles.some((role) => (role === 'admin' && state.admin) || (role === state.role && state.org?.status === 'approved'));
    if (!allowed) { go(homeFor()); return; }
  }

  document.title = `${r.title || 'Rizq Rasan'} · Rizq Rasan`;
  // Sign-in screens fill the window and bring their own brand panel.
  document.body.dataset.layout = r.layout || '';
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  show(spinner());
  try {
    const node = await r.render({ params, query, state, app: { refresh: render, reload } });
    if (token === renderToken) show(node);
  } catch (e) {
    if (token === renderToken) show(empty('Something went wrong', friendly(e), h('button.btn.btn--secondary', { type: 'button', onclick: render }, 'Try again')));
  }
}

function show(node) {
  view.replaceChildren(node);
  view.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function reload() { await loadState(); await countUnread(); listen(); await render(); }

// Screens call this after changing who is signed in or the organisation's status.
window.addEventListener('rr:state', reload);

async function start() {
  if (!configured) {
    view.replaceChildren(h('div.app-empty',
      h('p.app-empty__title', 'The platform isn\'t connected yet'),
      h('p', 'Accounts open at launch. Until then, register your interest and we\'ll invite you.'),
      h('p', h('a.btn.btn--primary', { href: '../join/' }, 'Register your interest'))));
    return;
  }
  if (clientMissing) {
    show(empty('The app didn\'t load', 'Part of the app was blocked from loading. Turn off any ad or script blocker for this site, then reload.',
      h('button.btn.btn--secondary', { type: 'button', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  show(spinner());
  db.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { go('/reset-password'); return; }
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') { realtime?.unsubscribe(); realtime = null; reload(); }
  });
  try {
    await withTimeout(loadState(), 15000);
    await countUnread().catch(() => {});
    listen();
  } catch (e) {
    show(empty('We couldn\'t load your account', friendly(e),
      h('button.btn.btn--secondary', { type: 'button', onclick: () => location.reload() }, 'Try again')));
    return;
  }
  window.addEventListener('hashchange', render);
  await render();
  window.addEventListener('rr:read', async () => { await countUnread(); renderNav(currentPath()); });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('The server took too long to answer. Check your connection and try again.')), ms))]);
}

start();
