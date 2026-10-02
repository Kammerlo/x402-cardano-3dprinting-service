import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { decodeCardanoTransaction } from '@x402/cardano';
import app from '../src/index.ts';
import { closeLocalPool } from '../src/db.ts';
import { erasePersonalData } from '../src/privacy.ts';

// Infrastructure tests with a deterministic facilitator double. They prove the
// order cap and erasure never interfere with a transaction that may be broadcast.
const skip = !process.env.TEST_DATABASE_URL;
const SELLER = 'addr_test1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm';
// Minimal decodable transactions; the fee field makes each hash distinct.
const tx = (fee) => Buffer.from(`84a300800180020${fee.toString(16)}a0f5f6`, 'hex').toString('base64');
const customer = (email) => ({ productId: 'proof-token', name: 'Privacy Customer', email,
  addressLine1: 'Street 1', postalCode: '10115', city: 'Berlin', country: 'DE' });

async function withShop(extraEnv, run) {
  const schema = `privacy_${randomUUID().replaceAll('-', '')}`;
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const originalFetch = globalThis.fetch;
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}",public`);
    for (const name of (await readdir(new URL('../../../db/', import.meta.url))).filter((n) => n.endsWith('.sql')).sort())
      await db.query(await readFile(new URL(`../../../db/${name}`, import.meta.url), 'utf8'));
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
    databaseUrl.searchParams.set('options', `-csearch_path=${schema},public`);
    const env = {
      LOCAL_DATABASE_URL: databaseUrl.toString(), CARDANO_NETWORK: 'cardano:preprod',
      FACILITATOR_URL: 'https://facilitator.test', SELLER_ADDRESS: SELLER,
      ADMIN_ALLOW_BEARER: 'true', FRONTEND_ORIGIN: 'https://shop.test',
      ADMIN_TOKEN: 'a'.repeat(64), GATEWAY_TOKEN: 'b'.repeat(64), ...extraEnv,
    };
    const facilitator = { calls: 0, settle: null };
    globalThis.fetch = async (url) => {
      facilitator.calls++;
      const path = String(url);
      if (path.endsWith('/supported'))
        return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: env.CARDANO_NETWORK,
          extra: { assetTransferMethods: ['default'], l1Confirmations: { minimum: 0, maximum: 20 } } }], extensions: [], signers: {} });
      if (path.endsWith('/verify')) return Response.json({ isValid: true, payer: SELLER });
      if (path.endsWith('/settle'))
        return Response.json({ success: true, transaction: facilitator.settle, network: env.CARDANO_NETWORK, payer: SELLER });
      throw new Error(`Unexpected fetch: ${path}`);
    };
    const call = (path, { body, headers = {}, auth, environment = env } = {}) => app.request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, environment);
    const create = async (email, extra = {}) => {
      const response = await call('/api/orders', { body: { ...customer(email), ...extra } });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    };
    const offer = (order, environment = env) => call(`/api/orders/${order.id}/pay`, { body: {}, headers: { 'x-order-secret': order.access }, environment });
    let requirements;
    const sign = async (order, transaction) => {
      if (!requirements) {
        const response = await offer(order, { ...env, MAX_ORDERS: '' });
        assert.equal(response.status, 402);
        requirements = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED'), 'base64').toString());
      }
      return Buffer.from(JSON.stringify({ x402Version: 2, resource: requirements.resource,
        accepted: requirements.accepts[0], payload: { transaction } })).toString('base64');
    };
    const pay = async (order, transaction, environment = env) => {
      const signature = await sign(order, transaction);
      facilitator.settle = decodeCardanoTransaction(transaction).txHash;
      return call(`/api/orders/${order.id}/pay`, { body: {}, headers: { 'x-order-secret': order.access, 'payment-signature': signature }, environment });
    };
    const reserve = async (order, transaction) => {
      await db.query('INSERT INTO payment_attempts(id,order_id,tx_hash,signed_payload) VALUES($1,$2,$3,$4)',
        [randomUUID(), order.id, decodeCardanoTransaction(transaction).txHash, await sign(order, transaction)]);
    };
    const catalog = async (environment = env) => (await call('/api/catalog', { environment })).json();
    const attempts = async (order) => (await db.query('SELECT tx_hash FROM payment_attempts WHERE order_id=$1', [order.id])).rows;
    await run({ db, env, call, create, offer, pay, reserve, catalog, attempts, facilitator });
  } finally {
    globalThis.fetch = originalFetch;
    await closeLocalPool();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
}

