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

   On soft holds, plainly: a hold is not a reservation. Square has no way to
   reserve catalog stock for a hosted checkout, and the shop sells the same
   rail to whoever is standing in front of it. A hold only stops THIS website
   promising the same last unit to two browsers at once within the hold
   window. It cannot stop an in-store sale, and it is not claimed to.

   All the holds on one variation live in ONE row, which is what makes
   "is there room, and if so take it" a single atomic compare-and-swap rather
   than a read followed by a write that another Lambda can slip between.
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

  async function readCatalog(env) {
    const manifest = await get('CATALOG#' + env, 'MANIFEST');
    if (!manifest) return null;
    if (manifest.expiresAt && manifest.expiresAt <= nowSec()) return null;

    const rows = await queryPk('CATALOG#' + env);
    const chunks = rows
      .filter(r => typeof r.sk === 'string' && r.sk.startsWith('CHUNK#'))
      .sort((a, b) => a.sk.localeCompare(b.sk));
    if (chunks.length !== manifest.chunkCount) return null;   /* half-written */

    try {
      const packed = Buffer.from(chunks.map(c => c.data).join(''), 'base64');
      return { snapshot: JSON.parse(gunzipSync(packed).toString('utf8')), fetchedAt: manifest.fetchedAt };
    } catch (err) {
      console.error('catalog_cache_unreadable', err?.message);
      return null;
    }
  }

  async function writeCatalog(env, snapshot, ttlSeconds) {
    const packed = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')).toString('base64');
    const parts = [];
    for (let i = 0; i < packed.length; i += CHUNK_BYTES) parts.push(packed.slice(i, i + CHUNK_BYTES));
    const expiresAt = nowSec() + ttlSeconds;
    /* A generous TTL on the rows themselves: `expiresAt` is what decides
       freshness, while `ttl` only stops dead rows piling up. Keeping the rows
       a little longer means a Square outage can still be served stale rather
       than showing an empty shop. */
    const ttl = nowSec() + Math.max(ttlSeconds * 6, 3600);

    for (const group of chunkArray(parts.map((data, i) => ({
      pk: 'CATALOG#' + env, sk: 'CHUNK#' + String(i).padStart(4, '0'), data, ttl
    })), 25)) {
      await batchWrite(group.map(item => ({
        PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) }
      })));
    }
    /* The manifest goes last on purpose. Until it lands, a reader sees the
       previous manifest and the previous chunk count, so it never stitches
       half of one snapshot onto half of another. */
    await put({
      pk: 'CATALOG#' + env, sk: 'MANIFEST',
      chunkCount: parts.length, fetchedAt: snapshot.fetchedAt,
      productCount: snapshot.counts?.products ?? 0,
      expiresAt, ttl
    });
    return { chunkCount: parts.length, bytes: packed.length };
  }

  /* Used when Square is down: ignore freshness and serve whatever is there. */
  async function readCatalogStale(env) {
    const manifest = await get('CATALOG#' + env, 'MANIFEST');
    if (!manifest) return null;
    const rows = await queryPk('CATALOG#' + env);
    const chunks = rows.filter(r => String(r.sk).startsWith('CHUNK#')).sort((a, b) => a.sk.localeCompare(b.sk));
    if (chunks.length !== manifest.chunkCount) return null;
    try {
      const packed = Buffer.from(chunks.map(c => c.data).join(''), 'base64');
      return { snapshot: JSON.parse(gunzipSync(packed).toString('utf8')), fetchedAt: manifest.fetchedAt, stale: true };
    } catch { return null; }
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
      return { claimed: true, record: null, statusToken };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const record = await get(pk, 'RECORD');
      if (!record) return { claimed: false, record: null };

      if (record.status === 'DONE') return { claimed: false, record, state: 'done' };

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
        return { claimed: true, record, state: 'recovered', statusToken: record.statusToken || statusToken };
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

  function liveEntries(row, { excludeAttempt } = {}) {
    const now = nowSec();
    const all = Array.isArray(row?.entries) ? row.entries : [];
    return all.filter(e => e && Number(e.expiresAt) > now &&
      (!excludeAttempt || e.attemptId !== excludeAttempt));
  }

  async function heldQuantity(variationId, { excludeAttempt } = {}) {
    const row = await get('HOLD#' + variationId, 'HOLDS');
    return liveEntries(row, { excludeAttempt }).reduce((n, e) => n + (Number(e.qty) || 0), 0);
  }

  async function writeHolds(variationId, row, entries) {
    const version = Number(row?.version || 0) + 1;
    const maxExpiry = entries.reduce((m, e) => Math.max(m, Number(e.expiresAt) || 0), nowSec());
    const item = {
      pk: 'HOLD#' + variationId, sk: 'HOLDS',
      version, entries, updatedAt: Date.now(),
      /* The row itself lingers a little past its last hold, then goes. */
      ttl: maxExpiry + 3600
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

  return {
    readCatalog, readCatalogStale, writeCatalog,
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
