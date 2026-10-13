// Starts a PayFast payment for one of the signed-in NGO's orders.
// The amount always comes from our database, never from the browser.
import { rpc } from '../_shared/db.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { getAccessToken, payfastConfig, pktTimestamp } from '../_shared/payfast.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const cfg = payfastConfig();
  if (!cfg) return json({ error: 'Online payments are not switched on yet. Please pay as shown on the claim page.' }, 503);

  const url = Deno.env.get('SUPABASE_URL')!;
  const userToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

  let orderId = '';
  try { orderId = String((await req.json()).order_id ?? ''); } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/.test(orderId)) return json({ error: 'Missing order.' }, 400);

  // Checks that the caller belongs to the NGO on this order.
  const { data: rows, error } = await rpc<Array<{ amount_rs: number; title: string; status: string; payer_email: string | null }>>(
    'gateway_checkout_details', { p_order: orderId }, { userToken });
  if (error) return json({ error }, 403);
  const order = rows?.[0];
  if (!order) return json({ error: 'Order not found.' }, 404);
  if (!['payment_due', 'payment_processing'].includes(order.status)) return json({ error: 'This order is not waiting for payment.' }, 409);

  const started = await rpc('gateway_checkout_started', { p_order: orderId }, { service: true });
  if (started.error) return json({ error: started.error }, 409);

  let token: string;
  try { token = await getAccessToken(cfg, orderId, order.amount_rs); }
  catch (e) { return json({ error: 'The payment service is not responding. Please try again in a minute.', detail: String(e) }, 502); }

  const appUrl = (Deno.env.get('APP_URL') ?? 'https://rizq.fixmypcperth.com/app/').replace(/\/?$/, '/');
  const back = `${appUrl}#/ngo/claims/${orderId}`;
  return json({
    action: `${cfg.baseUrl}/Ecommerce/api/Transaction/PostTransaction`,
    fields: {
      MERCHANT_ID: cfg.merchantId,
      MERCHANT_NAME: cfg.merchantName,
      TOKEN: token,
      PROCCODE: '00',
      TXNAMT: String(order.amount_rs),
      CURRENCY_CODE: 'PKR',
      CUSTOMER_MOBILE_NO: '',
      CUSTOMER_EMAIL_ADDRESS: order.payer_email ?? '',
      SIGNATURE: crypto.randomUUID().replace(/-/g, ''),
      VERSION: 'RIZQ-1.0',
      TXNDESC: `Rizq Rasan: ${order.title}`.slice(0, 100),
      SUCCESS_URL: `${back}?payment=success`,
      FAILURE_URL: `${back}?payment=failed`,
      BASKET_ID: orderId,
      ORDER_DATE: pktTimestamp(),
      CHECKOUT_URL: `${url}/functions/v1/payfast-ipn`,
      TRAN_TYPE: 'ECOMM_PURCHASE',
    },
  });
});
