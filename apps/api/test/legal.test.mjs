import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.ts';
import { orderCapFor } from '../src/orderCap.ts';
import { retentionDaysFor } from '../src/privacy.ts';

const base = {
  CARDANO_NETWORK: 'cardano:preprod',
  FACILITATOR_URL: 'https://facilitator.test',
  SELLER_ADDRESS: 'addr_test1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm',
  FRONTEND_ORIGIN: 'https://shop.test',
};

test('MAX_ORDERS parsing distinguishes unlimited, a cap and invalid values', () => {
  assert.deepEqual(orderCapFor({}), { kind: 'unlimited' });
  assert.deepEqual(orderCapFor({ MAX_ORDERS: '' }), { kind: 'unlimited' });
  assert.deepEqual(orderCapFor({ MAX_ORDERS: '0' }), { kind: 'unlimited' });
  assert.deepEqual(orderCapFor({ MAX_ORDERS: ' 25 ' }), { kind: 'cap', n: 25 });
  for (const value of ['-5', '1.5', 'ten', '1e3', '99999999999'])
    assert.deepEqual(orderCapFor({ MAX_ORDERS: value }), { kind: 'invalid' }, value);
});

test('PII_RETENTION_DAYS defaults to 90 and rejects out-of-range values', () => {
  assert.equal(retentionDaysFor({}), 90);
  assert.equal(retentionDaysFor({ PII_RETENTION_DAYS: '30' }), 30);
  for (const value of ['0', '-1', '3651', 'soon', '7.5'])
    assert.equal(retentionDaysFor({ PII_RETENTION_DAYS: value }), 90, value);
});

test('an invalid order cap fails closed before any order is stored', async () => {
  const response = await app.request('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'proof-token', name: 'A', email: 'a@example.com',
      addressLine1: 'Street 1', postalCode: '10115', city: 'Berlin', country: 'DE' }),
  }, { ...base, MAX_ORDERS: '-5' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /order limit/i);
});

test('legal details come from configuration and report missing operator data', async () => {
  const missing = await (await app.request('http://localhost/api/legal', {}, base)).json();
  assert.equal(missing.configured, false);
  assert.equal(missing.retentionDays, 90);
  const configured = await (await app.request('http://localhost/api/legal', {}, {
    ...base,
    OPERATOR_NAME: 'Example Operator', OPERATOR_ADDRESS: 'Street 1\n10115 Berlin\nGermany',
    OPERATOR_EMAIL: 'privacy@example.com', OPERATOR_PHONE: '+49 30 000000',
    OPERATOR_REGISTER: 'Amtsgericht Berlin, HRB 0000', OPERATOR_REPRESENTATIVE: 'Jane Example',
    OPERATOR_VAT_ID: 'DE000000000', PRIVACY_SUPERVISORY_AUTHORITY: 'Berlin DPA', PII_RETENTION_DAYS: '30',
  })).json();
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.operator, {
    name: 'Example Operator', address: 'Street 1\n10115 Berlin\nGermany', email: 'privacy@example.com',
    phone: '+49 30 000000', vatId: 'DE000000000', representative: 'Jane Example', register: 'Amtsgericht Berlin, HRB 0000',
  });
  assert.equal(configured.supervisoryAuthority, 'Berlin DPA');
  assert.equal(configured.retentionDays, 30);
  assert.equal(configured.network, 'cardano:preprod');
});

test('legal details stay available while payment configuration is incomplete', async () => {
  const response = await app.request('http://localhost/api/legal', {}, { OPERATOR_NAME: 'Only Name' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
});
