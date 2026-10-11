/* ==========================================================================
   All Star Players / durable state
   --------------------------------------------------------------------------
   One DynamoDB table, on-demand billing, every row carrying a TTL so nothing
   accumulates cost forever. Five kinds of row live in it:

     CATALOG#<env>  / MANIFEST | CHUNK#n   the cached catalog, gzipped
     IDEM#<hash>    / RECORD               one checkout attempt, and its link
     ORDER#<id>     / RECORD               what we know about an order
     TOKEN#<hash>   / RECORD               a return-page token -> order id
     EVENT#<id>     / RECORD               a webhook we have already applied
     HOLD#<varId>   / ATTEMPT#<id>         a soft hold on stock

   On soft holds, plainly: a hold is not a reservation. Square has no way to
   reserve catalog stock for a hosted checkout, and the shop sells the same
   rail to whoever is standing in front of it. A hold only stops THIS website
   promising the same last unit to two browsers at once within the hold
   window. It cannot stop an in-store sale, and it is not claimed to.
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
      await ddb.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: group.map(item => ({
            PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) }
          }))
        }
      }));
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

     `claim` is a conditional insert, so the race is settled by DynamoDB
     rather than by hope. */
  async function claimIdempotency(key, { ttlSeconds = 172800 } = {}) {
    const pk = 'IDEM#' + key;
    try {
      await ddb.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({ pk, sk: 'RECORD', status: 'PENDING', createdAt: Date.now(), ttl: nowSec() + ttlSeconds }),
        ConditionExpression: 'attribute_not_exists(pk)'
      }));
      return { claimed: true, record: null };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      return { claimed: false, record: await get(pk, 'RECORD') };
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

  /* A failed attempt must not wedge the key forever: drop it so the customer
     can press the button again. */
  async function releaseIdempotency(key) {
    await ddb.send(new DeleteItemCommand({ TableName: tableName, Key: marshall({ pk: 'IDEM#' + key, sk: 'RECORD' }) }))
      .catch(err => console.error('idem_release_failed', err?.message));
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

  /* Square can deliver the same event more than once, and says so. The first
     delivery writes the row; the rest see the condition fail and stop. */
  async function claimWebhookEvent(eventId, { ttlSeconds = 604800 } = {}) {
    try {
      await ddb.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({ pk: 'EVENT#' + eventId, sk: 'RECORD', seenAt: Date.now(), ttl: nowSec() + ttlSeconds }),
        ConditionExpression: 'attribute_not_exists(pk)'
      }));
      return true;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  /* --------------------------------------------------------- soft holds */

  async function heldQuantity(variationId, { excludeAttempt } = {}) {
    const rows = await queryPk('HOLD#' + variationId);
    const cutoff = nowSec();
    return rows
      .filter(r => String(r.sk).startsWith('ATTEMPT#'))
      .filter(r => (r.ttl ?? 0) > cutoff)              /* TTL deletion lags */
      .filter(r => !excludeAttempt || r.sk !== 'ATTEMPT#' + excludeAttempt)
      .reduce((n, r) => n + (Number(r.qty) || 0), 0);
  }

  async function placeHolds(attemptId, lines, { holdSeconds = 900 } = {}) {
    const ttl = nowSec() + holdSeconds;
    for (const group of chunkArray(lines, 25)) {
      await ddb.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: group.map(l => ({
            PutRequest: {
              Item: marshall({
                pk: 'HOLD#' + l.variationId, sk: 'ATTEMPT#' + attemptId,
                qty: l.quantity, placedAt: Date.now(), ttl
              })
            }
          }))
        }
      }));
    }
  }

  async function releaseHolds(attemptId, variationIds) {
    for (const group of chunkArray(variationIds, 25)) {
      await ddb.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: group.map(id => ({
            DeleteRequest: { Key: marshall({ pk: 'HOLD#' + id, sk: 'ATTEMPT#' + attemptId }) }
          }))
        }
      })).catch(err => console.error('hold_release_failed', err?.message));
    }
  }

  return {
    readCatalog, readCatalogStale, writeCatalog,
    claimIdempotency, completeIdempotency, releaseIdempotency,
    saveOrder, getOrder, getOrderIdForToken, updateOrderStatus,
    claimWebhookEvent,
    heldQuantity, placeHolds, releaseHolds
  };
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
