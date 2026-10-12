/* ==========================================================================
   All Star Players / durable state
   --------------------------------------------------------------------------
   One DynamoDB table, on-demand billing, every row carrying a TTL so nothing
   accumulates cost forever. Five kinds of row live in it:

     CATALOG#<env>  / MANIFEST | CHUNK#n   the cached catalog, gzipped
     IDEM#<hash>    / RECORD               one checkout attempt, and its link
     ORDER#<id>     / RECORD               what we know about an order
     TOKEN#<hash>   / RECORD               a return-page token -> order id
     EVENT#<id>     / RECORD               a webhook, and whether it finished
     HOLD#<varId>   / HOLDS                every live hold on one variation
     SWEEP          / <dueAt>#<attemptId>  an abandoned checkout waiting to be
                                           cancelled and have its stock freed

   On soft holds, plainly: a hold is not a reservation. Square has no way to
   reserve catalog stock for a hosted checkout, and the shop sells the same
   rail to whoever is standing in front of it. A hold only stops THIS website
   promising the same last unit to two browsers at once within the hold
   window. It cannot stop an in-store sale, and it is not claimed to.

   All the holds on one variation live in ONE row, which is what makes
   "is there room, and if so take it" a single atomic compare-and-swap rather
   than a read followed by a write that another Lambda can slip between.

   A hold does NOT stop counting just because its clock ran out. A Square
   payment link stays payable after we stop waiting for it, so freeing the
   stock on a timer would mean selling a unit that an abandoned link can still
   buy. An entry is only taken out of the row once the order behind it has been
   confirmed cancelled, or confirmed paid. Until then it keeps holding, and
   lib/cleanup.mjs is what resolves it.
   ========================================================================== */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand,
  BatchWriteItemCommand, DeleteItemCommand
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/* DynamoDB refuses an item over 400 KB, so the catalog is gzipped and then
   split. 280 KB of base64 per chunk leaves comfortable headroom for the key
   and the other attributes. */
const CHUNK_BYTES = 280 * 1024;

export class StoreError extends Error {
  constructor(message) { super(message); this.name = 'StoreError'; }
}

