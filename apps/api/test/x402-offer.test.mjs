import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';

// Contract test for the SDK middleware's initialization and Hono response handoff.
// This does not simulate or mark an application order paid.
for (const network of ['cardano:preprod', 'cardano:mainnet']) {
  test(`issues an actual x402 offer for ${network}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      kinds: [{ x402Version: 2, scheme: 'exact', network, extra: {
        assetTransferMethods: ['default'], l1Confirmations: { minimum: 0, maximum: 20 },
      } }], extensions: [], signers: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const app = new Hono();
      const payTo = network === 'cardano:preprod'
        ? 'addr_test1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm'
        : 'addr1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm';
      app.post('/pay', async c => {
        const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: 'https://facilitator.test' })).register(network, new ExactCardanoScheme());
        const middleware = paymentMiddleware({ [`POST ${c.req.path}`]: { accepts: {
          scheme: 'exact', network, price: { asset: 'lovelace', amount: '5000000' }, payTo,
        } } }, server);
        const immediate = await middleware(c, async () => { c.res = c.json({ paid: true }); });
        if (immediate instanceof Response) c.res = immediate;
        return c.res;
      });
      const response = await app.request('http://localhost/pay', { method: 'POST' });
      assert.equal(response.status, 402);
      const required = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
      assert.equal(required.accepts[0].network, network);
      assert.equal(required.accepts[0].amount, '5000000');
      assert.equal(required.accepts[0].payTo, payTo);
    } finally { globalThis.fetch = originalFetch; }
  });
}
