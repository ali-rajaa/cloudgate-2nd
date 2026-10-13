// PayFast Pakistan (APPS) hosted checkout.
//
// Flow: our server asks PayFast for a one-time access token for the order's
// amount, the browser posts a form to PayFast's payment page, the NGO pays by
// Raast or wallet there, and PayFast calls our payfast-ipn function with the
// result. Only that server-to-server call can mark an order paid.
//
// Settings (Edge Function secrets):
//   PAYFAST_MERCHANT_ID, PAYFAST_SECURED_KEY, PAYFAST_MERCHANT_NAME
//   PAYFAST_BASE_URL   https://ipguat.apps.net.pk (test, default) or https://ipg1.apps.net.pk (live)
//   APP_URL            where NGOs return after paying, e.g. https://rizq.fixmypcperth.com/app/
//
// Field names and the validation hash follow PayFast Pakistan's merchant
// integration guide. Confirm them against the guide PayFast sends with the
// merchant account, and run a test payment on the UAT server before going live.

export type PayfastConfig = { merchantId: string; securedKey: string; merchantName: string; baseUrl: string };

export function payfastConfig(): PayfastConfig | null {
  const merchantId = Deno.env.get('PAYFAST_MERCHANT_ID') ?? '';
  const securedKey = Deno.env.get('PAYFAST_SECURED_KEY') ?? '';
  if (!merchantId || !securedKey) return null;
  return {
    merchantId,
    securedKey,
    merchantName: Deno.env.get('PAYFAST_MERCHANT_NAME') ?? 'Rizq Rasan',
    baseUrl: (Deno.env.get('PAYFAST_BASE_URL') ?? 'https://ipguat.apps.net.pk').replace(/\/$/, ''),
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// PayFast signs its notification with SHA-256 of "basket_id|secured_key|merchant_id|err_code".
export async function expectedValidationHash(cfg: PayfastConfig, basketId: string, errCode: string): Promise<string> {
  return sha256Hex(`${basketId}|${cfg.securedKey}|${cfg.merchantId}|${errCode}`);
}

// Constant-time comparison so the hash can't be guessed byte by byte.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getAccessToken(cfg: PayfastConfig, basketId: string, amountRs: number): Promise<string> {
  const body = new URLSearchParams({
    MERCHANT_ID: cfg.merchantId,
    SECURED_KEY: cfg.securedKey,
    BASKET_ID: basketId,
    TXNAMT: String(amountRs),
    CURRENCY_CODE: 'PKR',
  });
  const res = await fetch(`${cfg.baseUrl}/Ecommerce/api/Transaction/GetAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`PayFast token request failed (${res.status})`);
  const data = await res.json();
  const token = data.ACCESS_TOKEN ?? data.access_token;
  if (!token) throw new Error('PayFast did not return an access token');
  return token;
}

export function pktTimestamp(d = new Date()): string {
  const k = new Date(d.getTime() + 5 * 3600 * 1000); // Pakistan Standard Time, UTC+5, no daylight saving
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}
