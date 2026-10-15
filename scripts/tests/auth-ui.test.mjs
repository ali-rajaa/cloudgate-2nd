// Browser tests for the log in, sign up and password screens.
//
// They open the built site in Chromium and answer every Supabase request
// with a fake reply, so each case (wrong password, slow network, offline,
// rate limits, expired links, success) can be acted out without a server.
//
// Run after building the site:
//   bundle exec jekyll build
//   cd scripts/tests && npm install && npx playwright install chromium
//   SITE_DIR=../../_site node --test
// CHROMIUM_PATH=/path/to/chromium uses an existing browser instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SITE = path.resolve(process.env.SITE_DIR || '../../_site');
// The site's base path when it was built for a project page (e.g. /cloudgate-2nd).
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
let server;
let base;
let browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (BASE_PATH && urlPath.startsWith(BASE_PATH + '/')) urlPath = urlPath.slice(BASE_PATH.length);
    let file = path.join(SITE, urlPath);
    if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
});

// ---------------------------------------------------------------------------
// A fake Supabase. Pass handlers to change one reply; every call is recorded.
// ---------------------------------------------------------------------------
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub, email) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const USER = { id: '11111111-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'ali@gmail.com', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
const SESSION = { access_token: fakeJwt(USER.id, USER.email), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh', user: USER };
const BAD_LOGIN = (route) => json(route, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });

async function open(hash, { viewport = { width: 1280, height: 900 }, auth = {}, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Keep the tests offline-safe and quick: no web fonts, no realtime socket.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.routeWebSocket(/realtime/, () => {});
  await page.route(/supabase\.co\/auth\/v1\//, async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/auth/v1/')[1];
    let body = null;
    try { body = route.request().postDataJSON(); } catch {}
    calls.push({ name, method: route.request().method(), body });
    const handler = auth[name];
    if (handler) return handler(route, body);
    if (name === 'token') return BAD_LOGIN(route);
    if (name === 'signup') return json(route, 200, { ...USER, email: body.email, identities: [{}], confirmation_sent_at: new Date().toISOString() });
    if (name === 'user') return json(route, 200, USER);
    return json(route, 200, {});
  });
  await page.route(/supabase\.co\/rest\/v1\//, (route) => {
    const req = route.request();
    if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' });
    if (/\/rpc\/is_admin/.test(req.url())) return json(route, 200, false);
    return json(route, 200, []);
  });
  await page.goto(`${base}${BASE_PATH}/app/#${hash}`);
  await page.locator('#app-view h1').waitFor();
  return { page, calls, errors, close: () => context.close() };
}

const errorText = (page, label) => page.getByLabel(label, { exact: true }).evaluate((input) => {
  const ids = (input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
});
const isInvalid = (page, label) => page.getByLabel(label, { exact: true }).evaluate((i) => i.getAttribute('aria-invalid') === 'true');
const focused = (page) => page.evaluate(() => document.activeElement?.getAttribute('name') || document.activeElement?.textContent?.trim());

// ---------------------------------------------------------------------------
// Log in
// ---------------------------------------------------------------------------
test('log in: empty submit shows both errors, linked to their fields, and focuses the first', async () => {
  const { page, calls, errors, close } = await open('/login');
  await page.getByRole('button', { name: 'Log in' }).click();
  assert.equal(await errorText(page, 'Email'), 'Enter your email address.');
  assert.equal(await errorText(page, 'Password'), 'Enter your password.');
  assert.ok(await isInvalid(page, 'Email'));
  assert.equal(await focused(page), 'email');
  assert.equal(calls.length, 0, 'nothing is sent');
  assert.deepEqual(errors, []);
  await close();
});

test('log in: email is checked when you leave it, and the error clears as soon as it is fixed', async () => {
  const { page, close } = await open('/login');
  const email = page.getByLabel('Email');
  await email.focus();
  await page.keyboard.press('Tab');
  assert.equal(await isInvalid(page, 'Email'), false, 'tabbing past an empty box is not an error');
  await email.fill('ali@gmail');
  await page.keyboard.press('Tab');
  assert.match(await errorText(page, 'Email'), /like name@example.com/);
  await email.fill('ali@gmail.com');
  assert.equal(await isInvalid(page, 'Email'), false, 'cleared while typing');
  await close();
});

test('log in: a mistyped provider gets a one-tap suggestion', async () => {
  const { page, close } = await open('/login');
  await page.getByLabel('Email').fill('ali@gmial.com');
  await page.getByLabel('Password').focus();
  const use = page.getByRole('button', { name: 'ali@gmail.com' });
  await use.click();
  assert.equal(await page.getByLabel('Email').inputValue(), 'ali@gmail.com');
  assert.equal(await use.count(), 0);
  await close();
});

test('log in: wrong password shows one alert with a reset link and keeps the form usable', async () => {
  const { page, calls, close } = await open('/login');
  await page.getByLabel('Email').fill('ali@gmail.com');
  await page.getByLabel('Password').fill('not-my-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'don\'t match an account' });
  await alert.waitFor();
  assert.equal(await alert.getByRole('link', { name: 'reset your password' }).getAttribute('href'), '#/forgot-password');
  assert.equal(await focused(page), 'password');
  const button = page.getByRole('button', { name: 'Log in' });
  assert.equal(await button.getAttribute('aria-busy'), null);
  assert.equal(calls.filter((c) => c.name.startsWith('token')).length, 1);
  assert.equal(calls[0].body.email, 'ali@gmail.com');
  await close();
});