test('an unset order cap leaves ordering unlimited', { skip }, () => withShop({}, async ({ create, pay, catalog }) => {
  const first = await create('one@example.com');
  assert.equal((await pay(first, tx(1))).status, 200);
  await create('two@example.com');
  await create('three@example.com');
  const shop = await catalog();
  assert.equal(shop.soldOut, false);
  assert.equal(shop.maxOrders, null);
  assert.equal(shop.remaining, null);
}));

test('records the checkout acknowledgement without requiring it', { skip }, () => withShop({}, async ({ db, create }) => {
  const acknowledged = await create('ack@example.com', { acknowledged: true });
  const silent = await create('silent@example.com');
  const stamp = async (order) => (await db.query('SELECT terms_acknowledged_at FROM orders WHERE id=$1', [order.id])).rows[0].terms_acknowledged_at;
  assert.ok(await stamp(acknowledged));
  assert.equal(await stamp(silent), null);
}));

test('enforces MAX_ORDERS before broadcast and honours every reserved payment', { skip }, () => withShop({ MAX_ORDERS: '1' }, async ({ db, env, call, create, offer, pay, reserve, catalog, attempts, facilitator }) => {
  const paidFirst = await create('first@example.com');
  const late = await create('late@example.com');
  const reserved = await create('reserved@example.com');
  // Abandoned orders, including one with an unsettled reservation, do not count.
  await reserve(reserved, tx(3));
  assert.equal((await catalog()).soldOut, false);
  assert.equal((await catalog()).remaining, 1);
  assert.equal((await pay(paidFirst, tx(1))).status, 200);

  const shop = await catalog();
  assert.equal(shop.soldOut, true);
  assert.equal(shop.remaining, 0);
  assert.equal(shop.availability, 'sold_out');
  const refusedCreate = await call('/api/orders', { body: customer('refused@example.com') });
  assert.equal(refusedCreate.status, 409);

  facilitator.calls = 0;
  const refusedOffer = await offer(late);
  assert.equal(refusedOffer.status, 409);
  assert.equal(refusedOffer.headers.get('X-Payment-Refused'), 'SOLD_OUT');
  assert.match((await refusedOffer.json()).error, /No payment was requested/);
  assert.equal(facilitator.calls, 0, 'no offer is requested from the facilitator');

  const refusedPayment = await pay(late, tx(2));
  assert.equal(refusedPayment.status, 409);
  assert.equal(refusedPayment.headers.get('X-Payment-Refused'), 'SOLD_OUT');
  assert.match((await refusedPayment.json()).error, /No payment was taken/);
  assert.deepEqual(await attempts(late), []);
  assert.equal(facilitator.calls, 0, 'the signed transaction never reaches the facilitator');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND kind='SOLD_OUT_REFUSED'", [late.id])).rows[0].n, 1);

  // A transaction already reserved under another order is never reported as refused.
  const foreign = await pay(late, tx(3));
  assert.equal(foreign.status, 409);
  assert.equal(foreign.headers.get('X-Payment-Refused'), null);

  // An order holding a signed transaction is never told "no payment" at offer time.
  const reservedOffer = await offer(reserved);
  assert.equal(reservedOffer.headers.get('X-Payment-Refused'), null);
  assert.notEqual(reservedOffer.status, 409);

  // The reservation preceded the cap, so its retry settles.
  const retried = await pay(reserved, tx(3));
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [reserved.id])).rows[0].status, 'PAID');

  const admin = await (await call('/api/admin/orders', { auth: env.ADMIN_TOKEN })).json();
  assert.deepEqual(admin.orderCap, { maxOrders: 1, valid: true, sold: 2, oversold: 1 });

  // Refunds free a slot.
  await db.query("UPDATE orders SET status='REFUNDED' WHERE id IN ($1,$2)", [paidFirst.id, reserved.id]);
  assert.equal((await catalog()).soldOut, false);
  await create('after-refund@example.com');
}));

