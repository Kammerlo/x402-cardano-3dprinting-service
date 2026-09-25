import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCardanoTransaction } from '@x402/cardano';
import { sendPayment } from '../../web/src/payFlow.ts';
import { releaseResolvedPayment } from '../../web/src/paymentRecovery.ts';

// Deterministic protocol responses: no wallet, funds, facilitator or network used.
test('browser distinguishes rejected payments from uncertain settlement', async (t) => {
  const originalFetch = globalThis.fetch;
  const transaction = Buffer.from('84a3008001800200a0f5f6', 'hex').toString('base64');
  const hash = decodeCardanoTransaction(transaction).txHash;
  const payment = {
    url: 'https://shop.test/api/orders/one/pay',
    headers: { 'PAYMENT-SIGNATURE': 'original-signature' },
    payload: { accepted: { network: 'cardano:preprod' }, payload: { transaction } },
  };
  const receipt = (values) => ({
    'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({
      success: false, network: 'cardano:preprod', transaction: hash, ...values,
    })).toString('base64'),
  });
  try {
    for (const [name, status, headers, resuming, expected] of [
      ['initial verification rejection', 402, {}, false, 'failed'],
      ['recheck rejection cannot disprove an earlier submission', 402, {}, true, 'unknown'],
      ['generic settlement failure is uncertain even on first request', 402, receipt({ errorReason: 'unknown_error' }), false, 'unknown'],
      ['definitive settlement rejection', 402, receipt({ errorReason: 'exact_cardano_settlement_definitively_rejected' }), true, 'failed'],
      ['confirmed expiry', 402, receipt({ errorReason: 'exact_cardano_settlement_failed', extra: { status: 'expired' } }), true, 'failed'],
      ['pending confirmation', 402, receipt({ errorReason: 'settlement_pending' }), true, 'pending'],
      ['mismatched rejection cannot unlock payment', 402, receipt({ errorReason: 'exact_cardano_settlement_definitively_rejected', transaction: '0'.repeat(64) }), true, 'unknown'],
      ['server error', 503, {}, false, 'unknown'],
      ['successful settlement', 200, receipt({ success: true }), true, 'settled'],
    ]) {
      await t.test(name, async () => {
        globalThis.fetch = async (url, init) => {
          assert.equal(url, payment.url);
          assert.equal(init.headers['PAYMENT-SIGNATURE'], 'original-signature');
          return Response.json({ status: 'PAID', transaction: hash }, { status, headers });
        };
        const result = await sendPayment(payment, () => {}, resuming);
        assert.equal(result.status, expected);
        const removed = [];
        releaseResolvedPayment({ removeItem: (key) => removed.push(key) }, result);
        assert.deepEqual(removed, ['failed', 'settled'].includes(expected) ? ['print-prepared'] : []);
      });
    }
    await t.test('connection loss keeps original payment recoverable', async () => {
      globalThis.fetch = async () => { throw new Error('connection lost'); };
      assert.equal((await sendPayment(payment, () => {}, false)).status, 'unknown');
    });
  } finally { globalThis.fetch = originalFetch; }
});