test('log in: while waiting the button is busy, ignores more presses, and a slow line gets a note', async () => {
  let release;
  const { page, calls, close } = await open('/login', {
    auth: { 'token': (route) => new Promise((resolve) => { release = () => resolve(BAD_LOGIN(route)); }) },
  });
  await page.getByLabel('Email').fill('ali@gmail.com');
  await page.getByLabel('Password').fill('whatever-1');
  const button = page.locator('button.auth-submit'); // its name changes while busy
  await button.click();
  assert.equal(await button.getAttribute('aria-busy'), 'true');
  assert.equal((await button.textContent()).trim(), 'Logging in…');
  await button.click({ force: true });
  await page.keyboard.press('Enter');
  await page.getByText('Still working. Your connection seems slow.').waitFor({ timeout: 9000 });
  assert.equal(calls.filter((c) => c.name.startsWith('token')).length, 1, 'only one request');
  release();
  await page.getByRole('alert').filter({ hasText: 'don\'t match' }).waitFor();
  assert.equal(await page.getByText('Still working').count(), 0, 'note cleared');
  assert.equal((await button.textContent()).trim(), 'Log in');
  await close();
});

test('log in: offline says so without sending anything', async () => {
  const { page, calls, close } = await open('/login');
  await page.context().setOffline(true);
  await page.getByLabel('Email').fill('ali@gmail.com');
  await page.getByLabel('Password').fill('whatever-1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('alert').filter({ hasText: 'You\'re offline' }).waitFor();
  assert.equal(calls.length, 0);
  await close();
});

