// Sign in, sign up and password reset, on a split screen: the brand on one
// side, the form on the other. On phones the brand shrinks to a top bar.
//
// How the forms behave:
// - A field is checked when you leave it, and again as you type once it has
//   shown a problem: errors appear late and clear early.
// - Submitting checks everything and moves focus to the first problem.
// - While a request runs, the button shows a spinner and ignores more presses.
//   After 6 seconds a note says the connection seems slow; after 30 seconds
//   we stop waiting and say so.
// - Problems from the server (wrong password, too many attempts, no
//   connection) show in one alert above the form, or under the field they
//   belong to.
// The checks themselves live in validate.js, which has its own unit tests.
import { db, config, state, h, field, busy, go, link, notice, icon, loadState } from './core.js';
import { emailProblem, suggestEmail, passwordStrength, personalWords, matchProblem, normalisePhone, phoneProblem, authError } from './validate.js';

export function routes(register) {
  const auth = { public: true, layout: 'auth' };
  register('/login', { ...auth, title: 'Log in', guestOnly: true, render: login });
  register('/signup', { ...auth, title: 'Create an account', guestOnly: true, render: signup });
  register('/signup/:type', { ...auth, title: 'Create an account', guestOnly: true, render: signup });
  register('/check-email', { ...auth, title: 'Check your email', render: checkEmail });
  register('/forgot-password', { ...auth, title: 'Reset your password', render: forgot });
  register('/reset-password', { ...auth, title: 'Choose a new password', render: reset });
  register('/logout', { ...auth, title: 'Log out', render: logout });
}

const redirectBase = () => location.href.split('#')[0];
const site = (path = '') => (config.siteUrl || '/') + path;
const SLOW_AFTER = 6000;
const GIVE_UP_AFTER = 30000;

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
      h('p.auth-brand__lead', 'Restaurants, bakeries and grocers list good food left at the end of the day. Verified NGOs claim it, and it gets eaten instead of thrown away.'),
      h('ol.auth-brand__steps',
        step('01', 'List.', 'Businesses list good food left at the end of the day.'),
        step('02', 'Claim.', 'Verified NGOs claim it and pay no more than half of retail.'),
        step('03', 'Collect.', 'A 4-digit pickup code confirms every handover.'))),
    h('p.auth-brand__foot', 'Islamabad. Every account is checked by a person.'));
}

// The Log in / Create account switch. When you tap a tab, the thumb carries
// on from wherever it is on screen (even mid-slide) to the new tab.
let thumbFrom = null;
function tabs(tab) {
  const nav = h('nav.auth-switch', { 'aria-label': 'Log in or create an account', dataset: { active: tab } },
    h('a.auth-switch__option', { href: '#/login', 'aria-current': tab === 'login' ? 'page' : null }, 'Log in'),
    h('a.auth-switch__option', { href: '#/signup', 'aria-current': tab === 'signup' ? 'page' : null }, 'Create account'));
  nav.addEventListener('click', (e) => {
    const option = e.target.closest('.auth-switch__option');
    if (!option) return;
    // Tapping the tab you're on would reload it and wipe what you typed.
    if (option.getAttribute('aria-current') === 'page') { e.preventDefault(); return; }
    thumbFrom = new DOMMatrix(getComputedStyle(nav, '::before').transform).m41;
  });
  if (thumbFrom !== null) {
    nav.style.setProperty('--thumb', thumbFrom + 'px');
    requestAnimationFrame(() => requestAnimationFrame(() => nav.style.removeProperty('--thumb')));
  }
  thumbFrom = null;
  return nav;
}

function screen({ tab, badge, title, lead, body, foot }) {
  return h('div.auth',
    brand(),
    h('section.auth-panel',
      h('div.auth-panel__inner',
        tab ? tabs(tab) : null,
        h('header.auth-head', badge ? h('span.auth-badge', icon(badge, 26)) : null, h('h1.auth-title', title), lead ? h('p.auth-lead', lead) : null),
        body,
        foot ? h('div.auth-foot', foot) : null)));
}