test('an invalid MAX_ORDERS fails closed for new payments but not for reserved ones', { skip }, () => withShop({}, async ({ db, env, create, offer, pay, reserve, catalog, attempts, facilitator }) => {
  const fresh = await create('fresh@example.com');
  const reserved = await create('reserved@example.com');
  await reserve(reserved, tx(5));
  const broken = { ...env, MAX_ORDERS: '-5' };
  assert.equal((await catalog(broken)).availability, 'misconfigured');

  facilitator.calls = 0;
  const refusedOffer = await offer(fresh, broken);
  assert.equal(refusedOffer.status, 503);
  assert.equal(refusedOffer.headers.get('X-Payment-Refused'), null);
  const refused = await pay(fresh, tx(4), broken);
  assert.equal(refused.status, 409);
  assert.equal(refused.headers.get('X-Payment-Refused'), 'SOLD_OUT');
  assert.deepEqual(await attempts(fresh), []);
  assert.equal(facilitator.calls, 0);

  const retried = await pay(reserved, tx(5), broken);
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [reserved.id])).rows[0].status, 'PAID');
}));

test('erases only expired personal data and closes erased unpaid orders', { skip }, () => withShop({ PII_RETENTION_DAYS: '30' }, async ({ db, env, call, create, offer, pay, reserve, attempts, facilitator }) => {
  const make = async (label, status, ageDays, txHash = null) => {
    const order = await create(`${label}@example.com`);
    await db.query(`UPDATE orders SET status=$2,tx_hash=$3,created_at=now()-$4::float8*interval '1 day',updated_at=now()-$4::float8*interval '1 day' WHERE id=$1`,
      [order.id, status, txHash, ageDays]);
    return order;
  };
  const shippedOld = await make('shipped-old', 'SHIPPED', 31, 'a'.repeat(64));
  const shippedNew = await make('shipped-new', 'SHIPPED', 5, 'b'.repeat(64));
  const refundedOld = await make('refunded-old', 'REFUNDED', 40, 'c'.repeat(64));
  const paidOld = await make('paid-old', 'PAID', 400, 'd'.repeat(64));
  const printedOld = await make('printed-old', 'PRINTED', 400, 'e'.repeat(64));
  const reviewOld = await make('review-old', 'NEEDS_REVIEW', 400, 'f'.repeat(64));
  const unpaidOld = await make('unpaid-old', 'AWAITING_PAYMENT', 31);
  const unpaidNew = await make('unpaid-new', 'AWAITING_PAYMENT', 2);
  const signedOld = await create('signed-old@example.com');
  await reserve(signedOld, tx(6));
  await db.query("UPDATE orders SET created_at=now()-interval '400 days' WHERE id=$1", [signedOld.id]);

  assert.equal(await erasePersonalData(env), 3);
  assert.equal(await erasePersonalData(env), 0, 'erasure is idempotent');
  const row = async (order) => (await db.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
  for (const order of [shippedOld, refundedOld, unpaidOld]) {
    const erased = await row(order);
    assert.ok(erased.personal_data_erased_at);
    for (const column of ['customer_name', 'email', 'address_line1', 'address_line2', 'postal_code', 'city'])
      assert.equal(erased[column], '', column);
    assert.equal(erased.country, 'DE');
  }
  assert.equal((await row(shippedOld)).tx_hash, 'a'.repeat(64));
  assert.equal((await row(shippedOld)).status, 'SHIPPED');
  for (const order of [shippedNew, paidOld, printedOld, reviewOld, unpaidNew, signedOld]) {
    const kept = await row(order);
    assert.equal(kept.personal_data_erased_at, null);
    assert.notEqual(kept.email, '');
  }

  facilitator.calls = 0;
  const closedOffer = await offer(unpaidOld);
  assert.equal(closedOffer.status, 409);
  assert.equal(closedOffer.headers.get('X-Payment-Refused'), 'ORDER_CLOSED');
  const closedPayment = await pay(unpaidOld, tx(7));
  assert.equal(closedPayment.status, 409);
  assert.equal(closedPayment.headers.get('X-Payment-Refused'), 'ORDER_CLOSED');
  assert.deepEqual(await attempts(unpaidOld), []);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND kind='CLOSED_ORDER_REFUSED'", [unpaidOld.id])).rows[0].n, 1);

  // Payments close 12 hours before an unpaid order becomes eligible for erasure.
  const closing = await make('closing', 'AWAITING_PAYMENT', 29.8);
  const closingOffer = await offer(closing);
  assert.equal(closingOffer.status, 409);
  assert.equal(closingOffer.headers.get('X-Payment-Refused'), 'ORDER_CLOSED');
  const closingPayment = await pay(closing, tx(8));
  assert.equal(closingPayment.headers.get('X-Payment-Refused'), 'ORDER_CLOSED');
  assert.deepEqual(await attempts(closing), []);
  assert.equal(await erasePersonalData(env), 0, 'not yet past retention');

  // An erased shipped order sent back for review cannot be reprinted without an address.
  const batch = randomUUID();
  await db.query("INSERT INTO print_batches(id,status,size) VALUES($1,'PRINTED',1)", [batch]);
  await db.query("UPDATE orders SET status='NEEDS_REVIEW',batch_id=$2 WHERE id=$1", [shippedOld.id, batch]);
  const requeue = await call(`/api/admin/orders/${shippedOld.id}/requeue`, { auth: env.ADMIN_TOKEN, body: { confirmedPhysicalReview: true } });
  assert.equal(requeue.status, 409);
  assert.match((await requeue.json()).error, /erased/i);
  const backToShipping = await call(`/api/admin/orders/${shippedOld.id}/status`, { auth: env.ADMIN_TOKEN, body: { status: 'PRINTED' } });
  assert.equal(backToShipping.status, 409);
}));

for (const [label, cap] of [['a reached cap', '1'], ['an invalid cap', 'abc']])
test(`a reservation still being written is never reported as refused under ${label}`, { skip }, () => withShop({ MAX_ORDERS: '1' }, async ({ db, env, create, pay, reserve, catalog, facilitator }) => {
  const racing = await create('racing@example.com');
  const winner = await create('winner@example.com');
  await reserve(winner, tx(11)); // caches the offer requirements before the cap closes
  await db.query('DELETE FROM payment_attempts WHERE order_id=$1', [winner.id]);
  assert.equal((await pay(winner, tx(11))).status, 200);
  assert.equal((await catalog()).soldOut, true);
  env.MAX_ORDERS = cap;

  // A concurrent request for the same signed transaction holds the order row
  // and has inserted its reservation, but has not committed yet.
  const hash = decodeCardanoTransaction(tx(12)).txHash;
  await db.query('BEGIN');
  await db.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [racing.id]);
  await db.query('INSERT INTO payment_attempts(id,order_id,tx_hash,signed_payload) VALUES($1,$2,$3,$4)',
    [randomUUID(), racing.id, hash, 'pending-signature']);
  let settled = false;
  const pending = pay(racing, tx(12)).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, 'the reservation waits for the competing request');
  await db.query('COMMIT');
  const response = await pending;
  assert.equal(response.headers.get('X-Payment-Refused'), null);
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(facilitator.calls > 0);
}));
