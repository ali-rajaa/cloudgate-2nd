// Sign in, sign up and password reset, on a split screen: the brand on one
// side, the form on the other. On phones the brand shrinks to a top bar.
import { db, config, h, field, busy, toast, friendly, go, link, notice, normalisePhone, loadState } from './core.js';

export function routes(register) {
  const auth = { public: true, layout: 'auth' };
  register('/login', { ...auth, title: 'Log in', guestOnly: true, render: login });
  register('/signup', { ...auth, title: 'Create an account', guestOnly: true, render: signup });
  register('/signup/:type', { ...auth, title: 'Create an account', guestOnly: true, render: signup });
  register('/check-email', { ...auth, title: 'Check your email', render: checkEmail });
  register('/forgot-password', { ...auth, title: 'Reset your password', render: forgot });
  register('/reset-password', { ...auth, title: 'Choose a new password', render: reset });
}

const redirectBase = () => location.href.split('#')[0];
const site = (path = '') => (config.siteUrl || '/') + path;

// ---------------------------------------------------------------------------
// The two halves of the screen
// ---------------------------------------------------------------------------
function brand() {
  const logo = document.querySelector('.app-header .logo-mark')?.cloneNode(true);
  const step = (n, verb, text) => h('li.auth-brand__step', h('span.auth-brand__num', n), h('p', h('strong', verb), ' ', text));
  return h('aside.auth-brand', { 'aria-label': 'Rizq Rasan' },
    h('a.auth-brand__logo', { href: site() }, logo, h('span', 'Rizq Rasan')),
    h('span.auth-brand__mini', { lang: 'ur', dir: 'rtl', translate: 'no', 'aria-hidden': 'true' }, 'رزق رسان'),
    h('div.auth-brand__body',
      h('p.auth-brand__urdu', { lang: 'ur', dir: 'rtl', translate: 'no' }, 'رزق رسان'),
      h('p.auth-brand__headline', 'From surplus to sustenance.'),
      h('ol.auth-brand__steps',
        step('01', 'List.', 'Businesses list good food left at the end of the day.'),
        step('02', 'Claim.', 'Verified NGOs claim it and pay a fraction of the price.'),
        step('03', 'Collect.', 'A four-digit code confirms every handover.'))),
    h('p.auth-brand__foot', 'Islamabad. Every account is checked by a person.'));
}

// The Log in / Create account switch. The thumb slides from the last tab.
let lastTab = null;
function tabs(tab) {
  const nav = h('nav.auth-switch', { 'aria-label': 'Log in or create an account', dataset: { active: lastTab || tab } },
    h('a.auth-switch__option', { href: '#/login', 'aria-current': tab === 'login' ? 'page' : null }, 'Log in'),
    h('a.auth-switch__option', { href: '#/signup', 'aria-current': tab === 'signup' ? 'page' : null }, 'Create account'));
  if (lastTab && lastTab !== tab) requestAnimationFrame(() => requestAnimationFrame(() => { nav.dataset.active = tab; }));
  lastTab = tab;
  return nav;
}

function screen({ tab, title, lead, body, foot }) {
  if (!tab) lastTab = null;
  return h('div.auth',
    brand(),
    h('section.auth-panel',
      h('div.auth-panel__inner',
        tab ? tabs(tab) : null,
        h('header.auth-head', h('h1.auth-title', title), lead ? h('p.auth-lead', lead) : null),
        body,
        foot ? h('div.auth-foot', foot) : null)));
}

// A password box with a Show/Hide button inside it, and an optional link
// on the label row (Forgot password?).
function passwordField({ label, autocomplete, hint, aside }) {
  const f = field({ name: 'password', label, type: 'password', required: true, autocomplete, hint });
  const toggle = h('button.auth-reveal', { type: 'button', 'aria-controls': f.input.id }, 'Show');
  toggle.addEventListener('click', () => {
    const show = f.input.type === 'password';
    f.input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
  });
  const box = h('div.auth-reveal-box');
  f.input.replaceWith(box);
  box.append(f.input, toggle);
  if (aside) {
    const labelEl = f.wrap.querySelector('.field__label');
    const row = h('div.auth-label-row');
    labelEl.replaceWith(row);
    row.append(labelEl, aside);
  }
  return f;
}