// ---------------------------------------------------------------------------
// Form parts
// ---------------------------------------------------------------------------

// Checks a field when you leave it (if you typed something), and on every
// change once it has shown a problem. f.validate() checks it now, as on submit.
function check(f, problemOf, { onBlur, blur = true } = {}) {
  let shown = false;
  const validate = () => { const m = problemOf(f.value()); f.error(m); shown = Boolean(m); return m; };
  if (blur) f.input.addEventListener('blur', () => { if (f.value() !== '' || shown) validate(); onBlur?.(); });
  f.input.addEventListener(f.input.type === 'checkbox' ? 'change' : 'input', () => { if (shown) validate(); });
  f.validate = validate;
  return f;
}

// Runs every check, then moves focus to the first problem. True if all passed.
function validateAll(fields) {
  let first = null;
  for (const f of fields) if (f.validate() && !first) first = f;
  first?.input.focus();
  return !first;
}

function emailField({ autocomplete }) {
  const f = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete, placeholder: 'name@example.com' });
  f.input.setAttribute('autocapitalize', 'none');
  f.input.setAttribute('spellcheck', 'false');
  // "Did you mean name@gmail.com?" for slips in well-known addresses.
  const tip = h('p.auth-suggest', { 'aria-live': 'polite' });
  f.wrap.append(tip);
  const suggest = () => {
    tip.replaceChildren();
    const better = !emailProblem(f.value()) && suggestEmail(f.value());
    if (!better) return;
    const use = h('button.auth-suggest__use', { type: 'button' }, better);
    use.addEventListener('click', () => { f.input.value = better; tip.replaceChildren(); f.validate(); f.input.focus(); });
    tip.append('Did you mean ', use, '?');
  };
  f.input.addEventListener('input', () => tip.replaceChildren());
  return check(f, emailProblem, { onBlur: suggest });
}

// A password box with a Show/Hide button inside it, which also reveals any
// boxes joined to it with f.join(). An optional link (Forgot password?) shows
// on the label row but comes after the box in tab order.
function passwordField({ name = 'password', label, autocomplete, hint, aside, reveal = true }) {
  const f = field({ name, label, type: 'password', required: true, autocomplete, hint });
  f.value = () => f.input.value; // never trim a password
  const box = h('div.auth-reveal-box');
  f.input.replaceWith(box);
  box.append(f.input);
  capsWarning(f);
  if (reveal) {
    const inputs = [f.input];
    const word = h('span', 'Show');
    const toggle = h('button.auth-reveal', { type: 'button', 'aria-controls': f.input.id }, word, h('span.visually-hidden', ' password'));
    toggle.addEventListener('click', () => {
      const show = f.input.type === 'password';
      inputs.forEach((i) => { i.type = show ? 'text' : 'password'; });
      word.textContent = show ? 'Hide' : 'Show';
    });
    box.append(toggle);
    f.join = (other) => {
      inputs.push(other.input);
      other.input.type = f.input.type;
      toggle.setAttribute('aria-controls', inputs.map((i) => i.id).join(' '));
    };
  } else {
    box.classList.add('auth-reveal-box--plain');
  }
  if (aside) {
    aside.classList.add('auth-aside');
    f.wrap.classList.add('field--aside');
    box.after(aside);
  }
  return f;
}

function capsWarning(f) {
  const note = h('p.auth-caps', { hidden: true }, icon('alert', 16), h('span', 'Caps Lock is on.'));
  f.wrap.append(note);
  const update = (e) => { if (e.getModifierState) note.hidden = !e.getModifierState('CapsLock'); };
  f.input.addEventListener('keydown', update);
  f.input.addEventListener('keyup', update);
  f.input.addEventListener('blur', () => { note.hidden = true; });
}

