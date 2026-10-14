// Opens the live site in a real browser and checks the app starts and can
// reach Supabase. Run by .github/workflows/live-check.yml after each deploy.
// Usage: SITE_URL=https://rizq.fixmypcperth.com node check.mjs
import { chromium } from 'playwright';
import { appendFileSync } from 'node:fs';

const site = (process.env.SITE_URL || 'https://rizq.fixmypcperth.com').replace(/\/$/, '');
const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail = '') => results.push({ ok: false, name, detail });

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`Script error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`Console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
page.on('requestfailed', (r) => problems.push(`Request failed: ${r.url()} (${r.failure()?.errorText})`));

// 1. The website home page.
try {
  const home = await page.goto(`${site}/?check=${Date.now()}`, { waitUntil: 'load' });
  home?.ok() ? pass('Home page loads') : fail('Home page loads', `status ${home?.status()}`);
} catch (e) { fail('Home page loads', e.message.split('\n')[0]); }

// 2. The app shows the Log in form.
await page.goto(`${site}/app/?check=${Date.now()}`, { waitUntil: 'load' }).catch(() => {});
let config = {};
try { config = JSON.parse(await page.locator('#app-config').textContent()); } catch {}
const form = page.locator('#app-view form');
try {
  await form.first().waitFor({ timeout: 20000 });
  pass('App shows the Log in page', (await page.locator('#app-view').innerText()).split('\n').slice(0, 3).join(' / '));
} catch {
  const shown = await page.locator('#app-view').innerText({ timeout: 2000 }).catch(() => '');
  fail('App shows the Log in page', `Screen shows: "${shown.trim().slice(0, 200) || '(nothing)'}"`);
}
await page.screenshot({ path: 'app.png', fullPage: true });

// 3. Supabase answers with the site's public key, sent the way the app sends it.
const headers = { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, 'Content-Type': 'application/json' };
async function api(name, path, init = {}) {
  try {
    const r = await fetch(config.supabaseUrl + path, { headers, ...init });
    const body = (await r.text()).slice(0, 200);
    r.ok ? pass(name, `HTTP ${r.status}`) : fail(name, `HTTP ${r.status}: ${body}`);
  } catch (e) { fail(name, e.message); }
}
if (!config.supabaseUrl || !config.supabaseAnonKey) fail('App has the Supabase address and key');
else {
  await api('Sign-in service answers', '/auth/v1/settings');
  await api('Database answers (categories)', '/rest/v1/categories?select=name&limit=1');
  await api('Database functions answer (impact totals)', '/rest/v1/rpc/impact_totals', { method: 'POST', body: '{}' });
}
await browser.close();

const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
if (problems.length) lines.push('', 'Browser problems:', ...problems.map((p) => `  ${p}`));
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live check of ${site}\n\n` +
    results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`).join('\n') +
    (problems.length ? `\n\n**Browser problems**\n\n${problems.map((p) => `- ${p}`).join('\n')}\n` : '\n'));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
