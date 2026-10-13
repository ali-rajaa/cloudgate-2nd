// Sign in, sign up and password reset.
import { db, h, field, busy, toast, friendly, go, link, notice, normalisePhone, loadState } from './core.js';

export function routes(register) {
  register('/login', { title: 'Log in', public: true, guestOnly: true, render: login });
  register('/signup', { title: 'Create an account', public: true, guestOnly: true, render: signupChoice });
  register('/signup/:type', { title: 'Create an account', public: true, guestOnly: true, render: signup });
  register('/check-email', { title: 'Check your email', public: true, render: checkEmail });
  register('/forgot-password', { title: 'Reset your password', public: true, render: forgot });
  register('/reset-password', { title: 'Choose a new password', public: true, render: reset });
}

const authCard = (...children) => h('section.app-auth', h('div.app-auth__card.card', ...children));
const redirectBase = () => location.href.split('#')[0];

function login() {
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' });
  const password = field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Log in');
  const form = h('form.app-form', { novalidate: true }, email.wrap, password.wrap, submit);
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
  return authCard(
    h('h1.app-title', 'Log in'),
    form,
    h('p.app-auth__links', link('/forgot-password', 'Forgot your password?')),
    h('p.app-auth__links', 'New to Rizq Rasan? ', link('/signup', 'Create an account')),
  );
}

function signupChoice() {
  const choice = (type, title, text) => h('a.card.card--link.app-choice', { href: '#/signup/' + type },
    h('h2', title), h('p', text), h('span.text-link', 'Continue'));
  return h('section.app-auth.app-auth--wide',
    h('h1.app-title', 'Create an account'),
    h('p.app-lead', 'Which describes you?'),
    h('div.join-cards',
      choice('vendor', 'I have surplus food', 'For restaurants, bakeries, grocers and cafes in Islamabad.'),
      choice('ngo', 'I feed people', 'For registered NGOs, shelters, community kitchens and food banks.')),
    h('p.app-auth__links', 'Already have an account? ', link('/login', 'Log in')));
}

function signup({ params }) {
  const type = params.type === 'ngo' ? 'ngo' : 'vendor';
  const name = field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name' });
  const org = field({ name: 'org', label: type === 'vendor' ? 'Business name' : 'Organisation name', required: true, autocomplete: 'organization' });
  const phone = field({ name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national', placeholder: '0300 1234567' });
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' });
  const password = field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 8 characters.' });
  const terms = field({ name: 'terms', label: '', type: 'checkbox' });
  terms.wrap.querySelector('label').append('I agree to the ', h('a', { href: '../legal/terms/', target: '_blank' }, 'Terms of Service'),
    ', the ', h('a', { href: type === 'vendor' ? '../legal/vendor-agreement/' : '../legal/ngo-agreement/', target: '_blank' }, type === 'vendor' ? 'Vendor Agreement' : 'NGO Agreement'),
    ' and the ', h('a', { href: '../legal/privacy/', target: '_blank' }, 'Privacy Policy'), '.');
  const submit = h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Create account');
  const form = h('form.app-form', { novalidate: true }, name.wrap, org.wrap, phone.wrap, email.wrap, password.wrap, terms.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let bad = false;
    if (!name.value()) { name.error('Enter your name.'); bad = true; }
    if (org.value().length < 2) { org.error('Enter the name people know you by.'); bad = true; }
    const tel = normalisePhone(phone.value());
    if (!tel) { phone.error('Enter a Pakistani mobile number, like 0300 1234567.'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value())) { email.error('Enter an email address like name@example.com.'); bad = true; }
    if (password.value().length < 8) { password.error('Use at least 8 characters.'); bad = true; }
    if (!terms.value()) { terms.error('Please agree to continue.'); bad = true; }
    if (bad) return;
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
  return authCard(
    h('p.eyebrow', type === 'vendor' ? 'Food business' : 'NGO or kitchen'),
    h('h1.app-title', 'Create your account'),
    h('p.app-lead', 'After this you\'ll add your details and documents. We check every account within 2 working days.'),
    form,
    h('p.app-auth__links', link('/signup', 'Back'), ' · Already have an account? ', link('/login', 'Log in')));
}

function checkEmail() {
  const email = sessionStorage.getItem('rr-signup-email');
  return authCard(
    h('h1.app-title', 'Check your email'),
    h('p', 'We sent a link to ', h('strong', email || 'your email address'), '. Open it on this device to confirm your address and continue setting up.'),
    notice('info', 'No email after a few minutes? Check your spam folder, or log in to send it again.'),
    h('p.app-auth__links', link('/login', 'Back to log in')));
}

function forgot() {
  const email = field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' });
  const submit = h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Send reset link');
  const form = h('form.app-form', { novalidate: true }, email.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!email.value()) return email.error('Enter your email address.');
    busy(submit, async () => {
      await db.auth.resetPasswordForEmail(email.value(), { redirectTo: redirectBase() + '#/reset-password' });
      form.replaceWith(notice('info', 'If that email has an account, a reset link is on its way. It works once and expires in an hour.'));
    });
  });
  return authCard(h('h1.app-title', 'Reset your password'), h('p.app-lead', 'We\'ll email you a link to choose a new one.'), form,
    h('p.app-auth__links', link('/login', 'Back to log in')));
}

function reset() {
  const password = field({ name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 8 characters.' });
  const submit = h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Save new password');
  const form = h('form.app-form', { novalidate: true }, password.wrap, submit);
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
  return authCard(h('h1.app-title', 'Choose a new password'), form);
}