test('log in: too many attempts gets a plain message', async () => {
  const { page, close } = await open('/login', { auth: { token: (route) => json(route, 429, { message: 'Request rate limit reached' }) } });
  await page.getByLabel('Email').fill('ali@gmail.com');
  await page.getByLabel('Password').fill('whatever-1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('alert').filter({ hasText: 'Too many attempts' }).waitFor();
  await close();
});

test('log in: an unconfirmed address is asked to confirm first, and can send a new link once a minute', async () => {
  const { page, calls, close } = await open('/login', { auth: { token: (route) => json(route, 400, { code: 'email_not_confirmed', message: 'Email not confirmed' }) } });
  await page.getByLabel('Email').fill('new@edhi.org');
  await page.getByLabel('Password').fill('whatever-1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('heading', { name: 'Confirm your email first' }).waitFor();
  assert.ok(await page.getByText('new@edhi.org').isVisible());
  await page.getByRole('button', { name: 'Send a new link' }).click();
  await page.getByText('Sent to new@edhi.org. Check your inbox.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.className), 'auth-status', 'focus stays with the result');
  const button = page.locator('.auth-stack .btn');
  assert.match(await button.textContent(), /Send again in \d+ seconds/);
  assert.equal(await button.getAttribute('aria-disabled'), 'true');
  await button.click({ force: true });
  assert.equal(calls.filter((c) => c.name === 'resend').length, 1, 'no second email during the wait');
  const resend = calls.find((c) => c.name === 'resend');
  assert.deepEqual([resend.body.type, resend.body.email], ['signup', 'new@edhi.org']);
  await close();
});

test('log in: success opens the account and brings the app header back', async () => {
  const { page, close } = await open('/login', { auth: { token: (route) => json(route, 200, SESSION) } });
  await page.getByLabel('Email').fill('ali@gmail.com');
  await page.getByLabel('Password').fill('right-password-1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForFunction(() => !location.hash.startsWith('#/login'));
  await page.waitForFunction(() => document.body.dataset.layout !== 'auth');
  assert.ok(await page.locator('.app-header').isVisible());
  // The log in screen was replaced in history, so Back doesn't bounce you through it.
  await page.goBack().catch(() => {});
  assert.equal(await page.evaluate(() => location.hash.startsWith('#/login')), false);
  await close();
});

test('log in: keyboard order is email, password, Show, Forgot password, Log in', async () => {
  const { page, close } = await open('/login');
  await page.getByLabel('Email').focus();
  const order = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement.getAttribute('name') || document.activeElement.textContent.trim()));
  }
  assert.deepEqual(order, ['password', 'Show password', 'Forgot password?', 'Log in']);
  await close();
});

// ---------------------------------------------------------------------------
// Create an account
// ---------------------------------------------------------------------------
async function fillSignup(page, overrides = {}) {
  const v = { name: 'Ayesha Khan', phone: '0300 1234567', org: 'Edhi Kitchen', email: 'ayesha@edhi.org', password: 'Bread & lentils 4 all', confirm: null, ...overrides };
  await page.getByLabel('Your name').fill(v.name);
  await page.getByLabel('Mobile number').fill(v.phone);
  await page.locator('input[name=org]').fill(v.org);
  await page.getByLabel('Email').fill(v.email);
  await page.getByLabel('Password', { exact: true }).fill(v.password);
  await page.getByLabel('Confirm password').fill(v.confirm ?? v.password);
  await page.locator('input[name=terms]').check();
}

test('sign up: empty submit flags every field and the type cards, and focuses the type choice', async () => {
  const { page, calls, close } = await open('/signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  assert.equal(await page.locator('#type-error').textContent(), 'Choose the one that describes you.');
  assert.equal(await page.locator('.auth-type__input').first().getAttribute('aria-invalid'), 'true');
  for (const label of ['Your name', 'Mobile number', 'Email']) assert.ok(await isInvalid(page, label), label);
  assert.ok(await isInvalid(page, 'Password'));
  assert.equal(await page.evaluate(() => document.activeElement.className), 'auth-type__input');
  assert.equal(calls.length, 0);
  await close();
});

test('sign up: choosing a type updates the labels, agreement and address without losing what you typed', async () => {
  const { page, close } = await open('/signup');
  await page.getByLabel('Your name').fill('Ayesha Khan');
  await page.locator('.auth-type__input[value=ngo]').check();
  assert.equal(await page.evaluate(() => location.hash), '#/signup/ngo');
  assert.ok(await page.getByLabel('Organisation name').isVisible());
  assert.match(await page.getByRole('link', { name: 'NGO Agreement' }).getAttribute('href'), /legal\/ngo-agreement\/$/);
  assert.match(await page.locator('.auth-persona').textContent(), /Free to join/);
  await page.locator('.auth-type__input[value=vendor]').check();
  assert.ok(await page.getByLabel('Business name').isVisible());
  assert.match(await page.locator('.auth-persona').textContent(), /No sign-up fee/);
  assert.equal(await page.getByLabel('Your name').inputValue(), 'Ayesha Khan');
  // Tapping the tab you're already on doesn't reload the form.
  await page.locator('.auth-switch').getByRole('link', { name: 'Create account' }).click();
  assert.equal(await page.getByLabel('Your name').inputValue(), 'Ayesha Khan');
  await close();
});

test('sign up: deep links preselect the type', async () => {
  for (const [hash, label] of [['/signup/vendor', 'Business name'], ['/signup/ngo', 'Organisation name']]) {
    const { page, close } = await open(hash);
    assert.ok(await page.getByLabel(label).isVisible(), hash);
    await close();
  }
});

test('sign up: the strength meter rises with length, and weak or personal passwords are refused', async () => {
  const { page, close } = await open('/signup/ngo');
  await page.getByLabel('Your name').fill('Ayesha Khan');
  const password = page.getByLabel('Password', { exact: true });
  const score = () => page.locator('.auth-meter').getAttribute('data-score');
  await password.fill('abc');
  assert.equal(await score(), '0');
  assert.equal(await page.locator('.auth-meter__text').textContent(), 'Too short');
  await password.fill('password123');
  assert.equal(await page.locator('.auth-meter__text').textContent(), 'Too easy to guess');
  await password.fill('ayesha2024!');
  assert.equal(await page.locator('.auth-meter__text').textContent(), 'Too easy to guess', 'contains her name');
  await password.fill('Bread & lentils 4 all');
  assert.equal(await score(), '4');
  await page.getByLabel('Confirm password').focus();
  assert.equal(await isInvalid(page, 'Password'), false);
  await close();
});

test('sign up: confirm password must match, and Show reveals both boxes', async () => {
  const { page, close } = await open('/signup/vendor');
  await page.getByLabel('Password', { exact: true }).fill('Bread & lentils 4 all');
  const confirm = page.getByLabel('Confirm password');
  await confirm.fill('Bread & lentils');
  await page.locator('input[name=terms]').focus();
  assert.match(await errorText(page, 'Confirm password'), /don't match/);
  await confirm.fill('Bread & lentils 4 all');
  assert.equal(await isInvalid(page, 'Confirm password'), false, 'clears as soon as it matches');
  await page.getByRole('button', { name: 'Show password' }).click();
  assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text');
  assert.equal(await confirm.getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  assert.equal(await confirm.getAttribute('type'), 'password');
  await close();
});

test('sign up: sends clean details and opens Check your email', async () => {
  const { page, calls, errors, close } = await open('/signup/ngo');
  await fillSignup(page, { email: '  Ayesha@Edhi.org ', phone: '+92 300 123 4567', password: ' spaces kept 4 sure ', confirm: ' spaces kept 4 sure ' });
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  // Supabase only allows one email a minute, so the resend button starts out waiting.
  assert.equal(await page.getByRole('button', { name: /Send again in \d+ seconds/ }).getAttribute('aria-disabled'), 'true');
  const sent = calls.find((c) => c.name.startsWith('signup')).body;
  assert.equal(sent.email, 'Ayesha@Edhi.org');
  assert.equal(sent.password, ' spaces kept 4 sure ', 'passwords are never trimmed');
  assert.deepEqual(sent.data, { full_name: 'Ayesha Khan', phone: '+923001234567', org_type: 'ngo', org_name: 'Edhi Kitchen' }, 'the organisation travels with the account');
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('rr-pending-org')));
  assert.deepEqual(pending, { type: 'ngo', name: 'Edhi Kitchen', phone: '+923001234567' });
  assert.deepEqual(errors, []);
  await close();
});

test('sign up: an existing address is flagged on the email field', async () => {
  const { page, close } = await open('/signup/vendor', { auth: { signup: (route) => json(route, 422, { code: 'user_already_exists', message: 'User already registered' }) } });
  await fillSignup(page);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('An account with this email already exists.').waitFor();
  assert.equal(await focused(page), 'email');
  const error = page.locator('input[name=email]').locator('xpath=..').locator('.field__error');
  assert.equal(await error.getByRole('link', { name: 'Log in' }).getAttribute('href'), '#/login');
  assert.equal(await error.getByRole('link', { name: 'reset your password' }).getAttribute('href'), '#/forgot-password');
  await close();
});

test('sign up: an address that already has an account is caught even when Supabase hides it', async () => {
  // With email confirmation on, Supabase answers with a stand-in user (no identities) and sends nothing.
  const { page, close } = await open('/signup/ngo', { auth: { signup: (route, body) => json(route, 200, { ...USER, email: body.email, identities: [] }) } });
  await fillSignup(page);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('An account with this email already exists.').waitFor();
  assert.notEqual(await page.evaluate(() => location.hash), '#/check-email');
  await close();
});

test('sign up: a server error shows next to the button, on screen, even on a phone', async () => {
  const { page, close } = await open('/signup/vendor', { viewport: { width: 390, height: 844 }, auth: { signup: (route) => json(route, 500, { message: 'upstream error' }) } });
  await fillSignup(page);
  await page.getByRole('button', { name: 'Create account' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'on our side' });
  await alert.waitFor();
  await page.waitForFunction(() => { const r = document.querySelector('.auth-alert').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  await close();
});

test('sign up: a server error shows in the alert and the button recovers', async () => {
  const { page, close } = await open('/signup/vendor', { auth: { signup: (route) => json(route, 500, { message: 'upstream error' }) } });
  await fillSignup(page);
  const button = page.getByRole('button', { name: 'Create account' });
  await button.click();
  await page.getByRole('alert').filter({ hasText: 'on our side' }).waitFor();
  assert.equal((await button.textContent()).trim(), 'Create account');
  await close();
});

// ---------------------------------------------------------------------------
// Forgot and reset password
// ---------------------------------------------------------------------------
test('forgot password: checks the address, then gives the same answer whether or not it has an account', async () => {
  const { page, calls, close } = await open('/forgot-password');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  assert.equal(await errorText(page, 'Email'), 'Enter your email address.');
  await page.getByLabel('Email').fill('someone@edhi.org');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const done = page.getByRole('status').filter({ hasText: 'If someone@edhi.org has an account' });
  await done.waitFor();
  assert.ok(await page.getByRole('heading', { name: 'Check your email' }).isVisible());
  assert.ok(await done.evaluate((el) => el === document.activeElement), 'focus moves to the confirmation');
  assert.equal(calls.find((c) => c.name === 'recover').body.email, 'someone@edhi.org');
  await close();
});

test('reset password: an expired link says so straight away, before any typing', async () => {
  const { page, close } = await open('/reset-password');
  assert.ok(await page.getByRole('heading', { name: 'This link has expired' }).isVisible());
  assert.equal(await page.getByLabel('New password', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Ask for a new password reset link' }).getAttribute('href'), '#/forgot-password');
  await close();
});

test('email links: an expired or used link opens the expired-link screen, not Page not found', async () => {
  const { page, errors, close } = await open('error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.ok(await page.getByRole('heading', { name: 'This link has expired' }).isVisible());
  assert.equal(await page.evaluate(() => location.hash), '#/link-expired');
  assert.deepEqual(errors, []);
  await close();
});

// ---------------------------------------------------------------------------
// Layout and details
// ---------------------------------------------------------------------------
test('layout: no sideways scrolling from 320px phones to wide screens, and the app header stays hidden', async () => {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    for (const hash of ['/login', '/signup']) {
      const { page, close } = await open(hash, { viewport: { width, height: 800 } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `${hash} at ${width}px`);
      assert.equal(await page.locator('.app-header').isVisible(), false);
      await close();
    }
  }
});

test('details: Caps Lock warning follows Caps Lock, and a click on Log in still lands while it shows', async () => {
  const { page, calls, close } = await open('/login', { viewport: { width: 390, height: 844 } });
  await page.getByLabel('Email').fill('ali@gmail.com');
  const password = page.getByLabel('Password');
  await password.fill('SECRET-PASS');
  await password.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'A', modifierCapsLock: true, bubbles: true })));
  assert.ok(await page.locator('.auth-caps').isVisible());
  // Clicking low on the button: if the note vanished on blur, the button would move and the click be lost.
  const b = await page.locator('button.auth-submit').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.85);
  await page.getByRole('alert').filter({ hasText: 'don\'t match' }).waitFor();
  assert.equal(calls.filter((c) => c.name.startsWith('token')).length, 1);
  await password.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', modifierCapsLock: false, bubbles: true })));
  assert.equal(await page.locator('.auth-caps').isVisible(), false);
  await close();
});

test('details: very long text never makes the form wider than a 320px phone', async () => {
  const { page, close } = await open('/signup/vendor', { viewport: { width: 320, height: 700 } });
  await page.getByLabel('Email').fill('averyveryveryveryveryveryveryverylongaddressthatkeepsgoing@gmial.com');
  await page.getByLabel('Your name').focus();
  await page.locator('.auth-suggest__use').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await close();
});

test('details: the selectors the other browser tests rely on still find exactly one element', async () => {
  const { page, close } = await open('/login');
  assert.equal(await page.getByLabel('Email').count(), 1);
  assert.equal(await page.getByLabel('Password').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Log in' }).count(), 1);
  assert.equal(await page.locator('button:has-text("Log in")').count(), 1);
  assert.equal(await page.locator('#app-view form').count(), 1);
  await close();
});

// ---------------------------------------------------------------------------
// Signed in: the account menu on the website and in the app, and log out
// ---------------------------------------------------------------------------
// supabase-js saves the sign-in under sb-<project ref>-auth-token.
async function storageKey() {
  const html = await readFile(path.join(SITE, 'app', 'index.html'), 'utf8');
  const ref = /"supabaseUrl":\s*"https:\/\/([^.]+)\./.exec(html)?.[1] || 'local';
  return `sb-${ref}-auth-token`;
}

async function signedIn(pathAndHash, { viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const key = await storageKey();
  // Seed the saved sign-in once; later page loads see whatever the app left.
  await context.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(key, value); }
  }, [key, JSON.stringify({ ...SESSION, user: { ...USER, user_metadata: { full_name: 'Ali Rajaa' } } })]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.routeWebSocket(/realtime/, () => {});
  await page.route(/supabase\.co\/auth\/v1\//, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route(/supabase\.co\/rest\/v1\//, (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' });
    if (/rpc\/is_admin/.test(url)) return json(route, 200, false);
    if (/\/profiles/.test(url)) return json(route, 200, { id: USER.id, full_name: 'Ali Rajaa', phone: '+923001234567' });
    if (/\/memberships/.test(url)) return json(route, 200, [{ role: 'owner', organisation_id: 'o1', created_at: '2026-10-01T00:00:00Z', organisations: { id: 'o1', type: 'vendor', name: 'Rajaa Bakery', status: 'approved' } }]);
    return json(route, 200, []);
  });
  await page.goto(`${base}${BASE_PATH}${pathAndHash}`);
  return { page, errors, close: () => context.close() };
}

test('website: guests see one Log in button (no Join); nobody sees the account menu', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${base}${BASE_PATH}/`);
  const login = page.locator('.site-header__login');
  assert.ok(await login.isVisible());
  assert.match(await login.getAttribute('href'), /\/app\/#\/login$/);
  assert.equal(await page.getByRole('link', { name: 'Join', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-account]').isVisible(), false);
  // The home page's buttons go straight to sign-up, as a business or an NGO.
  assert.match(await page.getByRole('link', { name: 'I have surplus food' }).first().getAttribute('href'), /\/app\/#\/signup\/vendor$/);
  assert.match(await page.getByRole('link', { name: 'I feed people' }).first().getAttribute('href'), /\/app\/#\/signup\/ngo$/);
  await context.close();
});

test('website: signed in, the header shows your account instead of Log in and Join', async () => {
  const { page, errors, close } = await signedIn('/');
  assert.equal(await page.locator('.site-header__login').isVisible(), false);
  const button = page.getByRole('button', { name: 'Your account: Ali' });
  assert.equal((await button.locator('.account__avatar').textContent()).trim(), 'AR');
  await button.click();
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  const menu = page.locator('#account-menu');
  assert.ok(await menu.getByText('ali@gmail.com').isVisible());
  assert.match(await menu.getByRole('link', { name: 'Your dashboard' }).getAttribute('href'), /\/app\/#\/$/);
  assert.match(await menu.getByRole('link', { name: 'Log out' }).getAttribute('href'), /\/app\/#\/logout$/);
  await page.keyboard.press('Escape');
  assert.ok(await menu.isHidden());
  assert.equal(await button.evaluate((b) => b === document.activeElement), true, 'focus returns to the button');
  assert.deepEqual(errors, []);
  await close();
});

test('website: on phones the menu sheet offers your dashboard and log out instead of the join buttons', async () => {
  const { page, close } = await signedIn('/', { viewport: { width: 390, height: 844 } });
  await page.locator('[data-menu-open]').click();
  const sheet = page.locator('#menu-sheet');
  await sheet.getByRole('link', { name: 'Your dashboard' }).waitFor();
  assert.equal(await sheet.getByRole('link', { name: 'I have surplus food' }).isVisible(), false);
  assert.ok(await sheet.getByText('Ali Rajaa').isVisible());
  await close();
});

test('app: the header has the same account menu, and Log out returns to the website signed out', async () => {
  const { page, errors, close } = await signedIn('/app/#/vendor');
  const button = page.locator('.app-header .account__button');
  await button.waitFor();
  await button.click();
  const menu = page.locator('#app-account-menu');
  assert.ok(await menu.getByText('Rajaa Bakery · Owner').isVisible());
  await menu.getByRole('link', { name: 'Log out' }).click();
  await page.waitForFunction((root) => location.pathname === root && document.readyState === 'complete', `${BASE_PATH}/`);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k))), false, 'saved sign-in removed');
  assert.ok(await page.locator('.site-header__login').isVisible());
  assert.deepEqual(errors, []);
  await close();
});

// ---------------------------------------------------------------------------
// Website header: four links, a highlight on the current page, and a header
// that tucks away when scrolling down and returns when scrolling up
// ---------------------------------------------------------------------------
async function sitePage(pathname, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com|translate\.google/, (r) => r.abort());
  await page.goto(`${base}${BASE_PATH}${pathname}`);
  await page.waitForLoadState('load');
  return { page, errors, close: () => context.close() };
}

test('header: four short links, and the highlight rests on the current page then follows the pointer', async () => {
  const { page, errors, close } = await sitePage('/pricing/', { width: 1280, height: 800 });
  const labels = await page.locator('.site-nav__link').allTextContents();
  assert.deepEqual(labels.map((t) => t.trim()), ['How it works', 'Businesses', 'NGOs', 'Pricing']);
  const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
  const pill = page.locator('[data-nav-indicator]');
  const pricing = page.locator('.site-nav__link', { hasText: 'Pricing' });
  assert.deepEqual(await box(pill), await box(pricing));
  // Wait for the spring to settle rather than for a fixed time.
  const settlesOn = (text) => page.waitForFunction((t) => {
    const p = document.querySelector('[data-nav-indicator]').getBoundingClientRect();
    const l = [...document.querySelectorAll('.site-nav__link')].find((a) => a.textContent.trim() === t).getBoundingClientRect();
    return Math.abs(p.left - l.left) < 1 && Math.abs(p.width - l.width) < 1;
  }, text, { timeout: 3000 });
  await page.locator('.site-nav__link', { hasText: 'NGOs' }).hover();
  await settlesOn('NGOs');
  await page.mouse.move(640, 500);
  await settlesOn('Pricing');
  assert.deepEqual(errors, []);
  await close();
});

test('header: tucks away when scrolling down, returns on scroll up and when it gets focus', async () => {
  const { page, close } = await sitePage('/for-businesses/', { width: 1280, height: 800 });
  const header = page.locator('[data-header]');
  const tucked = async () => (await header.getAttribute('class')).includes('is-tucked');
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, 1400);
  await page.waitForFunction(() => document.querySelector('[data-header]').classList.contains('is-tucked'));
  await page.mouse.wheel(0, -80);
  await page.waitForFunction(() => !document.querySelector('[data-header]').classList.contains('is-tucked'));
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('[data-header]').classList.contains('is-tucked'));
  await page.locator('.site-header__login').focus();
  assert.equal(await tucked(), false, 'focus brings it back');
  await close();
});

test('header: on phones the bar is just logo, Log in and menu; the Urdu switch is in the menu', async () => {
  const { page, close } = await sitePage('/', { width: 390, height: 800 });
  assert.equal(await page.locator('.site-header .lang-toggle').isVisible(), false);
  assert.ok(await page.locator('.site-header__login').isVisible());
  await page.locator('[data-menu-open]').click();
  await page.locator('#menu-sheet .lang-toggle').waitFor();
  // Log in, Create an account, and no Impact link until its numbers are published.
  assert.equal(await page.locator('#menu-sheet').getByRole('link', { name: 'Log in', exact: true }).count(), 1);
  assert.match(await page.locator('#menu-sheet').getByRole('link', { name: 'Create an account' }).getAttribute('href'), /#\/signup$/);
  assert.equal(await page.locator('#menu-sheet').getByRole('link', { name: 'Impact' }).count(), 0);
  await close();
});

test('header: still tucks away after you tap one of its buttons', async () => {
  const { page, close } = await sitePage('/for-ngos/', { width: 390, height: 800 });
  await page.locator('[data-menu-open]').click();
  await page.locator('#menu-sheet .menu-sheet__scrim').click({ position: { x: 20, y: 780 } });
  await page.waitForFunction(() => document.querySelector('#menu-sheet').hidden || !document.documentElement.classList.contains('has-sheet'));
  await page.mouse.move(200, 600);
  await page.mouse.wheel(0, 1600);
  await page.waitForFunction(() => document.querySelector('[data-header]').classList.contains('is-tucked'));
  await close();
});

test('header: signed in on a 320px phone, the account button has a name and its menu stays on screen', async () => {
  const { page, close } = await signedIn('/', { viewport: { width: 320, height: 640 } });
  const button = page.getByRole('button', { name: /Your account/ });
  await button.click();
  const box = await page.locator('#account-menu').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, `menu spans ${box.x} to ${box.x + box.width}`);
  await close();
});

test('app: an account with two organisations still loads, using the one furthest along', async () => {
  const context = await browser.newContext();
  const key = await storageKey();
  await context.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(k, v); } },
    [key, JSON.stringify({ ...SESSION, user: { ...USER, user_metadata: { full_name: 'Ali Rajaa' } } })]);
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.routeWebSocket(/realtime/, () => {});
  await page.route(/supabase\.co\/auth\/v1\//, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route(/supabase\.co\/rest\/v1\//, (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' });
    if (/rpc\/is_admin/.test(url)) return json(route, 200, false);
    if (/\/profiles/.test(url)) return json(route, 200, { id: USER.id, full_name: 'Ali Rajaa' });
    if (/\/memberships/.test(url)) return json(route, 200, [
      { role: 'owner', organisation_id: 'o1', created_at: '2026-10-01T00:00:00Z', organisations: { id: 'o1', type: 'vendor', name: 'Started twice', status: 'onboarding' } },
      { role: 'owner', organisation_id: 'o2', created_at: '2026-10-02T00:00:00Z', organisations: { id: 'o2', type: 'vendor', name: 'Rajaa Bakery', status: 'approved' } },
    ]);
    return json(route, 200, []);
  });
  await page.goto(`${base}${BASE_PATH}/app/#/`);
  await page.waitForFunction(() => location.hash === '#/vendor');
  await page.locator('.app-header .account__button').click();
  assert.ok(await page.getByText('Rajaa Bakery · Owner').isVisible());
  await context.close();
});

test('join: the old /join/ address now opens sign-up in the app', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${base}${BASE_PATH}/join/`);
  await page.waitForFunction(() => location.hash === '#/signup');
  assert.match(page.url(), /\/app\/#\/signup$/);
  await context.close();
});
