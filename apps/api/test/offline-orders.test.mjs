import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('accepts an order and issues a real x402 offer while the printer is offline',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const schema = `offline_test_${randomUUID().replaceAll('-', '')}`;
    const connection = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await connection.connect();
    try {
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}",public`);
      for (const name of (await readdir(new URL('../../../db/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
        await connection.query(await readFile(new URL(`../../../db/${name}`, import.meta.url), 'utf8'));
      }
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
      databaseUrl.searchParams.set('options', `-csearch_path=${schema},public`);
      const env = {
        LOCAL_DATABASE_URL: databaseUrl.toString(), CARDANO_NETWORK: 'cardano:preprod',
        FACILITATOR_URL: 'https://facilitator.test',
        SELLER_ADDRESS: 'addr_test1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm',
        ADMIN_ALLOW_BEARER: "true", FRONTEND_ORIGIN: "https://shop.test", ADMIN_TOKEN: 'a'.repeat(64), GATEWAY_TOKEN: 'b'.repeat(64),
      };
      const { default: app } = await import('../src/index.ts');
      const { closeLocalPool } = await import('../src/db.ts');
      try {
        const created = await app.request('http://localhost/api/orders', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ productId: 'proof-token', name: 'Offline Customer', email: 'offline@example.com',
            addressLine1: 'Street 1', postalCode: '10115', city: 'Berlin', country: 'DE' }),
        }, env);
        assert.equal(created.status, 201);
        const order = await created.json();
        assert.equal(order.status, 'AWAITING_PAYMENT');
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({
          kinds: [{ x402Version: 2, scheme: 'exact', network: 'cardano:preprod', extra: {
            assetTransferMethods: ['default'], l1Confirmations: { minimum: 0, maximum: 20 },
          } }], extensions: [], signers: {},
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        try {
          const offer = await app.request(`http://localhost/api/orders/${order.id}/pay`, {
            method: 'POST', headers: { 'x-order-secret': order.access },
          }, env);
          assert.equal(offer.status, 402);
          assert.ok(offer.headers.get('PAYMENT-REQUIRED'));
        } finally { globalThis.fetch = originalFetch; }
      } finally { await closeLocalPool(); }
    } finally {
      await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await connection.end();
    }
  });