const nowSec = () => Math.floor(Date.now() / 1000);

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function newToken() {
  /* 32 bytes of randomness, url-safe. Long enough that guessing another
     customer's order status is not a realistic attack. */
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* How long a claimed-but-unfinished piece of work is assumed to still be
   running. Past this, another request may take it over — which is how a
   checkout or a webhook recovers from a Lambda that was killed outright. */
const INFLIGHT_MS = Number.parseInt(process.env.INFLIGHT_RECOVERY_MS || '15000', 10);
const CAS_ATTEMPTS = 8;

/* There is deliberately no maximum age at which a hold gives up and frees its
   stock. Age is not evidence. A Square payment link that nobody has managed
   to cancel is still payable on its thousandth day, so dropping the hold
   would sell a unit that link can still buy — which is the whole thing this
   design exists to prevent.

   A hold that cannot be settled is flagged (see stuckSweeps) and waits for a
   person. That is a worse shopping experience and a correct one. */

/* Once a hold row is empty it is just litter, so it may be tidied away. */
const EMPTY_HOLD_TTL_SECONDS = 86400;

export function createStore({ tableName, client } = {}) {
  if (!tableName) throw new StoreError('TABLE_NAME is not set on the function.');
  const ddb = client || new DynamoDBClient({});

  const put = (item, extra = {}) =>
    ddb.send(new PutItemCommand({ TableName: tableName, Item: marshall(item, { removeUndefinedValues: true }), ...extra }));

  const get = async (pk, sk) => {
    const res = await ddb.send(new GetItemCommand({
      TableName: tableName, Key: marshall({ pk, sk }), ConsistentRead: true
    }));
    return res.Item ? unmarshall(res.Item) : null;
  };

  const queryPk = async (pk) => {
    const out = [];
    let start;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: marshall({ ':pk': pk }),
        ExclusiveStartKey: start,
        ConsistentRead: true
      }));
      for (const i of res.Items || []) out.push(unmarshall(i));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  };

  /* DynamoDB is allowed to accept a BatchWriteItem and quietly not do some of
     it, handing the leftovers back in UnprocessedItems. Ignoring that field
     loses writes, so every batch is driven to completion or thrown. */
  async function batchWrite(requests) {
    let pending = { [tableName]: requests };
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await ddb.send(new BatchWriteItemCommand({ RequestItems: pending }));
      const left = res.UnprocessedItems || {};
      const rows = left[tableName] || [];
      if (!rows.length) return;
      pending = { [tableName]: rows };
      await new Promise(r => setTimeout(r, 40 * 2 ** attempt));
    }
    throw new StoreError('DynamoDB would not accept ' +
      (pending[tableName] || []).length + ' writes after six tries.');
  }

  /* ------------------------------------------------------ catalog cache */

  /* The catalog is far too big to rebuild inside an HTTP request — 844
     products and 5,869 variations take minutes of Square paging, and API
     Gateway gives up at thirty seconds. So building and serving are entirely
     separate jobs, and these rows are the handover between them.

       CATALOG#<env>            / CURRENT   the pointer: which build is live
       CATALOG#<env>#B<buildId> / CHUNK#n   that build's gzipped pages
       CATALOG#<env>            / LOCK      one refresh at a time
       CATALOG#<env>            / BUILDS    what exists, so orphans get swept
       CATALOG#<env>            / STATUS    when it last ran, and how it went

     Each build gets its OWN partition and the pointer is flipped once every
     chunk has landed. That is what makes an interrupted refresh harmless:
     a half-written build is sitting in a partition nothing points at, and
     readers carry on with the previous complete snapshot. The earlier design
     overwrote chunks in place, so a refresh killed halfway through left new
     chunks under an old manifest — the two stitched together into something
     that would not parse, and the shop went dark. */

  const catalogPk = (env) => 'CATALOG#' + env;
  const buildPk = (env, buildId) => 'CATALOG#' + env + '#B' + buildId;

  function newBuildId() {
    return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z-' +
      Math.random().toString(36).slice(2, 8);
  }

  const readCatalogPointer = (env) => get(catalogPk(env), 'CURRENT');

  async function readCatalogBuild(env, buildId, expectedChunks) {
    const rows = await queryPk(buildPk(env, buildId));
    const chunks = rows
      .filter(r => typeof r.sk === 'string' && r.sk.startsWith('CHUNK#'))
      .sort((a, b) => a.sk.localeCompare(b.sk));

    if (expectedChunks !== undefined && chunks.length !== expectedChunks) {
      console.error('catalog_build_incomplete', JSON.stringify({
        env, buildId, found: chunks.length, expected: expectedChunks
      }));
      return null;
    }
    if (!chunks.length) return null;

    try {
      const packed = Buffer.from(chunks.map(c => c.data).join(''), 'base64');
      return JSON.parse(gunzipSync(packed).toString('utf8'));
    } catch (err) {
      console.error('catalog_build_unreadable', JSON.stringify({ env, buildId, message: err?.message }));
      return null;
    }
  }

  /* What a browsing request calls. One small read for the pointer, then the
     chunks it names. It never builds anything.

     Those are two separate reads, so a refresh can land in between: the
     pointer we read says A, and by the time we ask for A's chunks the
     pointer says B. Retention makes that rare, and this retry makes it
     harmless — read the pointer again, and if it has moved, follow it. */
  async function readCatalogSnapshot(env, { attempts = 3 } = {}) {
    let lastPointer = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const pointer = await readCatalogPointer(env);
      if (!pointer?.buildId) return null;
      lastPointer = pointer;

      const snapshot = await readCatalogBuild(env, pointer.buildId, pointer.chunkCount);
      if (snapshot) {
        return {
          pointer, snapshot, unreadable: false,
          buildId: pointer.buildId,
          fetchedAt: pointer.fetchedAt,
          builtAt: pointer.builtAt ?? null
        };
      }

      /* Only worth another go if somebody has moved the pointer since. */
      const again = await readCatalogPointer(env);
      if (!again?.buildId || again.buildId === pointer.buildId) break;
      console.log('catalog_pointer_moved_mid_read', JSON.stringify({
        env, from: pointer.buildId, to: again.buildId
      }));
    }
    return { pointer: lastPointer, snapshot: null, unreadable: true };
  }

  /* ---- writing a build: chunks first, pointer last, prune afterwards ---- */

  async function writeCatalogBuild(env, buildId, snapshot) {
    const packed = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')).toString('base64');
    const parts = [];
    for (let i = 0; i < packed.length; i += CHUNK_BYTES) parts.push(packed.slice(i, i + CHUNK_BYTES));

    for (const group of chunkArray(parts.map((data, i) => ({
      /* No TTL. A published build must not evaporate because refreshes
         stopped for a while; orphans are swept by pruneCatalogBuilds
         instead, which is deliberate rather than silent. */
      pk: buildPk(env, buildId), sk: 'CHUNK#' + String(i).padStart(4, '0'), data
    })), 25)) {
      await batchWrite(group.map(item => ({
        PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) }
      })));
    }
    return { chunkCount: parts.length, bytes: packed.length };
  }

  /* The flip. One write, and the new catalog is live. Everything before this
     was invisible; nothing after it is half-done. */
  async function publishCatalogBuild(env, meta) {
    const previous = await readCatalogPointer(env);
    await put({
      pk: catalogPk(env), sk: 'CURRENT',
      buildId: meta.buildId,
      chunkCount: meta.chunkCount,
      bytes: meta.bytes ?? null,
      fetchedAt: meta.fetchedAt,
      builtAt: Date.now(),
      counts: meta.counts ?? null
    });
    /* The outgoing build's clock starts now, not when it was built: readers
       that picked it up a second ago still get their grace period. */
    if (previous?.buildId && previous.buildId !== meta.buildId) {
      const builds = await readBuildLedger(env);
      await writeBuildLedger(env, builds.map(b =>
        b.id === previous.buildId && !b.supersededAt ? { ...b, supersededAt: Date.now() } : b));
    }
    return { previousBuildId: previous?.buildId ?? null };
  }

  /* The builds we know about, and what happened to them. Tolerates the older
     shape (a bare list of ids) so an already-deployed table keeps working. */
  async function readBuildLedger(env) {
    const row = await get(catalogPk(env), 'BUILDS');
    if (Array.isArray(row?.builds)) return row.builds.filter(b => b && b.id);
    if (Array.isArray(row?.ids)) return row.ids.filter(Boolean).map(id => ({ id, startedAt: 0, supersededAt: 0 }));
    return [];
  }

  const writeBuildLedger = (env, builds) =>
    put({ pk: catalogPk(env), sk: 'BUILDS', builds: builds.slice(-24) });

  /* Noted the moment a build is started, so a refresh that dies halfway
     leaves a trail and the next run can clear up after it. */
  async function noteCatalogBuild(env, buildId) {
    const builds = await readBuildLedger(env);
    if (builds.some(b => b.id === buildId)) return;
    await writeBuildLedger(env, [...builds, { id: buildId, startedAt: Date.now(), supersededAt: 0 }]);
  }

  /* Delete the builds nothing points at AND nothing can still be reading.

     The grace period is the whole point. A browsing request reads the pointer
     and then fetches that build's chunks as a second call; deleting the build
     between those two reads used to strand it, and the shop answered 503 even
     though a perfectly good newer build existed. A superseded build therefore
     sticks around for BUILD_RETENTION_SECONDS before it goes.

     A build that was never published gets the same grace from when it was
     started, so a refresh still writing its chunks is never swept out from
     under itself. */
  async function pruneCatalogBuilds(env, keepBuildId, { retentionSeconds = 900 } = {}) {
    const builds = await readBuildLedger(env);
    const cutoff = Date.now() - retentionSeconds * 1000;

    const doomed = builds.filter(b => {
      if (!b.id || b.id === keepBuildId) return false;
      const settledAt = Number(b.supersededAt || b.startedAt || 0);
      /* Nothing recorded at all is an old-format row; treat it as ripe. */
      if (!settledAt) return true;
      return settledAt <= cutoff;
    });

    for (const b of doomed) {
      const rows = await queryPk(buildPk(env, b.id));
      for (const group of chunkArray(rows, 25)) {
        await batchWrite(group.map(r => ({ DeleteRequest: { Key: marshall({ pk: r.pk, sk: r.sk }) } })))
          .catch(err => console.error('catalog_prune_failed', b.id, err?.message));
      }
    }

    const doomedIds = new Set(doomed.map(b => b.id));
    const kept = builds.filter(b => !doomedIds.has(b.id));
    await writeBuildLedger(env, kept);
    return { pruned: [...doomedIds], retained: kept.map(b => b.id) };
  }

  /* --------------------------- one refresh at a time --------------------- */

  /* A lease rather than a flag, so a refresh killed by a Lambda timeout does
     not wedge the schedule forever. The lease must outlast the function's own
     timeout — see REFRESH_LEASE_SECONDS in DEPLOY.md — which is why there is
     no heartbeat to get wrong. */
  async function acquireCatalogLock(env, { holder, leaseSeconds = 600 } = {}) {
    const now = nowSec();
    try {
      await ddb.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk: catalogPk(env), sk: 'LOCK',
          holder, startedAt: Date.now(), leaseUntil: now + leaseSeconds
        }),
        ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now',
        ExpressionAttributeValues: marshall({ ':now': now })
      }));
      return { acquired: true };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const held = await get(catalogPk(env), 'LOCK');
      return { acquired: false, heldBy: held?.holder ?? null, leaseUntil: held?.leaseUntil ?? null };
    }
  }

  async function releaseCatalogLock(env, holder) {
    await ddb.send(new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ pk: catalogPk(env), sk: 'LOCK' }),
      ConditionExpression: '#h = :holder',
      ExpressionAttributeNames: { '#h': 'holder' },
      ExpressionAttributeValues: marshall({ ':holder': holder })
    })).catch(err => {
      /* Somebody else's lease: leave it alone. */
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.error('catalog_lock_release_failed', err?.message);
      }
    });
  }

  const readCatalogStatus = (env) => get(catalogPk(env), 'STATUS');

  async function recordCatalogStatus(env, patch) {
    const existing = (await get(catalogPk(env), 'STATUS')) || {};
    await put({ pk: catalogPk(env), sk: 'STATUS', ...existing, ...patch, updatedAt: Date.now() });
  }

  /* -------------------------------------------------------- idempotency */

  /* The first caller to present a key wins the right to create the order.
     Everybody else — a retried fetch, a double-tapped button, a flaky phone
     network — gets the same answer back instead of a second order.

     The status token is written here, BEFORE Square is called, so that a
     container killed between "Square made the link" and "we wrote it down"
     can be recovered: the retry adopts the same token and re-sends the same
     Square request, and Square's own idempotency returns the same link. */
  async function claimIdempotency(key, { statusToken, ttlSeconds = 172800 } = {}) {
    const pk = 'IDEM#' + key;
    try {
      await ddb.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk, sk: 'RECORD', status: 'PENDING', statusToken,
          createdAt: Date.now(), ttl: nowSec() + ttlSeconds
        }, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(pk)'
      }));
      return { claimed: true, record: null, statusToken, generation: 0 };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const record = await get(pk, 'RECORD');
      if (!record) return { claimed: false, record: null };

      if (record.status === 'DONE') return { claimed: false, record, state: 'done' };

      /* Cleanup cancelled the link this row points at. Replaying it would
         hand the customer a dead checkout page. Start a new generation
         instead, which also changes the Square idempotency key, so Square
         makes a genuinely new link rather than returning the cancelled one. */
      if (record.status === 'CANCELED') {
        const generation = Number(record.generation || 0) + 1;
        await ddb.send(new UpdateItemCommand({
          TableName: tableName,
          Key: marshall({ pk, sk: 'RECORD' }),
          UpdateExpression: 'SET #s = :pending, generation = :g, statusToken = :tok, createdAt = :now REMOVE #r',
          ExpressionAttributeNames: { '#s': 'status', '#r': 'result' },
          ExpressionAttributeValues: marshall({
            ':pending': 'PENDING', ':g': generation, ':tok': statusToken, ':now': Date.now()
          }, { removeUndefinedValues: true })
        }));
        return { claimed: true, record, state: 'renewed', statusToken, generation };
      }

      /* A PENDING row older than the in-flight window belonged to a request
         that is not coming back. Take it over, keeping its token. */
      const age = Date.now() - Number(record.createdAt || 0);
      if (age > INFLIGHT_MS) {
        await ddb.send(new UpdateItemCommand({
          TableName: tableName,
          Key: marshall({ pk, sk: 'RECORD' }),
          UpdateExpression: 'SET createdAt = :now',
          ExpressionAttributeValues: marshall({ ':now': Date.now() })
        })).catch(() => {});
        return { claimed: true, record, state: 'recovered',
                 statusToken: record.statusToken || statusToken,
                 generation: Number(record.generation || 0) };
      }
      return { claimed: false, record, state: 'in_progress' };
    }
  }

  async function completeIdempotency(key, result, { ttlSeconds = 172800 } = {}) {
    await ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ pk: 'IDEM#' + key, sk: 'RECORD' }),
      UpdateExpression: 'SET #s = :done, #r = :r, #u = :u, #t = :t',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'result', '#u': 'updatedAt', '#t': 'ttl' },
      ExpressionAttributeValues: marshall(
        { ':done': 'DONE', ':r': result, ':u': Date.now(), ':t': nowSec() + ttlSeconds },
        { removeUndefinedValues: true }
      )
    }));
  }

  /* A failed attempt must not wedge the key. The row is kept — it still holds
     the status token, which the Square link out there may already be tied to —
     but its age is reset so the very next request takes it over instead of
     being told to wait. */
  async function markIdempotencyRecoverable(key) {
    await ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ pk: 'IDEM#' + key, sk: 'RECORD' }),
      UpdateExpression: 'SET createdAt = :zero',
      ExpressionAttributeValues: marshall({ ':zero': 0 }),
      ConditionExpression: 'attribute_exists(pk)'
    })).catch(err => console.error('idem_recoverable_failed', err?.message));
  }

  /* Called by cleanup once a link has been confirmed dead. */
  async function markIdempotencyCanceled(key) {
    await ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ pk: 'IDEM#' + key, sk: 'RECORD' }),
      UpdateExpression: 'SET #s = :c, canceledAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':c': 'CANCELED', ':now': Date.now() }),
      ConditionExpression: 'attribute_exists(pk)'
    })).catch(err => console.error('idem_cancel_mark_failed', err?.message));
  }

  /* -------------------------------------------------------------- orders */

  async function saveOrder(order, { retentionDays = 90 } = {}) {
    const ttl = nowSec() + retentionDays * 86400;
    await put({ pk: 'ORDER#' + order.orderId, sk: 'RECORD', ...order, ttl });
    if (order.statusTokenHash) {
      await put({ pk: 'TOKEN#' + order.statusTokenHash, sk: 'RECORD', orderId: order.orderId, ttl });
    }
  }

  const getOrder = (orderId) => get('ORDER#' + orderId, 'RECORD');
  const getOrderIdForToken = async (tokenHash) => (await get('TOKEN#' + tokenHash, 'RECORD'))?.orderId || null;

  async function updateOrderStatus(orderId, patch) {
    const names = {}; const values = {}; const sets = [];
    for (const [k, v] of Object.entries({ ...patch, updatedAt: Date.now() })) {
      names['#' + k] = k; values[':' + k] = v; sets.push('#' + k + ' = :' + k);
    }
    await ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ pk: 'ORDER#' + orderId, sk: 'RECORD' }),
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      /* Never conjure an order row out of a webhook for an order this site
         did not create. */
      ConditionExpression: 'attribute_exists(pk)'
    }));
  }

  /* ------------------------------------------------------------ webhooks */

  /* Square delivers the same event more than once, and says so. But "we have
     seen this id" is not the same as "we have finished with it": a delivery
     that claimed the id and then failed must be allowed to run again, or the
     order silently never updates.

     So the row carries a state. Only DONE means "skip me". */
  async function beginWebhookEvent(eventId, { ttlSeconds = 604800 } = {}) {
    const pk = 'EVENT#' + eventId;
    try {
      await ddb.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({ pk, sk: 'RECORD', status: 'PENDING', startedAt: Date.now(), ttl: nowSec() + ttlSeconds }),
        ConditionExpression: 'attribute_not_exists(pk)'
      }));
      return 'new';
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const row = await get(pk, 'RECORD');
      if (!row) return 'new';
      if (row.status === 'DONE') return 'done';
      /* Fresh PENDING: another delivery is working on it right now. Older
         than the window: whoever had it is gone, so take it over. */
      if (Date.now() - Number(row.startedAt || 0) < INFLIGHT_MS) return 'in_progress';
      await ddb.send(new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ pk, sk: 'RECORD' }),
        UpdateExpression: 'SET startedAt = :now',
        ExpressionAttributeValues: marshall({ ':now': Date.now() })
      })).catch(() => {});
      return 'new';
    }
  }

  async function completeWebhookEvent(eventId, { ttlSeconds = 604800 } = {}) {
    await ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ pk: 'EVENT#' + eventId, sk: 'RECORD' }),
      UpdateExpression: 'SET #s = :done, finishedAt = :now, #t = :t',
      ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
      ExpressionAttributeValues: marshall({ ':done': 'DONE', ':now': Date.now(), ':t': nowSec() + ttlSeconds })
    }));
  }

  /* Processing blew up. Drop the claim so Square's retry starts clean. */
  async function releaseWebhookEvent(eventId) {
    await ddb.send(new DeleteItemCommand({
      TableName: tableName, Key: marshall({ pk: 'EVENT#' + eventId, sk: 'RECORD' })
    })).catch(err => console.error('event_release_failed', err?.message));
  }

  /* --------------------------------------------------------- soft holds */

  /* Every live hold on one variation sits in a single row:

       { pk: "HOLD#<variationId>", sk: "HOLDS", version: 7,
         entries: [ { attemptId, qty, expiresAt } , ... ] }

     Keeping them together is the whole point. "Is there room for me, and if
     so take it" becomes one conditional write against `version`, so two
     Lambdas racing for the last unit cannot both read 'one available' and
     both write a hold. The loser's condition fails, it re-reads, and it sees
     the winner's entry.

     Expiry is handled on the way past: every read drops entries whose
     expiresAt has gone by, so a lapsed hold stops counting without anything
     having to sweep up after it. */

  /* Everything still holding stock — which is everything, until something
     takes it out explicitly.

     expiresAt is a schedule, not an expiry. It says when cleanup should go
     looking; it does not say the customer's payment link has stopped working,
     because it has not. The only ways an entry leaves this list are
     releaseHolds, called by cleanup once Square has confirmed the order is
     paid or cancelled, and the deliberate manual release. */
  function liveEntries(row, { excludeAttempt } = {}) {
    const all = Array.isArray(row?.entries) ? row.entries : [];
    return all.filter(e => e && (!excludeAttempt || e.attemptId !== excludeAttempt));
  }

  async function heldQuantity(variationId, { excludeAttempt } = {}) {
    const row = await get('HOLD#' + variationId, 'HOLDS');
    return liveEntries(row, { excludeAttempt }).reduce((n, e) => n + (Number(e.qty) || 0), 0);
  }

  async function writeHolds(variationId, row, entries) {
    const version = Number(row?.version || 0) + 1;
    const item = {
      pk: 'HOLD#' + variationId, sk: 'HOLDS',
      version, entries, updatedAt: Date.now(),
      /* No TTL while anything is held. A TTL here would be DynamoDB quietly
         doing the thing this design refuses to do: freeing stock on a timer,
         with no proof and no log line. An empty row is litter and may go. */
      ttl: entries.length ? undefined : nowSec() + EMPTY_HOLD_TTL_SECONDS
    };
    await ddb.send(new PutItemCommand({
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
      ...(row
        ? {
            ConditionExpression: '#v = :v',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: marshall({ ':v': Number(row.version || 0) })
          }
        : { ConditionExpression: 'attribute_not_exists(pk)' })
    }));
  }

  /* Take `qty` of one variation, or report that there is not room.
     `available` is null when stock is not counted, which means no ceiling to
     enforce here — the catalog has already decided whether such a variation
     may be sold at all. */
  async function acquireOne(attemptId, variationId, qty, available, holdSeconds) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const row = await get('HOLD#' + variationId, 'HOLDS');
      const others = liveEntries(row, { excludeAttempt: attemptId });
      const held = others.reduce((n, e) => n + (Number(e.qty) || 0), 0);

      if (available !== null && available !== undefined && held + qty > available) {
        return { ok: false, variationId, available: Math.max(0, available - held) };
      }
      const entries = others.concat([{ attemptId, qty, expiresAt: nowSec() + holdSeconds }]);
      try {
        await writeHolds(variationId, row, entries);
        return { ok: true, variationId };
      } catch (err) {
        /* Somebody else wrote first. Read again and see where that leaves us. */
        if (err?.name === 'ConditionalCheckFailedException') continue;
        throw err;
      }
    }
    throw new StoreError('Could not settle a stock hold on ' + variationId + ' after ' + CAS_ATTEMPTS + ' tries.');
  }

  /* All or nothing across the cart: a line that cannot be held rolls back the
     ones already taken, so a customer is never half-reserved. */
  async function acquireHolds(attemptId, lines, { holdSeconds = 900, availability = new Map() } = {}) {
    const taken = [];
    try {
      for (const line of lines) {
        const available = availability.has(line.variationId) ? availability.get(line.variationId) : null;
        const result = await acquireOne(attemptId, line.variationId, line.quantity, available, holdSeconds);
        if (!result.ok) {
          await releaseHolds(attemptId, taken);
          return { ok: false, conflict: result };
        }
        taken.push(line.variationId);
      }
      return { ok: true, held: taken };
    } catch (err) {
      await releaseHolds(attemptId, taken);
      throw err;
    }
  }

  async function releaseOne(attemptId, variationId) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const row = await get('HOLD#' + variationId, 'HOLDS');
      if (!row) return;
      const entries = liveEntries(row, { excludeAttempt: attemptId });
      if (entries.length === (Array.isArray(row.entries) ? row.entries.length : 0)) return;  /* nothing of ours */
      try {
        await writeHolds(variationId, row, entries);
        return;
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') continue;
        throw err;
      }
    }
    console.error('hold_release_gave_up', variationId, attemptId);
  }

  async function releaseHolds(attemptId, variationIds) {
    for (const id of variationIds || []) {
      await releaseOne(attemptId, id).catch(err => console.error('hold_release_failed', err?.message));
    }
  }

  /* ------------------------------------------------------- the sweep queue */

  /* Every checkout that takes a hold also leaves a note here saying when it
     should be chased up. The sort key is the due time, so finding the work
     is one Query with a range condition rather than a table scan — which is
     also why the IAM policy needs no dynamodb:Scan.

     One partition is plenty at this shop's volume: a row per checkout, gone
     again within the hour. */
  const SWEEP_PK = 'SWEEP';
  const dueKey = (dueAt, attemptId) => String(dueAt).padStart(12, '0') + '#' + attemptId;

  async function enqueueSweep(entry) {
    const { dueAt, attemptId } = entry;
    const row = { ...entry };
    delete row.pk; delete row.sk; delete row.ttl;
    await put({
      pk: SWEEP_PK, sk: dueKey(dueAt, attemptId),
      ...row,
      attempts: entry.attempts || 0
      /* No TTL, on purpose. This row is the only record of which hold needs
         settling and which payment link has to die first. If DynamoDB aged it
         out, the hold would sit there forever with nothing coming for it, and
         nobody would know. It is removed by deleteSweep, once settled. */
    });
  }

  /* Everything cleanup has given up on. The holds behind these are still
     held; each one needs a person to look at the order in Square. */
  async function stuckSweeps() {
    const rows = await queryPk(SWEEP_PK);
    return rows.filter(r => r.stuck === true);
  }

  /* Find one job by its attempt, for the manual release. */
  async function sweepForAttempt(attemptId) {
    const rows = await queryPk(SWEEP_PK);
    return rows.find(r => r.attemptId === attemptId) || null;
  }

  async function dueSweeps({ now = nowSec(), limit = 25 } = {}) {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk AND #sk < :sk',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: marshall({ ':pk': SWEEP_PK, ':sk': dueKey(now, '') }),
      Limit: limit,
      ConsistentRead: true
    }));
    return (res.Items || []).map(i => unmarshall(i));
  }

  async function deleteSweep(row) {
    await ddb.send(new DeleteItemCommand({
      TableName: tableName, Key: marshall({ pk: row.pk, sk: row.sk })
    }));
  }

  /* Move a job later. The due time is in the sort key, so this is a write at
     the new key followed by a delete of the old one — in that order, because
     losing the job would leave stock held with nothing coming to free it. */
  async function rescheduleSweep(row, { dueAt, patch = {} }) {
    const next = { ...row, ...patch, dueAt };
    delete next.pk; delete next.sk;
    await enqueueSweep({ ...next, attemptId: row.attemptId, dueAt });
    if (dueKey(dueAt, row.attemptId) !== row.sk) await deleteSweep(row);
  }

  return {
    readCatalogPointer, readCatalogBuild, readCatalogSnapshot,
    writeCatalogBuild, publishCatalogBuild, noteCatalogBuild, pruneCatalogBuilds, readBuildLedger,
    acquireCatalogLock, releaseCatalogLock,
    readCatalogStatus, recordCatalogStatus, newBuildId,
    enqueueSweep, dueSweeps, deleteSweep, rescheduleSweep, stuckSweeps, sweepForAttempt,
    markIdempotencyCanceled,
    claimIdempotency, completeIdempotency, markIdempotencyRecoverable,
    saveOrder, getOrder, getOrderIdForToken, updateOrderStatus,
    beginWebhookEvent, completeWebhookEvent, releaseWebhookEvent,
    heldQuantity, acquireHolds, releaseHolds
  };
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
