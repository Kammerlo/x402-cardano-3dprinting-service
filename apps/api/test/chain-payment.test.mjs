import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCardanoTransaction } from '@x402/cardano';
import { verifyOnChain } from '../src/chainPayment.ts';

test('on-chain recovery verifies the stored payment, recipient, amount and confirmation depth', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const diagnostics = [];
  console.error = (...args) => diagnostics.push(args);
  const transaction = Buffer.from('84a3008001800200a0f5f6', 'hex').toString('base64');
  const hash = decodeCardanoTransaction(transaction).txHash;
  const env = { SELLER_ADDRESS: 'addr_test1seller', BLOCKFROST_PREPROD_PROJECT_ID: 'test-key' };
  const payload = { accepted: { scheme: 'exact', network: 'cardano:preprod', payTo: env.SELLER_ADDRESS, amount: '5000000', asset: 'lovelace', extra: { confirmationPolicy: { l1Confirmations: 2 } } }, payload: { transaction } };
  const order = { id: 'order', network: 'cardano:preprod', price_lovelace: '5000000', tx_hash: hash, signed_payload: Buffer.from(JSON.stringify(payload)).toString('base64') };
  const fixtures = () => ({
    [`/txs/${hash}`]: { hash, block: 'blockhash', block_height: 100, valid_contract: true },
    [`/txs/${hash}/utxos`]: { hash, outputs: [{ address: env.SELLER_ADDRESS, amount: [{ unit: 'lovelace', quantity: '5000000' }] }] },
    '/blocks/100': { hash: 'blockhash', height: 100 },
    '/blocks/latest': { height: 102 },
  });
  try {
    for (const [name, modify, expected] of [
      ['valid payment', () => {}, 'CONFIRMED'],
      ['wrong recipient', f => { f[`/txs/${hash}/utxos`].outputs[0].address = 'another-address'; }, 'MISMATCH'],
      ['underpayment', f => { f[`/txs/${hash}/utxos`].outputs[0].amount[0].quantity = '4999999'; }, 'MISMATCH'],
      ['phase two failure', f => { f[`/txs/${hash}`].valid_contract = false; }, 'MISMATCH'],
      ['noncanonical block', f => { f['/blocks/100'].hash = 'different-block'; }, 'MISMATCH'],
      ['not enough confirmations', f => { f['/blocks/latest'].height = 101; }, 'CONFIRMING'],
      ['missing transaction', f => { f[`/txs/${hash}`] = null; }, 'NOT_FOUND'],
      ['different transaction response', f => { f[`/txs/${hash}`].hash = 'f'.repeat(64); }, 'MISMATCH'],
    ]) await t.test(name, async () => {
      const data = fixtures(); modify(data);
      globalThis.fetch = async (url, options) => {
        assert.ok(String(url).startsWith('https://cardano-preprod.blockfrost.io/api/v0/'));
        assert.equal(options.headers.project_id, 'test-key');
        const value = data[new URL(url).pathname.replace('/api/v0', '')];
        return Response.json(value, { status: value ? 200 : 404 });
      };
      assert.equal((await verifyOnChain(env, order)).status, expected);
    });
    globalThis.fetch = async () => Response.json({}, { status: 429 });
    assert.equal((await verifyOnChain(env, order)).status, 'UNAVAILABLE');
    assert.deepEqual(diagnostics.at(-1), [
      'chain check unavailable',
      { orderId: 'order', network: 'cardano:preprod', stage: 'transaction', reason: 'http_error', httpStatus: 429 },
    ]);
    assert.equal((await verifyOnChain(env, { ...order, signed_payload: 'not-a-payment' })).status, 'UNAVAILABLE');
    assert.deepEqual(diagnostics.at(-1), [
      'chain check unavailable',
      { orderId: 'order', network: 'cardano:preprod', stage: 'signed_payment', reason: 'unexpected_error' },
    ]);
    assert.equal((await verifyOnChain({}, order)).status, 'NOT_CONFIGURED');
    assert.equal((await verifyOnChain(env, { ...order, network: 'wrong-network' })).status, 'MISMATCH');
    assert.equal((await verifyOnChain(env, { ...order, tx_hash: 'f'.repeat(64) })).status, 'MISMATCH');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