// Four bars and a word under a new password. Screen readers hear the word
// once typing pauses, not on every key.
function strengthMeter(f, avoid) {
  const text = h('span.auth-meter__text');
  const spoken = h('span.visually-hidden', { 'aria-live': 'polite' });
  const meter = h('div.auth-meter', { dataset: { score: '' } },
    h('span.auth-meter__bars', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')), text, spoken);
  f.input.closest('.auth-reveal-box').after(meter);
  let timer;
  const update = () => {
    const value = f.input.value;
    const r = passwordStrength(value, avoid());
    meter.dataset.score = value ? String(r.score) : '';
    text.textContent = value ? r.label : '';
    clearTimeout(timer);
    timer = setTimeout(() => { spoken.textContent = value ? `Password strength: ${r.label}` : ''; }, 900);
  };
  f.input.addEventListener('input', update);
  return update;
}

// The alert above a form and the status line under its button.
function formParts() {
  const alertEl = h('div.auth-alert', { role: 'alert', hidden: true });
  const status = h('p.auth-status', { role: 'status' });
  return {
    alertEl, status,
    alert(...message) { alertEl.replaceChildren(icon('alert', 18), h('p', ...message)); alertEl.hidden = false; },
    clear() { alertEl.hidden = true; alertEl.replaceChildren(); },
  };
}

// Sends a request with the button busy. Returns the response, or null when
// it failed before answering (the problem is already shown in the alert).
async function send(button, parts, working, request) {
  parts.clear();
  if (navigator.onLine === false) { parts.alert('You\'re offline. Connect to the internet and try again.'); return null; }
  const result = await busy(button, async () => {
    const slow = setTimeout(() => { parts.status.textContent = 'Still working. Your connection seems slow.'; }, SLOW_AFTER);
    let giveUp;
    try {
      return await Promise.race([request(), new Promise((_, reject) => { giveUp = setTimeout(() => reject(new Error('took too long')), GIVE_UP_AFTER); })]);
    } catch (e) {
      parts.alert(authError(e).message);
      return null;
    } finally {
      clearTimeout(slow);
      clearTimeout(giveUp);
      parts.status.textContent = '';
    }
  }, { working });
  return result ?? null;
}

const submitButton = (text) => h('button.btn.btn--primary.btn--block.auth-submit', { type: 'submit' }, text);

// ---------------------------------------------------------------------------
// Log in
// ---------------------------------------------------------------------------
function login() {
  const parts = formParts();
  const email = emailField({ autocomplete: 'username' });
  const password = check(passwordField({ label: 'Password', autocomplete: 'current-password', aside: link('/forgot-password', 'Forgot password?') }),
    (v) => (v ? '' : 'Enter your password.'), { blur: false });
  const submit = submitButton('Log in');
  const form = h('form.app-form.auth-form', { novalidate: true }, parts.alertEl, email.wrap, password.wrap, submit, parts.status);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateAll([email, password])) return;
    const res = await send(submit, parts, 'Logging in…', () => db.auth.signInWithPassword({ email: email.value(), password: password.value() }));
    if (!res) return;
    if (res.error) {
      const problem = authError(res.error);
      if (problem.field === 'confirm') {
        // Not confirmed yet: the next screen can send the link again.
        sessionStorage.setItem('rr-signup-email', email.value());
        go('/check-email');
        return;
      }
      if (/match an account/.test(problem.message)) {
        parts.alert('That email and password don\'t match an account. Check them and try again, or ', link('/forgot-password', 'reset your password'), '.');
      } else parts.alert(problem.message);
      password.input.focus();
      password.input.select();
      return;
    }
    const after = sessionStorage.getItem('rr-after-login');
    sessionStorage.removeItem('rr-after-login');
    parts.status.textContent = 'Logged in. Opening your account.';
    await loadState();
    go(after && after !== '/login' ? after : '/');
  });

  return screen({
    tab: 'login',
    title: 'Welcome back',
    lead: 'Log in to list food, claim it, or check on an order.',
    body: form,
    foot: h('p', 'Trouble logging in? ', h('a', { href: site('contact/') }, 'Contact us')),
  });
}

