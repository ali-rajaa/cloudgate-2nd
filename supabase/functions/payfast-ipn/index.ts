// PayFast's server-to-server payment notification (IPN).
// Verifies PayFast's validation hash, then records the result. The database
// function checks the amount against the order and ignores repeats.
import { rpc } from '../_shared/db.ts';
import { expectedValidationHash, payfastConfig, safeEqual } from '../_shared/payfast.ts';

Deno.serve(async (req) => {
  const cfg = payfastConfig();
  if (!cfg) return new Response('Payments not configured', { status: 503 });

  // PayFast may send the result as a form post or as query parameters.
  const params = new URLSearchParams(new URL(req.url).search);
  if (req.method === 'POST') {
    const type = req.headers.get('content-type') ?? '';
    const text = await req.text();
    if (type.includes('application/json')) {
      try { for (const [k, v] of Object.entries(JSON.parse(text))) params.set(k, String(v)); } catch { /* ignore */ }
    } else {
      for (const [k, v] of new URLSearchParams(text)) params.set(k, v);
    }
  }
  const get = (k: string) => params.get(k) ?? params.get(k.toUpperCase()) ?? '';

  const basketId = get('basket_id');
  const errCode = get('err_code');
  const transactionId = get('transaction_id');
  const amount = Math.round(Number(get('transaction_amount') || get('merchant_amount') || '0'));
  const received = get('validation_hash').toLowerCase();
  if (!basketId || !transactionId) return new Response('Missing fields', { status: 400 });

  const expected = await expectedValidationHash(cfg, basketId, errCode);
  const valid = received.length > 0 && safeEqual(received, expected);
  const success = errCode === '000' || errCode === '00';

  const body = Object.fromEntries(params.entries());
  delete body.validation_hash;
  const { data, error } = await rpc<string>('record_gateway_payment', {
    p_order: /^[0-9a-f-]{36}$/.test(basketId) ? basketId : '00000000-0000-0000-0000-000000000000',
    p_reference: transactionId,
    p_amount: amount,
    p_method: (get('PaymentName') || 'payfast').toLowerCase().slice(0, 40),
    p_event_id: `${transactionId}:${errCode}`,
    p_body: body,
    p_signature_valid: valid,
    p_success: success,
  }, { service: true });
  if (error) return new Response('Could not record payment', { status: 500 });
  return new Response(JSON.stringify({ result: data }), { status: valid ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
});
