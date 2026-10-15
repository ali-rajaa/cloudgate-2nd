// My account, notifications and problem reports (shared by both sides).
import { db, state, h, field, busy, toast, rpc, select, pageHead, empty, dateTime, normalisePhone, phoneDisplay, notice, badge, signOut } from './core.js';
import { passwordStrength, personalWords } from './validate.js';

export function routes(register) {
  register('/account', { title: 'My account', render: account });
  register('/notifications', { title: 'Notifications', render: notifications });
  register('/disputes/:id', { title: 'Problem report', render: dispute });
}

async function account({ app }) {
  const name = field({ name: 'name', label: 'Your name', required: true, value: state.profile?.full_name || '' });
  const phone = field({ name: 'phone', label: 'Mobile number', type: 'tel', value: phoneDisplay(state.profile?.phone), inputmode: 'tel' });
  const save = h('button.btn.btn--primary', { type: 'submit' }, 'Save');
  const form = h('form.app-form.card', { novalidate: true }, h('div.form__grid', name.wrap, phone.wrap), save);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tel = phone.value() ? normalisePhone(phone.value()) : null;
    if (phone.value() && !tel) return phone.error('Enter a Pakistani mobile number, like 0300 1234567.');
    if (!name.value()) return name.error('Enter your name.');
    busy(save, async () => {
      const { error } = await db.from('profiles').update({ full_name: name.value(), phone: tel }).eq('id', state.user.id);
      if (error) throw error;
      toast('Saved.'); window.dispatchEvent(new Event('rr:state'));
    });
  });

  const pw = field({ name: 'pw', label: 'New password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters. Longer is stronger: a few unrelated words work well.' });
  const pwBtn = h('button.btn.btn--secondary', { type: 'submit' }, 'Change password');
  const pwForm = h('form.app-form.card', { novalidate: true }, pw.wrap, pwBtn);
  pwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // The same rules as sign up, and never trimmed.
    const value = pw.input.value;
    const problem = passwordStrength(value, personalWords({ email: state.user.email, name: state.profile?.full_name || '', org: state.org?.name || '' })).problem;
    if (problem) { pw.error(problem); pw.input.focus(); return; }
    busy(pwBtn, async () => { const { error } = await db.auth.updateUser({ password: value }); if (error) throw error; pw.input.value = ''; toast('Password changed.'); });
  });

  const out = h('button.btn.btn--secondary', { type: 'button', onclick: () => busy(out, () => signOut()) }, 'Log out');
  const outAll = h('button.btn.btn--secondary', { type: 'button', onclick: () => busy(outAll, () => signOut('global')) }, 'Log out on every device');

  return h('section.app-narrow',
    pageHead('My account', state.user.email),
    state.org ? h('p.app-muted', state.org.name, ' · ', state.membershipRole === 'owner' ? 'Owner' : 'Staff', ' · ', h('a', { href: '#/onboarding' }, 'Organisation details')) : null,
    h('section.app-section', h('h2.app-h2', 'Your details'), form),
    h('section.app-section', h('h2.app-h2', 'Password'), pwForm),
    h('section.app-section', h('div.button-row', out, outAll)),
    h('p.app-muted', 'To close your account and delete your data, email us. Some records must be kept by law; see the ', h('a', { href: '../legal/data-retention/' }, 'Data Retention Policy'), '.'));
}

async function notifications() {
  const rows = await select(db.from('notifications').select('*').order('created_at', { ascending: false }).limit(100));
  const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);
  if (unreadIds.length) {
    await db.from('notifications').update({ read_at: new Date().toISOString() }).in('id', unreadIds);
    window.dispatchEvent(new Event('rr:read'));
  }
  if (!rows.length) return h('section.app-narrow', pageHead('Notifications'), empty('Nothing yet', 'Claims, payments and pickups will show up here.'));
  return h('section.app-narrow', pageHead('Notifications'),
    h('ul.app-list', rows.map((n) => h('li.app-list__item', { class: n.read_at ? '' : 'is-unread' },
      h('div', h('p.app-list__title', n.title), h('p.app-list__text', n.body), h('p.app-list__meta', dateTime(n.created_at))),
      n.link ? h('a.btn.btn--secondary.btn--sm', { href: '#' + n.link }, 'Open') : null))));
}

async function dispute({ params, app }) {
  const d = await select(db.from('disputes').select('*').eq('id', params.id).maybeSingle());
  if (!d) return empty('Report not found', null);
  const details = await rpc('order_details', { p_order: d.order_id });
  const mine = state.org && d.raised_by_org === state.org.id;
  const parts = [
    pageHead('Problem report', details.listing.title, badge(d.status === 'decided' ? 'completed' : 'payment_processing')),
    h('dl.key-facts',
      h('div', h('dt', 'Reported'), h('dd', dateTime(d.created_at))),
      h('div', h('dt', 'Type'), h('dd', d.kind.replace(/_/g, ' '))),
      h('div', h('dt', 'Order'), h('dd', details.reference)),
      h('div', h('dt', 'Status'), h('dd', d.status === 'decided' ? 'Decided' : d.status === 'awaiting_reply' ? 'Waiting for the other side' : 'With our team'))),
    h('section.app-section', h('h2.app-h2', 'What was reported'), h('p', d.details)),
    d.reply ? h('section.app-section', h('h2.app-h2', 'Reply'), h('p', d.reply)) : null,
    d.decision ? h('section.app-section', h('h2.app-h2', 'Our decision'), h('p', d.decision), d.refund_rs ? h('p', 'Refund: Rs ' + d.refund_rs.toLocaleString('en-US')) : null) : null,
  ];
  if (!mine && d.status === 'awaiting_reply' && !d.reply) {
    const reply = field({ name: 'reply', label: 'Your side', type: 'textarea', required: true, rows: 4 });
    const send = h('button.btn.btn--primary', { type: 'submit' }, 'Send reply');
    const f = h('form.app-form.card', { novalidate: true }, reply.wrap, send);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (reply.value().length < 5) return reply.error('Write a sentence or two.');
      busy(send, async () => { await rpc('reply_to_problem', { p_dispute: d.id, p_reply: reply.value() }); toast('Reply sent.'); app.refresh(); });
    });
    parts.push(notice('info', 'Please reply within 24 hours. Our team decides within 48 hours (24 hours for food safety).'), f);
  }
  return h('section.app-narrow', parts);
}