const submitButton = (text) => h('button.btn.btn--primary.btn--block.auth-submit', { type: 'submit' }, text);

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function login() {
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@example.com' });
  const password = passwordField({ label: 'Password', autocomplete: 'current-password', aside: link('/forgot-password', 'Forgot password?') });
  const submit = submitButton('Log in');
  const form = h('form.app-form.auth-form', { novalidate: true }, email.wrap, password.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!email.value()) return email.error('Enter your email address.');
    if (!password.value()) return password.error('Enter your password.');
    busy(submit, async () => {
      const { error } = await db.auth.signInWithPassword({ email: email.value(), password: password.value() });
      if (error) {
        if (/confirm/i.test(error.message)) return password.error('Confirm your email first. We sent you a link when you signed up.');
        return password.error('That email and password don\'t match an account.');
      }
      const after = sessionStorage.getItem('rr-after-login');
      sessionStorage.removeItem('rr-after-login');
      await loadState();
      go(after && after !== '/login' ? after : '/');
    });
  });
  return screen({
    tab: 'login',
    title: 'Welcome back',
    lead: 'Log in to list food, claim it, or check on an order.',
    body: form,
    foot: h('p', 'Trouble logging in? ', h('a', { href: site('contact/') }, 'Contact us')),
  });
}

function signup({ params }) {
  let type = params.type === 'vendor' || params.type === 'ngo' ? params.type : null;
  const orgLabel = () => (type === 'ngo' ? 'Organisation name' : type === 'vendor' ? 'Business name' : 'Business or organisation name');
  const agreement = () => (type === 'ngo' ? ['legal/ngo-agreement/', 'NGO Agreement'] : type === 'vendor' ? ['legal/vendor-agreement/', 'Vendor Agreement'] : ['legal/', 'Vendor or NGO Agreement']);

  const option = (value, title, text) => h('label.auth-type__option',
    h('input.auth-type__input', { type: 'radio', name: 'type', value, checked: type === value }),
    h('span.auth-type__title', title),
    h('span.auth-type__text', text));
  const typeError = h('p.field__error', { hidden: true });
  const types = h('fieldset.auth-type',
    h('legend.field__label', 'Which describes you?'),
    h('div.auth-type__options',
      option('vendor', 'Food business', 'Restaurant, bakery, grocer or cafe'),
      option('ngo', 'NGO or charity', 'Shelter, food bank or community kitchen')),
    typeError);

  const name = field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name' });
  const phone = field({ name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national', placeholder: '0300 1234567' });
  const org = field({ name: 'org', label: orgLabel(), required: true, autocomplete: 'organization' });
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@example.com' });
  const password = passwordField({ label: 'Password', autocomplete: 'new-password', hint: 'At least 8 characters.' });
  const terms = field({ name: 'terms', label: '', type: 'checkbox' });
  const agreementLink = h('a', { href: site(agreement()[0]), target: '_blank' }, agreement()[1]);
  terms.wrap.querySelector('label').append('I agree to the ', h('a', { href: site('legal/terms/'), target: '_blank' }, 'Terms of Service'),
    ', the ', agreementLink, ' and the ', h('a', { href: site('legal/privacy/'), target: '_blank' }, 'Privacy Policy'), '.');

  types.addEventListener('change', (e) => {
    type = e.target.value;
    typeError.hidden = true;
    org.wrap.querySelector('.field__label').firstChild.textContent = orgLabel();
    [agreementLink.href, agreementLink.textContent] = [site(agreement()[0]), agreement()[1]];
    history.replaceState(null, '', '#/signup/' + type);
  });

  const submit = submitButton('Create account');
  const form = h('form.app-form.auth-form', { novalidate: true },
    types, h('div.auth-row', name.wrap, phone.wrap), org.wrap, email.wrap, password.wrap, terms.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let bad = false;
    if (!type) { typeError.textContent = 'Choose the one that describes you.'; typeError.hidden = false; bad = true; }
    if (!name.value()) { name.error('Enter your name.'); bad = true; }
    const tel = normalisePhone(phone.value());
    if (!tel) { phone.error('Enter a Pakistani mobile number, like 0300 1234567.'); bad = true; }
    if (org.value().length < 2) { org.error('Enter the name people know you by.'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value())) { email.error('Enter an email address like name@example.com.'); bad = true; }
    if (password.value().length < 8) { password.error('Use at least 8 characters.'); bad = true; }
    if (!terms.value()) { terms.error('Please agree to continue.'); bad = true; }
    if (bad) { (type ? form.querySelector('[aria-invalid="true"]') : form.querySelector('.auth-type__input'))?.focus(); return; }
    busy(submit, async () => {
      localStorage.setItem('rr-pending-org', JSON.stringify({ type, name: org.value(), phone: tel }));
      const { data, error } = await db.auth.signUp({
        email: email.value(), password: password.value(),
        options: { data: { full_name: name.value(), phone: tel }, emailRedirectTo: redirectBase() + '#/start' },
      });
      if (error) {
        if (/registered|exists/i.test(error.message)) return email.error('An account with this email already exists. Log in instead.');
        if (/password/i.test(error.message)) return password.error(friendly(error));
        throw error;
      }
      if (data.session) { window.dispatchEvent(new Event('rr:state')); go('/start'); }
      else { sessionStorage.setItem('rr-signup-email', email.value()); go('/check-email'); }
    });
  });

  return screen({
    tab: 'signup',
    title: 'Create your account',
    lead: 'Two minutes now. Next you add your documents, and we check every account within 2 working days.',
    body: form,
  });
}

function checkEmail() {
  const email = sessionStorage.getItem('rr-signup-email');
  return screen({
    title: 'Check your email',
    lead: 'Open the link we sent to confirm your address and carry on setting up. Use this device if you can.',
    body: h('div.auth-stack',
      h('div.auth-sent', h('span.auth-sent__label', 'Sent to'), h('span.auth-sent__email', email || 'your email address')),
      notice('info', 'Nothing after a few minutes? Check your spam folder, or log in to have it sent again.')),
    foot: h('p', link('/login', 'Back to log in')),
  });
}

function forgot() {
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@example.com' });
  const submit = submitButton('Send reset link');
  const form = h('form.app-form.auth-form', { novalidate: true }, email.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!email.value()) return email.error('Enter your email address.');
    busy(submit, async () => {
      await db.auth.resetPasswordForEmail(email.value(), { redirectTo: redirectBase() + '#/reset-password' });
      form.replaceWith(notice('info', 'If that email has an account, a reset link is on its way. It works once and expires in an hour.'));
    });
  });
  return screen({
    title: 'Reset your password',
    lead: 'Enter the email you signed up with and we\'ll send you a link to choose a new one.',
    body: form,
    foot: h('p', link('/login', 'Back to log in')),
  });
}

function reset() {
  const password = passwordField({ label: 'New password', autocomplete: 'new-password', hint: 'At least 8 characters.' });
  const submit = submitButton('Save new password');
  const form = h('form.app-form.auth-form', { novalidate: true }, password.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (password.value().length < 8) return password.error('Use at least 8 characters.');
    busy(submit, async () => {
      const { error } = await db.auth.updateUser({ password: password.value() });
      if (error) throw error;
      toast('Password changed.');
      go('/');
    });
  });
  return screen({ title: 'Choose a new password', lead: 'You\'ll stay logged in on this device.', body: form });
}
