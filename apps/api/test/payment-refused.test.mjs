import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCardanoTransaction } from '@x402/cardano';
import { sendPayment } from '../../web/src/payFlow.ts';
import { releaseResolvedPayment } from '../../web/src/paymentRecovery.ts';

// The API sends X-Payment-Refused only when it proved that the signed
// transaction was never reserved, so nothing can have been broadcast.
test('browser treats an explicit pre-broadcast refusal as final and everything else as uncertain', async (t) => {
  const originalFetch = globalThis.fetch;
  const transaction = Buffer.from('84a3008001800200a0f5f6', 'hex').toString('base64');
  const hash = decodeCardanoTransaction(transaction).txHash;
  const payment = {
    url: 'https://shop.test/api/orders/one/pay',
    headers: { 'PAYMENT-SIGNATURE': 'original-signature' },
    payload: { accepted: { network: 'cardano:preprod' }, payload: { transaction } },
  };
  try {
    for (const [name, status, headers, expected, pattern] of [
      ['sold out refusal is final', 409, { 'X-Payment-Refused': 'SOLD_OUT' }, 'failed', /No payment was taken/],
      ['closed order refusal is final', 409, { 'X-Payment-Refused': 'ORDER_CLOSED' }, 'failed', /No payment was taken/],
      ['a plain 409 stays uncertain', 409, {}, 'unknown', /may already be on-chain/],
      ['an unknown refusal value stays uncertain', 409, { 'X-Payment-Refused': 'SOMETHING_ELSE' }, 'unknown', /may already be on-chain/],
      ['a refusal header on a non-409 stays uncertain', 503, { 'X-Payment-Refused': 'SOLD_OUT' }, 'unknown', /may already be on-chain/],
    ]) {
      await t.test(name, async () => {
        globalThis.fetch = async () => Response.json({ error: 'refused' }, { status, headers });
        const result = await sendPayment(payment, () => {}, false);
        assert.equal(result.status, expected);
        assert.match(result.message, pattern);
        const removed = [];
        releaseResolvedPayment({ removeItem: (key) => removed.push(key) }, result);
        assert.deepEqual(removed, expected === 'failed' ? ['print-prepared'] : []);
      });
    }
    await t.test('a refusal that also carries a settlement receipt is not trusted as final', async () => {
      globalThis.fetch = async () => Response.json({}, { status: 409, headers: {
        'X-Payment-Refused': 'SOLD_OUT',
        'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: false, network: 'cardano:preprod', transaction: hash, errorReason: 'unknown_error' })).toString('base64'),
      } });
      assert.equal((await sendPayment(payment, () => {}, false)).status, 'unknown');
    });
  } finally { globalThis.fetch = originalFetch; }
});
