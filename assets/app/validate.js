// Rizq Rasan app: form checks for the sign-in screens and anywhere else that
// needs them. Plain functions with no page access, so they also run in the
// Node unit tests (scripts/tests/validate.test.mjs).
//
// Each *Problem() returns '' when the value is fine, or the message to show.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailProblem(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Enter your email address.';
  if (!EMAIL.test(v)) return 'Enter an email address like name@example.com.';
  return '';
}

// "name@gmial.com" -> "name@gmail.com". Only suggests a well-known provider
// one or two keystrokes away, so real company domains are left alone.
const PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'mail.com', 'proton.me', 'protonmail.com', 'yahoo.co.uk', 'msn.com', 'aol.com'];
export function suggestEmail(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const at = v.lastIndexOf('@');
  if (at < 1) return '';
  const domain = v.slice(at + 1);
  if (domain.length < 4 || PROVIDERS.includes(domain)) return '';
  let best = '';
  let bestDistance = Infinity;
  for (const p of PROVIDERS) {
    const d = editDistance(domain, p);
    if (d < bestDistance) { best = p; bestDistance = d; }
  }
  return bestDistance > 0 && bestDistance <= 2 && bestDistance <= domain.length / 4 ? v.slice(0, at + 1) + best : '';
}

// Edit distance where swapping two neighbouring letters counts as one edit.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Password strength, 0 to 4. Length counts most; a mix of character types
// helps; common passwords, runs like 1234, and the person's own name or email
// are refused. Anything 8+ characters that isn't refused can be used.
export const MIN_PASSWORD = 8;
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '0123456789',
  '87654321', '11111111', '00000000', '12341234', '11223344', 'qwertyui', 'qwerty123', 'qwertyuiop', '1q2w3e4r', '1qaz2wsx',
  'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'abcd1234', 'abc12345', 'abcdefgh', 'iloveyou', 'iloveyou1', 'letmein1', 'letmein123',
  'welcome1', 'welcome123', 'admin123', 'sunshine', 'football', 'baseball', 'princess', 'trustno1', 'superman', 'whatever',
  'pakistan', 'pakistan1', 'pakistan123', 'pakistan786', 'islamabad', 'islamabad1', 'karachi123', 'lahore123', 'bismillah',
  'bismillah786', 'allah786', 'muhammad', 'rizqrasan', 'rizqrasan1', 'changeme', 'default1',
]);
const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

export function passwordStrength(value, avoid = []) {
  const p = String(value ?? '');
  if (!p) return { score: 0, label: '', ok: false, problem: `Use at least ${MIN_PASSWORD} characters.` };
  if (p.length < MIN_PASSWORD) {
    const left = MIN_PASSWORD - p.length;
    return { score: 0, label: LABELS[0], ok: false, problem: `Use at least ${MIN_PASSWORD} characters (${left} more).` };
  }
  const lower = p.toLowerCase();
  const personal = avoid.map((w) => String(w ?? '').toLowerCase().trim()).filter((w) => w.length >= 4);
  if (COMMON.has(lower) || /^(.)\1+$/.test(p) || personal.some((w) => lower.includes(w))) {
    return { score: 1, label: 'Too easy to guess', ok: false, problem: 'That password is too easy to guess. Avoid common passwords and your own name or email.' };
  }
  let points = 1;
  if (p.length >= 12) points++;
  if (p.length >= 16) points++;
  if (p.length >= 20) points++;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (kinds >= 3) points++;
  if (/0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|wert|asdf|zxcv/i.test(p)) points--;
  const score = Math.max(1, Math.min(4, points));
  return { score, label: LABELS[score], ok: true, problem: '' };
}

// Words from a person's details that shouldn't appear in their password.
export function personalWords({ email = '', name = '', org = '' } = {}) {
  const local = String(email).split('@')[0];
  return [local, ...String(name).split(/\s+/), ...String(org).split(/\s+/)].filter(Boolean);
}

export function matchProblem(password, again) {
  if (!again) return 'Enter the same password again.';
  if (password !== again) return 'The two passwords don\'t match.';
  return '';
}

// Pakistani mobile numbers: 0300 1234567, 300 1234567, +92 300 1234567,
// 0092 300 1234567. Returns +92 and 10 digits, or null.
export function normalisePhone(value) {
  let d = String(value || '').replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^0092/, '92');
  if (/^92/.test(d) && d.length === 12) d = d.slice(2);
  else if (/^0/.test(d) && d.length === 11) d = d.slice(1);
  return /^3\d{9}$/.test(d) ? '+92' + d : null;
}

export function phoneProblem(value) {
  if (!String(value ?? '').trim()) return 'Enter your mobile number.';
  return normalisePhone(value) ? '' : 'Enter a mobile number like 0300 1234567.';
}

// What to tell people when sign-in, sign-up or a reset fails. `field` says
// which box the message belongs to; 'form' means the message goes above the form.
export function authError(error) {
  const msg = String(error?.message || error || '');
  const status = error?.status;
  if (/auth session missing|session.*(expired|not found)|(token|link|otp).*(expired|invalid)|(expired|invalid).*(token|link|otp)/i.test(msg)) {
    return { field: 'expired', message: 'This link has expired or was already used.' };
  }
  if (/invalid login credentials|invalid_grant/i.test(msg)) {
    return { field: 'form', message: 'That email and password don\'t match an account. Check them and try again, or reset your password.' };
  }
  if (/email not confirmed|not confirmed/i.test(msg)) return { field: 'confirm', message: 'Confirm your email address first.' };
  if (/already registered|already exists|user_already_exists/i.test(msg)) {
    return { field: 'email', message: 'An account with this email already exists. Log in instead.' };
  }
  if (/password/i.test(msg) && /(weak|short|least|pwned|leaked|characters)/i.test(msg)) {
    return { field: 'password', message: 'Choose a stronger password: longer, and not one used on other sites.' };
  }
  if (status === 429 || /rate limit|too many/i.test(msg)) return { field: 'form', message: 'Too many attempts. Wait a minute, then try again.' };
  if (/failed to fetch|networkerror|network request failed|load failed|took too long|offline/i.test(msg)) {
    return { field: 'form', message: 'We couldn\'t reach the server. Check your connection and try again.' };
  }
  if (status >= 500) return { field: 'form', message: 'Something went wrong on our side. Please try again in a moment.' };
  return { field: 'form', message: msg || 'Something went wrong. Please try again.' };
}
