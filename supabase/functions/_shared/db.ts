// Minimal client for calling database functions through Supabase's REST API.
// No external libraries, so functions start fast and have nothing to download.

const URL = () => Deno.env.get('SUPABASE_URL')!;

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>, auth: { userToken?: string; service?: boolean }): Promise<{ data: T | null; error: string | null; status: number }> {
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const key = auth.service ? service : anon;
  const bearer = auth.service ? service : (auth.userToken ?? anon);
  const res = await fetch(`${URL()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'message' in body) ? String((body as { message: unknown }).message) : `Request failed (${res.status})`;
    return { data: null, error: msg, status: res.status };
  }
  return { data: body as T, error: null, status: res.status };
}
