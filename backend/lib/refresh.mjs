/* ==========================================================================
   All Star Players / rebuilding the catalog
   --------------------------------------------------------------------------
   This is the slow job, and it runs nowhere near an HTTP request.

   844 products and 5,869 variations means paging through Square's catalog and
   then batching the inventory for every tracked variation. That took longer
   than the function's old 25-second timeout, and API Gateway would have given
   up at thirty regardless. So it lives here, on a schedule, with minutes to
   work in, and browsing requests only ever read what it leaves behind.

   The order of operations is the whole design:

     1. Take the lease. If another refresh holds it, stop — two refreshes
        racing would waste Square's rate limit and could publish out of order.
     2. Write the new build into its OWN partition. Nothing points at it, so
        a crash here is invisible to shoppers.
     3. Flip the pointer. One write. Before it, the old catalog is live; after
        it, the new one is. There is no moment in between.
     4. Sweep up the builds nobody points at any more.

   A failure at any step leaves the previous complete snapshot serving.
   ========================================================================== */

import { buildCatalogSnapshot } from './catalog.mjs';

export async function refreshCatalog({ square, store, settings, environment, holder }) {
  const env = environment;
  const who = holder || ('lambda-' + Math.random().toString(36).slice(2, 10));
  const startedAt = Date.now();

  /* Taking the lease can fail too — a DynamoDB throttle, say. A scheduled
     invocation that throws is just a stack trace in CloudWatch, so every
     path out of here returns a result instead. */
  let lock;
  try {
    lock = await store.acquireCatalogLock(env, { holder: who, leaseSeconds: settings.refreshLeaseSeconds });
  } catch (err) {
    console.error('catalog_lock_failed', JSON.stringify({ env, message: err?.message }));
    return { refreshed: false, reason: 'lock_failed', error: String(err?.message || err) };
  }
  if (!lock.acquired) {
    /* Not an error. The schedule firing while a long refresh is still going
       is exactly what the lease is for. */
    console.log('catalog_refresh_skipped', JSON.stringify({
      env, heldBy: lock.heldBy, leaseUntil: lock.leaseUntil
    }));
    return { refreshed: false, reason: 'already_running', heldBy: lock.heldBy };
  }

  const buildId = store.newBuildId();
  try {
    await store.recordCatalogStatus(env, { lastAttemptAt: startedAt, lastBuildId: buildId, running: true });
    /* Noted before a single byte is written, so even a build that dies on its
       first chunk leaves something for the next run to clear up. */
    await store.noteCatalogBuild(env, buildId);

    const snapshot = await buildCatalogSnapshot(square, settings);

    /* A catalog with nothing in it is almost certainly a broken read rather
       than a shop that sold everything, and publishing it would empty the
       website. Keep what we have and shout. */
    if (!snapshot.products.length) {
      throw new Error('Square returned a catalog with no sellable products; refusing to publish it.');
    }

    const written = await store.writeCatalogBuild(env, buildId, snapshot);
    const { previousBuildId } = await store.publishCatalogBuild(env, {
      buildId,
      chunkCount: written.chunkCount,
      bytes: written.bytes,
      fetchedAt: snapshot.fetchedAt,
      counts: snapshot.counts
    });

    /* Only now that the pointer has moved. */
    const pruned = await store.pruneCatalogBuilds(env, buildId)
      .catch(err => { console.error('catalog_prune_failed', err?.message); return { pruned: [] }; });

    const durationMs = Date.now() - startedAt;
    await store.recordCatalogStatus(env, {
      lastSuccessAt: Date.now(), lastDurationMs: durationMs,
      lastError: null, running: false, lastCounts: snapshot.counts
    });
    console.log('catalog_refreshed', JSON.stringify({
      env, buildId, previousBuildId, durationMs,
      chunks: written.chunkCount, bytes: written.bytes,
      products: snapshot.counts?.products, variations: snapshot.counts?.variations,
      pruned: pruned?.pruned?.length ?? 0
    }));

    return {
      refreshed: true, buildId, previousBuildId, durationMs,
      counts: snapshot.counts, chunks: written.chunkCount, bytes: written.bytes
    };

  } catch (err) {
    /* The pointer was never touched, so the previous snapshot is still the
       live one and the shop carries on. */
    console.error('catalog_refresh_failed', JSON.stringify({
      env, buildId, durationMs: Date.now() - startedAt, message: err?.message
    }));
    await store.recordCatalogStatus(env, {
      lastError: String(err?.message || err).slice(0, 500),
      lastErrorAt: Date.now(), running: false
    }).catch(() => {});
    return { refreshed: false, reason: 'failed', buildId, error: String(err?.message || err) };

  } finally {
    await store.releaseCatalogLock(env, who);
  }
}