// ---------------------------------------------------------------------------
// Create an account
// ---------------------------------------------------------------------------
const PERSONA = {
  vendor: {
    org: 'Business name',
    agreement: ['legal/vendor-agreement/', 'Vendor Agreement'],
    note: 'No sign-up fee or monthly charge. Listing your surplus takes under a minute.',
  },
  ngo: {
    org: 'Organisation name',
    agreement: ['legal/ngo-agreement/', 'NGO Agreement'],
    note: 'Free to join. Every business is checked before it can list, and you pay only the listing price.',
  },
};
const NO_PERSONA = { org: 'Business or organisation name', agreement: ['legal/', 'Vendor or NGO Agreement'], note: '' };

function signup({ params }) {
  let type = PERSONA[params.type] ? params.type : null;
  const persona = () => PERSONA[type] || NO_PERSONA;
  const parts = formParts();

  // Who you are: two cards that work as radio buttons.
  const option = (value, title, text) => h('label.auth-type__option',
    h('input.auth-type__input', { type: 'radio', name: 'type', value, checked: type === value }),
    h('span.auth-type__title', title),
    h('span.auth-type__text', text));
  const typeError = h('p#type-error.field__error', { hidden: true });
  const personaNote = h('p.auth-persona', { 'aria-live': 'polite' }, persona().note);
  const types = h('fieldset.auth-type',
    h('legend.field__label', 'Which describes you?'),
    h('div.auth-type__options',
      option('vendor', 'Food business', 'Restaurant, bakery, grocer or cafe'),
      option('ngo', 'NGO or charity', 'Shelter, food bank or community kitchen')),
    typeError, personaNote);
  const radios = () => [...types.querySelectorAll('.auth-type__input')];
  const typeField = {
    get input() { return radios()[0]; },
    validate() {
      const m = type ? '' : 'Choose the one that describes you.';
      typeError.textContent = m;
      typeError.hidden = !m;
      radios().forEach((r) => {
        if (m) { r.setAttribute('aria-invalid', 'true'); r.setAttribute('aria-describedby', 'type-error'); }
        else { r.removeAttribute('aria-invalid'); r.removeAttribute('aria-describedby'); }
      });
      return m;
    },
  };

  const name = check(field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name' }), (v) => (v ? '' : 'Enter your name.'));
  const phone = check(field({ name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national', placeholder: '0300 1234567' }), phoneProblem);
  const org = check(field({ name: 'org', label: persona().org, required: true, autocomplete: 'organization' }), (v) => (v.length >= 2 ? '' : 'Enter the name people know you by.'));
  const email = emailField({ autocomplete: 'email' });
  const avoid = () => personalWords({ email: email.value(), name: name.value(), org: org.value() });
  const password = check(passwordField({ label: 'Password', autocomplete: 'new-password', hint: 'At least 8 characters. Longer is stronger: a few unrelated words work well.' }),
    (v) => passwordStrength(v, avoid()).problem);
  const confirm = check(passwordField({ name: 'confirm', label: 'Confirm password', autocomplete: 'new-password', reveal: false }),
    (v) => matchProblem(password.value(), v));
  password.join(confirm);
  const strength = strengthMeter(password, avoid);
  password.input.addEventListener('input', () => { if (confirm.input.getAttribute('aria-invalid') === 'true') confirm.validate(); });
  [name, email, org].forEach((f) => f.input.addEventListener('input', strength));

  const terms = check(field({ name: 'terms', label: '', type: 'checkbox' }), (v) => (v ? '' : 'Agree to the terms to continue.'), { blur: false });
  const agreementLink = h('a', { href: site(persona().agreement[0]), target: '_blank' }, persona().agreement[1]);
  terms.wrap.querySelector('label').append('I agree to the ', h('a', { href: site('legal/terms/'), target: '_blank' }, 'Terms of Service'),
    ', the ', agreementLink, ' and the ', h('a', { href: site('legal/privacy/'), target: '_blank' }, 'Privacy Policy'), '.');

  types.addEventListener('change', (e) => {
    type = e.target.value;
    typeField.validate();
    org.wrap.querySelector('.field__label').firstChild.textContent = persona().org;
    [agreementLink.href, agreementLink.textContent] = [site(persona().agreement[0]), persona().agreement[1]];
    personaNote.textContent = persona().note;
    history.replaceState(null, '', '#/signup/' + type);
  });

  const submit = submitButton('Create account');
  const trust = h('p.auth-trust', icon('lock', 16), h('span', 'We never sell your data, and your password is stored only in scrambled form.'));
  const form = h('form.app-form.auth-form', { novalidate: true },
    parts.alertEl, types, h('div.auth-row', name.wrap, phone.wrap), org.wrap, email.wrap, password.wrap, confirm.wrap, terms.wrap, submit, parts.status, trust);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateAll([typeField, name, phone, org, email, password, confirm, terms])) return;
    const tel = normalisePhone(phone.value());
    localStorage.setItem('rr-pending-org', JSON.stringify({ type, name: org.value(), phone: tel }));
    const res = await send(submit, parts, 'Creating your account…', () => db.auth.signUp({
      email: email.value(), password: password.value(),
      options: { data: { full_name: name.value(), phone: tel }, emailRedirectTo: redirectBase() + '#/start' },
    }));
    if (!res) return;
    if (res.error) {
      const problem = authError(res.error);
      if (problem.field === 'email') { email.error(problem.message); email.input.focus(); return; }
      if (problem.field === 'password') { password.error(problem.message); password.input.focus(); return; }
      parts.alert(problem.message);
      return;
    }
    if (res.data?.session) { window.dispatchEvent(new Event('rr:state')); go('/start'); }
    else { sessionStorage.setItem('rr-signup-email', email.value()); go('/check-email'); }
  });

  return screen({
    tab: 'signup',
    title: 'Create your account',
    lead: 'Two minutes now. Next you add your documents, and we check every account within 2 working days.',
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Check your email (after signing up, or logging in before confirming)
// ---------------------------------------------------------------------------
function checkEmail() {
  const email = sessionStorage.getItem('rr-signup-email');
  let body;
  if (email) {
    const parts = formParts();
    const again = h('button.btn.btn--secondary.btn--block', { type: 'button' }, 'Send the link again');
    // After sending, wait a minute before allowing another, so the email
    // service doesn't block the address for sending too often.
    const coolDown = (seconds) => {
      again.disabled = true;
      const tick = () => {
        if (!again.isConnected) return;
        if (seconds <= 0) { again.disabled = false; again.textContent = 'Send the link again'; return; }
        again.textContent = `Send again in ${seconds--}s`;
        setTimeout(tick, 1000);
      };
      tick();
    };
    again.addEventListener('click', async () => {
      const res = await send(again, parts, 'Sending…', () => db.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectBase() + '#/start' } }));
      if (!res) return;
      if (res.error) { parts.alert(authError(res.error).message); return; }
      parts.status.textContent = 'Sent. Check your inbox.';
      coolDown(60);
    });
    body = h('div.auth-stack',
      parts.alertEl,
      h('div.auth-sent', h('span.auth-sent__label', 'Sent to'), h('span.auth-sent__email', email)),
      notice('info', 'Nothing after a few minutes? Check your spam folder, then send it again.'),
      again, parts.status);
  } else {
    body = h('div.auth-stack', h('p.auth-lead', 'Nothing in your inbox? Check your spam folder. Still nothing? ',
      h('a', { href: site('contact/') }, 'Contact us'), '.'));
  }
  return screen({
    badge: 'mail',
    title: 'Check your email',
    lead: 'Open the link we sent to confirm your address and carry on setting up. Use this device if you can.',
    body,
    foot: h('p', link('/login', 'Back to log in')),
  });
}

// ---------------------------------------------------------------------------
// Log out (linked from the account menus on the website and in the app):
// end this device's session, then go back to the website.
// ---------------------------------------------------------------------------
let leaving = false;
async function logout() {
  const waiting = h('div.app-loading', { role: 'status' }, h('span.app-spinner'), h('span.visually-hidden', 'Logging out'));
  if (leaving) return waiting; // signing out re-renders this route once more
  leaving = true;
  if (state.user) {
    try { await db.auth.signOut({ scope: 'local' }); } catch { /* the saved session is cleared either way */ }
  }
  sessionStorage.removeItem('rr-after-login');
  location.replace(site());
  return waiting;
}

// ---------------------------------------------------------------------------
// Forgot and reset password
// ---------------------------------------------------------------------------
function forgot() {
  const parts = formParts();
  const email = emailField({ autocomplete: 'username' });
  const submit = submitButton('Send reset link');
  const form = h('form.app-form.auth-form', { novalidate: true }, parts.alertEl, email.wrap, submit, parts.status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateAll([email])) return;
    const res = await send(submit, parts, 'Sending…', () => db.auth.resetPasswordForEmail(email.value(), { redirectTo: redirectBase() + '#/reset-password' }));
    if (!res) return;
    if (res.error) { parts.alert(authError(res.error).message); return; }
    // The same answer whether or not the address has an account, so this
    // screen can't be used to find out who has signed up.
    const done = notice('info', 'If that email has an account, a reset link is on its way. It works once and expires in an hour.');
    done.setAttribute('role', 'status');
    done.tabIndex = -1;
    form.replaceWith(done);
    done.focus();
  });
  return screen({
    title: 'Reset your password',
    lead: 'Enter the email you signed up with and we\'ll send you a link to choose a new one.',
    body: form,
    foot: h('p', link('/login', 'Back to log in')),
  });
}

