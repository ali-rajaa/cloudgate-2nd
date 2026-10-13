// Emails notifications that haven't been emailed yet, through Resend.
// Called every minute by the database scheduler with the service role key.
// Settings (Edge Function secrets): RESEND_API_KEY, EMAIL_FROM (e.g. "Rizq Rasan <alerts@mail.example.pk>"), APP_URL.
import { rpc } from '../_shared/db.ts';

type Pending = { id: string; email: string; full_name: string | null; title: string; body: string; link: string | null };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

Deno.serve(async (req) => {
  const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (auth !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return new Response('Forbidden', { status: 403 });
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  if (!key || !from) return new Response(JSON.stringify({ sent: 0, reason: 'Email is not configured' }), { status: 200 });
  const app = (Deno.env.get('APP_URL') ?? 'https://rizq.fixmypcperth.com/app/').replace(/\/?$/, '/');

  const { data, error } = await rpc<Pending[]>('pending_notification_emails', { p_limit: 50 }, { service: true });
  if (error) return new Response(error, { status: 500 });
  const sent: string[] = [];
  for (const n of data ?? []) {
    const url = n.link ? `${app}#${n.link}` : app;
    const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1A1F1C;max-width:520px">
      <p style="font-size:14px;color:#5B635E;margin:0 0 16px">Rizq Rasan</p>
      <h1 style="font-size:20px;color:#2E4537;margin:0 0 8px">${esc(n.title)}</h1>
      <p style="margin:0 0 20px">${esc(n.body)}</p>
      <p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#2E4537;color:#fff;text-decoration:none;font-weight:600">Open Rizq Rasan</a></p>
      <p style="font-size:13px;color:#5B635E;margin-top:24px">You get this email because you have a Rizq Rasan account.</p></div>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: n.email, subject: n.title, html, text: `${n.title}\n\n${n.body}\n\n${url}` }),
    });
    if (res.ok) sent.push(n.id);
  }
  if (sent.length) await rpc('mark_notifications_emailed', { p_ids: sent }, { service: true });
  return new Response(JSON.stringify({ sent: sent.length, pending: (data ?? []).length }), { headers: { 'Content-Type': 'application/json' } });
});
