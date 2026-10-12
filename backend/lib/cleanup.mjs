/* ==========================================================================
   All Star Players / abandoned checkouts
   --------------------------------------------------------------------------
   A customer who opens a checkout and walks away leaves two things behind: a
   Square payment link that still works, and a hold on the stock they were
   going to buy.

   Letting the hold lapse on a timer was the bug. The link does not lapse with
   it — Square payment links stay payable — so freeing the stock would mean
   selling a unit that somebody can still buy from a tab they opened
   yesterday. That is the overselling case this file exists to close.

   So the order is strictly: cancel first, free the stock second, and only
   ever on proof.

     1. Ask Square what the order is actually doing.
     2. Paid? Square has taken the stock down itself. Free our hold; done.
        Already cancelled? Free the hold; done.
     3. Still live? Delete the payment link, then ASK SQUARE AGAIN.
     4. Confirmed cancelled or paid on that second read? Free the hold.
        Anything else — including a 200 from the delete that did not actually
        cancel anything — the hold stays, and we come back later.

   Step 4 is not paranoia. Square's reference says deleting a link cancels its
   order, but there are unresolved developer-forum reports of exactly that not
   happening: a 200 with no cancelled_order_id, an order still live, and a
   customer paying hours later. Trusting the delete would reintroduce the very
   hole this closes, so the delete is treated as a request and the re-read as
   the answer.
   ========================================================================== */

import { readOrderStatus, deletePaymentLink, cancelOrder } from './checkout.mjs';

/* Read on every invocation rather than at module load: a limit changed in
   the Lambda console then takes effect on the next run, not the next cold
   start. */
const int = (name, fallback) => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name) => /^(1|true|yes|on)$/i.test(process.env[name] || '');

/* Backoff between tries at a job that will not settle. */
const RETRY_SCHEDULE = [60, 300, 900, 3600, 21600];

export const OUTCOME = {
  PAID: 'paid',                 /* Square took the money; stock already gone */
  CANCELED: 'canceled',         /* confirmed dead, stock freed */
  STILL_LIVE: 'still_live',     /* could not kill it; stock stays held */
  RETRY: 'retry',               /* transient; try again shortly */
  STUCK: 'stuck',               /* out of attempts; needs a person */
  GONE: 'gone'                  /* nothing left to do */
};

function nextDue(attempts) {
  const wait = RETRY_SCHEDULE[Math.min(attempts, RETRY_SCHEDULE.length - 1)];
  return Math.floor(Date.now() / 1000) + wait;
}

/* ------------------------------------------------------------ one job ---- */