function reset() {
  const parts = formParts();
  const accountEmail = state.user?.email || '';
  // Lets password managers save the new password against the right account.
  const username = h('input.visually-hidden', { type: 'email', name: 'username', autocomplete: 'username', value: accountEmail, tabindex: '-1', 'aria-hidden': 'true', readonly: true });
  const avoid = () => personalWords({ email: accountEmail, name: state.profile?.full_name || '' });
  const password = check(passwordField({ label: 'New password', autocomplete: 'new-password', hint: 'At least 8 characters. Longer is stronger: a few unrelated words work well.' }),
    (v) => passwordStrength(v, avoid()).problem);
  const confirm = check(passwordField({ name: 'confirm', label: 'Confirm new password', autocomplete: 'new-password', reveal: false }),
    (v) => matchProblem(password.value(), v));
  password.join(confirm);
  strengthMeter(password, avoid);
  password.input.addEventListener('input', () => { if (confirm.input.getAttribute('aria-invalid') === 'true') confirm.validate(); });
  const submit = submitButton('Save new password');
  const form = h('form.app-form.auth-form', { novalidate: true }, parts.alertEl, username, password.wrap, confirm.wrap, submit, parts.status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateAll([password, confirm])) return;
    const res = await send(submit, parts, 'Saving…', () => db.auth.updateUser({ password: password.value() }));
    if (!res) return;
    if (res.error) {
      const problem = authError(res.error);
      if (problem.field === 'expired') { parts.alert('This reset link has expired or was already used. ', link('/forgot-password', 'Ask for a new one'), '.'); return; }
      if (problem.field === 'password') { password.error(problem.message); password.input.focus(); return; }
      parts.alert(problem.message);
      return;
    }
    parts.status.textContent = 'Password changed.';
    go('/');
  });
  return screen({ title: 'Choose a new password', lead: 'You\'ll stay logged in on this device.', body: form });
}
