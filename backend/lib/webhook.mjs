/* ==========================================================================
   All Star Players / Square webhooks
   --------------------------------------------------------------------------
   Square signs every notification with HMAC-SHA256 over the notification URL
   concatenated with the raw request body, keyed with the signature key from
   the webhook subscription, base64 encoded, in the
   `x-square-hmacsha256-signature` header.

   Two things matter here and nothing else does:

     - an unsigned or wrongly signed body is thrown away without being parsed
       for anything we act on
     - the comparison is constant time, so the signature cannot be guessed a
       byte at a time

   The URL used in the HMAC must be character-for-character the one registered
   in the Square dashboard. That is why it comes from configuration rather
   than from the request: a proxy that rewrites the Host header would
   otherwise break every signature.
   ========================================================================== */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

export function expectedSignature({ notificationUrl, rawBody, signatureKey }) {
  return createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody, 'utf8')
    .digest('base64');
}

export function verifySignature({ notificationUrl, rawBody, signatureKey, provided }) {
  if (!signatureKey || !provided) return false;
  const expected = expectedSignature({ notificationUrl, rawBody, signatureKey });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* The events worth reacting to, and what each one means for an order we
   created. Anything else is acknowledged and ignored — Square retries a
   non-2xx, so arguing with an event we do not care about is just noise. */
const PAYMENT_STATUS = {
  COMPLETED: 'paid',
  APPROVED: 'pending',
  PENDING: 'pending',
  CANCELED: 'canceled',
  FAILED: 'failed'
};

export function interpret(event) {
  const type = event?.type || '';
  const object = event?.data?.object || {};

  if (type.startsWith('payment.')) {
    const payment = object.payment || {};
    const status = PAYMENT_STATUS[payment.status] || null;
    if (!status || !payment.order_id) return null;
    return {
      orderId: payment.order_id,
      status,
      source: 'payment',
      paymentId: payment.id || null,
      /* Square's own figure, not ours. */
      amount: Number(payment.amount_money?.amount ?? 0),
      currency: payment.amount_money?.currency || null
    };
  }

  if (type.startsWith('order.')) {
    const order = object.order_updated || object.order || {};
    const orderId = order.order_id || order.id;
    if (!orderId) return null;
    const state = order.state || order.new_state;
    const status = state === 'COMPLETED' ? 'paid' : state === 'CANCELED' ? 'canceled' : 'pending';
    return { orderId, status, source: 'order', state: state || null };
  }

  return null;
}

/* Paid is the end of the line. A late "pending" arriving after a "paid" — the
   order and payment webhooks race routinely — must not walk the status
   backwards and tell a customer their completed order is still processing. */
const RANK = { pending: 0, canceled: 1, failed: 1, paid: 2 };

/* paid, canceled and failed are all ends of the road: Square owns the
   outcome from there, so anything we were holding on the shelf goes back. */
export function isTerminal(status) {
  return status === 'paid' || status === 'canceled' || status === 'failed';
}

export function shouldApply(currentStatus, nextStatus) {
  if (!currentStatus) return true;
  if (currentStatus === nextStatus) return false;
  return (RANK[nextStatus] ?? 0) > (RANK[currentStatus] ?? 0);
}
