import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.ts';
import { createCip30Signer } from '../../web/src/cip30.ts';

test('wrong wallet network is rejected before accessing wallet inputs', async () => {
  for (const [network, walletNetwork] of [['cardano:preprod', 1], ['cardano:mainnet', 0]]) {
    const wallet = { getNetworkId: async () => walletNetwork };
    await assert.rejects(createCip30Signer(wallet, { network, projectId: 'test-key', baseUrl: 'https://unused.test' }, true), /Switch your wallet/);
  }
});

test('a changed shop network rejects checkout before any database access', async () => {
  const response = await app.request('https://shop.test/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedNetwork: 'cardano:mainnet' }),
  }, {
    CARDANO_NETWORK: 'cardano:preprod',
    SELLER_ADDRESS: 'addr_test1' + 'a'.repeat(60),
    FACILITATOR_URL: 'https://unused.test',
    FRONTEND_ORIGIN: 'https://shop.test',
    // No DB configured: any attempt to persist would fail this test.
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /network changed/);
});
