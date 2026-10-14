// Unit tests for the form checks in assets/app/validate.js.
// Run: cd scripts/tests && node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailProblem, suggestEmail, passwordStrength, personalWords, matchProblem,
  normalisePhone, phoneProblem, authError, MIN_PASSWORD,
} from '../../assets/app/validate.js';

test('email: empty, malformed and good addresses', () => {
  assert.equal(emailProblem(''), 'Enter your email address.');
  assert.equal(emailProblem('   '), 'Enter your email address.');
  for (const bad of ['ali', 'ali@', '@gmail.com', 'ali@gmail', 'ali @gmail.com', 'ali@gmail.c']) {
    assert.match(emailProblem(bad), /like name@example.com/, bad);
  }
  for (const good of ['ali@gmail.com', ' ali@edhi.org.pk ', 'first.last+food@company.co']) assert.equal(emailProblem(good), '', good);
});

test('email: suggests well-known providers for small slips only', () => {
  assert.equal(suggestEmail('ali@gmial.com'), 'ali@gmail.com');
  assert.equal(suggestEmail('ali@gmail.co'), 'ali@gmail.com');
  assert.equal(suggestEmail('Ali@Hotmial.com'), 'ali@hotmail.com');
  assert.equal(suggestEmail('ali@yaho.com'), 'ali@yahoo.com');
  // Correct providers and real company domains are left alone.
  for (const fine of ['ali@gmail.com', 'ali@mail.com', 'ali@edhi.org', 'ali@saylani.org.pk', 'ali@company.com', 'ali', '']) {
    assert.equal(suggestEmail(fine), '', fine);
  }
});

test('password: too short is refused with a count', () => {
  const r = passwordStrength('abc');
  assert.equal(r.ok, false);
  assert.equal(r.score, 0);
  assert.match(r.problem, /at least 8 characters \(5 more\)/);
  assert.equal(passwordStrength('').ok, false);
  assert.equal(MIN_PASSWORD, 8);
});

test('password: common, repeated and personal passwords are refused', () => {
  for (const p of ['password', 'Password123', '12345678', 'qwertyuiop', 'pakistan786', 'aaaaaaaaaa']) {
    assert.equal(passwordStrength(p).ok, false, p);
  }
  const avoid = personalWords({ email: 'ayesha.k@edhi.org', name: 'Ayesha Khan', org: 'Edhi Foundation' });
  assert.equal(passwordStrength('ayesha2024!', avoid).ok, false);
  assert.equal(passwordStrength('MyFoundation#9', avoid).ok, false);
  // Short words (under 4 letters) are not held against you.
  assert.equal(passwordStrength('ali-bread-77', personalWords({ name: 'Ali' })).ok, true);
});

test('password: longer and more varied scores higher', () => {
  const s = (p) => passwordStrength(p).score;
  assert.equal(s('breadjam'), 1);
  assert.ok(s('Breadjam42!') > s('breadjam'));
  assert.ok(s('bread and lentils for all') >= 3);
  assert.equal(s('Bread & lentils 4 everyone'), 4);
  assert.ok(s('xyz12345678') <= 2, 'runs like 1234 are marked down');
  assert.deepEqual(passwordStrength('Bread & lentils 4 everyone').label, 'Strong');
});

test('confirm password must match exactly', () => {
  assert.equal(matchProblem('Secret pass 1', ''), 'Enter the same password again.');
  assert.match(matchProblem('Secret pass 1', 'secret pass 1'), /don't match/);
  assert.equal(matchProblem('Secret pass 1', 'Secret pass 1'), '');
});

test('phone: Pakistani mobile numbers in every common format', () => {
  for (const v of ['0300 1234567', '03001234567', '300 1234567', '+92 300 1234567', '0092-300-1234567', '+923001234567']) {
    assert.equal(normalisePhone(v), '+923001234567', v);
    assert.equal(phoneProblem(v), '', v);
  }
  for (const v of ['0300 12', '051 1234567', '1234567890', '+44 7700 900123']) assert.equal(normalisePhone(v), null, v);
  assert.equal(phoneProblem(''), 'Enter your mobile number.');
  assert.match(phoneProblem('0300 12'), /like 0300 1234567/);
});

test('server errors become plain messages, routed to the right place', () => {
  assert.deepEqual(authError({ message: 'Invalid login credentials', status: 400 }).field, 'form');
  assert.match(authError({ message: 'Invalid login credentials' }).message, /don't match an account/);
  assert.equal(authError({ message: 'Email not confirmed', status: 400 }).field, 'confirm');
  assert.equal(authError({ message: 'User already registered', status: 422 }).field, 'email');
  assert.equal(authError({ message: 'Password should be at least 6 characters.', status: 422 }).field, 'password');
  assert.match(authError({ message: 'Email rate limit exceeded', status: 429 }).message, /Too many attempts/);
  assert.match(authError({ message: 'For security purposes, you can only request this after 60 seconds.', status: 429 }).message, /Too many attempts/);
  assert.match(authError(new TypeError('Failed to fetch')).message, /couldn't reach the server/);
  assert.match(authError(new Error('took too long')).message, /couldn't reach the server/);
  assert.equal(authError({ message: 'Auth session missing!', status: 400 }).field, 'expired');
  assert.equal(authError({ message: 'Token has expired or is invalid', status: 403 }).field, 'expired');
  assert.match(authError({ message: 'upstream error', status: 502 }).message, /on our side/);
  assert.equal(authError(undefined).field, 'form');
});