export async function settleOne(job, { square, store, settings }) {
  const { attemptId, orderId, paymentLinkId, idemKey } = job;
  const variationIds = Array.isArray(job.variationIds) ? job.variationIds : [];

  /* Freeing the stock always happens BEFORE the attempt is marked cancelled.
     That ordering matters: marking it cancelled is what lets the customer
     start a fresh checkout, and a fresh checkout takes new holds under the
     same attempt id. Freeing afterwards would take those new holds away.

     The holdsReleased flag guards the same race between two sweeps that both
     picked up this job. */
  async function freeStock(reason) {
    if (!variationIds.length || !attemptId) return;
    const current = orderId ? await store.getOrder(orderId).catch(() => null) : null;
    if (current?.holdsReleased) return;
    await store.releaseHolds(attemptId, variationIds);
    if (orderId) {
      await store.updateOrderStatus(orderId, { holdsReleased: true, cleanupOutcome: reason })
        .catch(err => console.error('cleanup_order_flag_failed', err?.message));
    }
  }

  if (!orderId) {
    /* Nothing to verify against, so nothing we are allowed to free. */
    console.error('cleanup_job_without_order', attemptId);
    return { outcome: OUTCOME.GONE };
  }

  /* 1. What does Square say right now? */
  let live;
  try {
    live = await readOrderStatus(square, orderId);
  } catch (err) {
    /* An order Square has never heard of cannot be paid, so there is nothing
       to protect. Anything else is transient and we come back. */
    /* Checked by status rather than by class: an error that crossed a module
       boundary is still a 404. */
    if (err?.status === 404) {
      await freeStock('order_not_found');
      return { outcome: OUTCOME.GONE };
    }
    return { outcome: OUTCOME.RETRY, error: err?.message };
  }

  /* 2. Already settled one way or the other. */
  if (live.status === 'paid') {
    await store.updateOrderStatus(orderId, { status: 'paid' }).catch(() => {});
    /* Square decremented the catalog when it took the payment. Holding the
       same unit as well would keep it off the shelf twice. */
    await freeStock('paid');
    return { outcome: OUTCOME.PAID };
  }
  if (live.status === 'canceled') {
    await store.updateOrderStatus(orderId, { status: 'canceled' }).catch(() => {});
    await freeStock('already_canceled');
    if (idemKey) await store.markIdempotencyCanceled(idemKey);
    return { outcome: OUTCOME.CANCELED };
  }

  /* A tender on an order that is not COMPLETED yet means money is moving
     through it this second. Stand well back and look again shortly. */
  if (live.tenderCount > 0) {
    return { outcome: OUTCOME.RETRY, error: 'payment in flight' };
  }

  /* 3. Still live. Ask Square to kill the link. */
  let deleteResult = null;
  if (paymentLinkId) {
    try {
      deleteResult = await deletePaymentLink(square, paymentLinkId);
    } catch (err) {
      return { outcome: OUTCOME.RETRY, error: err?.message };
    }
  }

  /* 3b. Optional fallback for an account where the delete does not cancel.
     Off unless switched on, and still proved by the re-read below. */
  if (bool('CLEANUP_FORCE_CANCEL_ORDER') && deleteResult && !deleteResult.claimsCancelled) {
    try {
      await cancelOrder(square, {
        orderId, version: live.version, locationId: square.locationId
      });
    } catch (err) {
      console.error('cleanup_force_cancel_failed', orderId, err?.message);
    }
  }

  /* 4. The delete is a request. This is the answer. */
  let after;
  try {
    after = await readOrderStatus(square, orderId);
  } catch (err) {
    return { outcome: OUTCOME.RETRY, error: err?.message };
  }

  if (after.status === 'paid') {
    /* Somebody paid in the gap. Square refuses to cancel a paid order, so
       this is simply a sale that happened late. */
    await store.updateOrderStatus(orderId, { status: 'paid' }).catch(() => {});
    await freeStock('paid_during_cleanup');
    return { outcome: OUTCOME.PAID };
  }

  if (after.status === 'canceled') {
    await store.updateOrderStatus(orderId, { status: 'canceled' }).catch(() => {});
    await freeStock('canceled');
    if (idemKey) await store.markIdempotencyCanceled(idemKey);
    return { outcome: OUTCOME.CANCELED };
  }

  /* The dangerous case, and the reason for the second read. Square answered
     the delete but the order is still live, so the link may still be payable.
     The stock stays held. */
  console.error('cleanup_link_would_not_die', JSON.stringify({
    orderId, paymentLinkId,
    deleteReturnedCancelledOrderId: deleteResult?.claimsCancelled ?? null,
    orderState: after.state
  }));
  return { outcome: OUTCOME.STILL_LIVE };
}

/* ------------------------------------------------------------- the sweep -- */

export async function sweepAbandonedCheckouts({ square, store, settings, limit } = {}) {
  const maxAttempts = int('CLEANUP_MAX_ATTEMPTS', 12);
  const batch = limit || int('CLEANUP_BATCH_SIZE', 25);
  const jobs = await store.dueSweeps({ limit: batch });
  const tally = { considered: jobs.length, paid: 0, canceled: 0, retried: 0, stillLive: 0, stuck: 0, gone: 0 };

  for (const job of jobs) {
    let result;
    try {
      result = await settleOne(job, { square, store, settings });
    } catch (err) {
      console.error('cleanup_job_threw', job.attemptId, err?.message);
      result = { outcome: OUTCOME.RETRY, error: err?.message };
    }

    const attempts = Number(job.attempts || 0) + 1;

    switch (result.outcome) {
      case OUTCOME.PAID:     tally.paid++; await store.deleteSweep(job); break;
      case OUTCOME.CANCELED: tally.canceled++; await store.deleteSweep(job); break;
      case OUTCOME.GONE:     tally.gone++; await store.deleteSweep(job); break;

      case OUTCOME.STILL_LIVE:
      case OUTCOME.RETRY:
      default: {
        if (attempts >= maxAttempts) {
          /* Out of road. The hold deliberately stays: an un-cancelled link is
             worse than a unit off the shelf. Somebody has to look. */
          tally.stuck++;
          console.error('cleanup_stuck_needs_a_person', JSON.stringify({
            attemptId: job.attemptId, orderId: job.orderId,
            paymentLinkId: job.paymentLinkId, attempts, lastError: result.error || null
          }));
          await store.rescheduleSweep(job, {
            dueAt: nextDue(RETRY_SCHEDULE.length - 1),
            patch: {
              attempts, stuck: true,
              stuckSince: job.stuckSince || Date.now(),
              lastError: result.error || 'order still live'
            }
          });
        } else {
          if (result.outcome === OUTCOME.STILL_LIVE) tally.stillLive++; else tally.retried++;
          await store.rescheduleSweep(job, {
            dueAt: nextDue(attempts),
            patch: { attempts, lastError: result.error || null }
          });
        }
        break;
      }
    }
  }

  if (tally.considered) console.log('cleanup_sweep', JSON.stringify(tally));
  return tally;
}
