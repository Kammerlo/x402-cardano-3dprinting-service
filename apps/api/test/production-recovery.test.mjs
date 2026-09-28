import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { decodeCardanoTransaction } from "@x402/cardano";
import app from "../src/index.ts";
import { verifyOnChain } from "../src/chainPayment.ts";
import { closeLocalPool } from "../src/db.ts";

// Infrastructure integration tests. The facilitator is a deterministic test double;
// these prove application recovery, never live-chain settlement or printer behavior.
test(
  "offline settlement, duplicate requests, cached receipt recovery and supervised fulfillment",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const originalFetch = globalThis.fetch;
    try {
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}",public`);
      const migrations = (
        await readdir(new URL("../../../db/", import.meta.url))
      )
        .filter((n) => n.endsWith(".sql"))
        .sort();
      // Apply twice: upgrading/restarting must not destroy existing structures.
      for (let run = 0; run < 2; run++)
        for (const name of migrations) {
          await db.query(
            await readFile(
              new URL(`../../../db/${name}`, import.meta.url),
              "utf8",
            ),
          );
        }
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
      databaseUrl.searchParams.set("options", `-csearch_path=${schema},public`);
      const env = {
        LOCAL_DATABASE_URL: databaseUrl.toString(),
        CARDANO_NETWORK: "cardano:preprod",
        FACILITATOR_URL: "https://facilitator.test",
        ADMIN_ALLOW_BEARER: "true",
        FRONTEND_ORIGIN: "https://shop.test",
        ADMIN_TOKEN: "a".repeat(64),
        GATEWAY_TOKEN: "b".repeat(64),
        SELLER_ADDRESS:
          "addr_test1qql5hvzueatjwcztktp2h005s7jyl4rs52w7cfdu7tpplkvjpmre5rzpp3qt2sj6hxnksl6spm8at2y4cc8mvflxw6xj7h76jm",
      };
      const req = (path, body, auth = env.ADMIN_TOKEN) =>
        app.request(
          `http://localhost${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              authorization: `Bearer ${auth}`,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          env,
        );
      assert.equal(
        (await req("/api/admin/orders", undefined, "wrong")).status,
        401,
      );
      const created = await req("/api/orders", {
        productId: "proof-token",
        name: "Recovery Customer",
        email: "recover@example.com",
        addressLine1: "Street 1",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      });
      assert.equal(created.status, 201);
      const order = await created.json();
      // A failing facilitator must not emit an opaque 500 before the wallet signs.
      globalThis.fetch = async () => Response.json({ error: "private upstream failure" }, { status: 500 });
      const unavailableOffer = await app.request(
        `http://localhost/api/orders/${order.id}/pay`,
        { method: "POST", headers: { "x-order-secret": order.access } }, env,
      );
      assert.equal(unavailableOffer.status, 503);
      assert.match((await unavailableOffer.json()).error, /No payment was requested/);
      // Minimal decodeable CBOR; the test facilitator supplies verification.
      const transaction = Buffer.from("84a3008001800200a0f5f6", "hex").toString(
        "base64",
      );
      const hash = decodeCardanoTransaction(transaction).txHash;
      let settlements = 0;
      globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith("/supported"))
          return Response.json({
            kinds: [
              {
                x402Version: 2,
                scheme: "exact",
                network: env.CARDANO_NETWORK,
                extra: {
                  assetTransferMethods: ["default"],
                  l1Confirmations: { minimum: 0, maximum: 20 },
                },
              },
            ],
            extensions: [],
            signers: {},
          });
        if (path.endsWith("/verify")) {
          // The hash must be linked and searchable before any submission occurs.
          const pending = await app.request(`http://localhost/api/orders/${order.id}`, {
            headers: { "x-order-secret": order.access },
          }, env);
          const pendingOrder = await pending.json();
          assert.equal(pendingOrder.signedTransaction, hash);
          assert.equal(pendingOrder.transaction, null);
          assert.equal(pendingOrder.status, "AWAITING_PAYMENT");
          const dashboard = await req(`/api/admin/orders?search=${hash}`);
          const matched = (await dashboard.json()).orders.find((item) => item.id === order.id);
          assert.ok(matched, "signed hash search finds the pending order");
          assert.equal(matched.signed_tx_hash, hash);
          assert.equal(matched.tx_hash, null);
          assert.equal(matched.signed_payload, undefined);
          assert.equal(settlements, 0);
          return Response.json({ isValid: true, payer: env.SELLER_ADDRESS });
        }
        if (path.endsWith("/settle")) {
          settlements++;
          await new Promise((r) => setTimeout(r, 100));
          return Response.json({
            success: true,
            transaction: hash,
            network: env.CARDANO_NETWORK,
            payer: env.SELLER_ADDRESS,
          });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      };
      const offer = await app.request(
        `http://localhost/api/orders/${order.id}/pay`,
        { method: "POST", headers: { "x-order-secret": order.access } },
        env,
      );
      assert.equal(offer.status, 402);
      const required = JSON.parse(
        Buffer.from(offer.headers.get("PAYMENT-REQUIRED"), "base64").toString(),
      );
      const payload = {
        x402Version: 2,
        resource: required.resource,
        accepted: required.accepts[0],
        payload: { transaction },
      };
      const signature = Buffer.from(JSON.stringify(payload)).toString("base64");
      const pay = () =>
        app.request(
          `http://localhost/api/orders/${order.id}/pay`,
          {
            method: "POST",
            headers: {
              "x-order-secret": order.access,
              "payment-signature": signature,
            },
          },
          env,
        );
      const results = await Promise.all(Array.from({ length: 30 }, pay));
      assert.ok(
        results.some((r) => r.status === 200),
        JSON.stringify(await Promise.all(results.map((r) => r.clone().text()))),
      );
      assert.ok(results.every((r) => [200, 409].includes(r.status)));
      assert.equal(
        settlements,
        1,
        "one facilitator settlement for concurrent copies",
      );
      assert.equal(
        (
          await db.query("SELECT status,country FROM orders WHERE id=$1", [
            order.id,
          ])
        ).rows[0].status,
        "PAID",
      );
      // Model receipt persisted but the order update was interrupted.
      await db.query(
        "UPDATE orders SET status='AWAITING_PAYMENT',tx_hash=NULL WHERE id=$1",
        [order.id],
      );
      globalThis.fetch = async () => {
        throw new Error("Facilitator offline: cached receipt must suffice");
      };
      const reconciled = await req(
        `/api/admin/orders/${order.id}/reconcile`,
        {},
      );
      assert.equal(reconciled.status, 200, await reconciled.clone().text());
      assert.equal(settlements, 1);
      // Operator settlement only links the original hash, requires explicit
      // confirmation/authentication, and is recorded once with an audit trail.
      await db.query("UPDATE orders SET status='AWAITING_PAYMENT',tx_hash=NULL WHERE id=$1", [order.id]);
      const publicPending = await (await req(`/api/transactions/${hash}`)).json();
      assert.equal(publicPending.paymentStatus, "UNCONFIRMED");
      assert.deepEqual(Object.keys(publicPending).sort(), ["chain", "network", "orderStatus", "paymentStatus", "transaction"]);
      const settlePath = `/api/admin/orders/${order.id}/settle`;
      const confirmation = { transaction: hash, confirmedOnChain: true };
      assert.equal((await req(settlePath, confirmation, "wrong")).status, 401);
      assert.equal((await req(settlePath, { transaction: hash })).status, 400);
      assert.equal((await req(settlePath, { transaction: "f".repeat(64), confirmedOnChain: true })).status, 409);
      await db.query("UPDATE payment_attempts SET lease_until=now()+interval '1 minute' WHERE order_id=$1", [order.id]);
      assert.equal((await req(settlePath, confirmation)).status, 409);
      await db.query("UPDATE payment_attempts SET lease_until=NULL WHERE order_id=$1", [order.id]);
      assert.equal((await req(settlePath, confirmation)).status, 200);
      assert.equal((await req(settlePath, confirmation)).status, 409);
      const publicSettled = await (await req(`/api/transactions/${hash.toUpperCase()}`)).json();
      assert.equal(publicSettled.paymentStatus, "SETTLED");
      assert.equal(publicSettled.orderStatus, "PAID");
      assert.equal((await req('/api/transactions/invalid')).status, 400);
      assert.equal((await req(`/api/transactions/${"e".repeat(64)}`)).status, 404);
      const manualEvents = (await db.query("SELECT details FROM order_events WHERE order_id=$1 AND kind='MANUAL_SETTLEMENT'", [order.id])).rows;
      assert.equal(manualEvents.length, 1);
      assert.equal(manualEvents[0].details.transaction, hash);
      // Public lookup reconciles independently of the facilitator, then returns
      // the updated status without duplicate events or repeated provider calls.
      await db.query("UPDATE orders SET status='AWAITING_PAYMENT',tx_hash=NULL WHERE id=$1", [order.id]);
      await db.query("UPDATE payment_attempts SET chain_check_after=NULL WHERE order_id=$1", [order.id]);
      env.BLOCKFROST_PREPROD_PROJECT_ID = 'test-chain-key';
      let chainCalls = 0;
      globalThis.fetch = async (url) => {
        chainCalls++;
        const path = new URL(url).pathname;
        if (path.endsWith('/utxos')) return Response.json({ hash, outputs: [{ address: env.SELLER_ADDRESS, amount: [{ unit: 'lovelace', quantity: '5000000' }] }] });
        if (path.endsWith(`/txs/${hash}`)) return Response.json({ hash, block: 'test-block', block_height: 100, valid_contract: true });
        if (path.endsWith('/blocks/100')) return Response.json({ hash: 'test-block', height: 100 });
        if (path.endsWith('/blocks/latest')) return Response.json({ height: 120 });
        throw new Error('Unexpected chain lookup');
      };
      const chainResult = await (await req(`/api/transactions/${hash}`)).json();
      assert.equal(chainResult.paymentStatus, 'SETTLED');
      assert.equal(chainResult.orderStatus, 'PAID');
      assert.equal(chainResult.chain.status, 'CONFIRMED');
      assert.equal(chainCalls, 4);
      await req(`/api/transactions/${hash}`);
      assert.equal(chainCalls, 4);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM order_events WHERE order_id=$1 AND kind='CHAIN_SETTLEMENT'", [order.id])).rows[0].count, 1);

      // The admin button checks the stored hash against the chain and reports
      // the result, independent of repeated facilitator 402 responses.
      await db.query("UPDATE orders SET status='AWAITING_PAYMENT',tx_hash=NULL WHERE id=$1", [order.id]);
      await db.query("UPDATE payment_attempts SET chain_check_after=NULL WHERE order_id=$1", [order.id]);
      const adminCheck = await req(`/api/admin/orders/${order.id}/reconcile`, {});
      assert.equal(adminCheck.status, 200);
      assert.deepEqual(
        (({ status, transaction, chain }) => ({ status, transaction, chain }))(await adminCheck.json()),
        { status: "PAID", transaction: hash, chain: "CONFIRMED" },
      );

      // A facilitator can keep returning 402 even after the signed transaction
      // reaches the chain. The normal payment retry must recover the order.
      await db.query("UPDATE orders SET status='AWAITING_PAYMENT',tx_hash=NULL WHERE id=$1", [order.id]);
      await db.query("UPDATE payment_attempts SET status='RECEIVED',receipt=NULL,chain_check_after=NULL WHERE order_id=$1", [order.id]);
      let pendingSettlements = 0;
      globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith("/supported")) return Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: env.CARDANO_NETWORK,
            extra: { assetTransferMethods: ["default"], l1Confirmations: { minimum: 0, maximum: 20 } } }],
          extensions: [], signers: {},
        });
        if (path.endsWith("/verify")) return Response.json({ isValid: true, payer: env.SELLER_ADDRESS });
        if (path.endsWith("/settle")) {
          pendingSettlements++;
          return Response.json({ success: false, errorReason: "settlement_pending", transaction: hash, network: env.CARDANO_NETWORK });
        }
        if (path.endsWith("/utxos")) return Response.json({ hash, outputs: [{ address: env.SELLER_ADDRESS, amount: [{ unit: "lovelace", quantity: "5000000" }] }] });
        if (path.endsWith(`/txs/${hash}`)) return Response.json({ hash, block: "test-block", block_height: 100, valid_contract: true });
        if (path.endsWith("/blocks/100")) return Response.json({ hash: "test-block", height: 100 });
        if (path.endsWith("/blocks/latest")) return Response.json({ height: 120 });
        throw new Error(`Unexpected fetch: ${path}`);
      };
      const directEvidence = await verifyOnChain(env, { id: order.id, network: env.CARDANO_NETWORK, price_lovelace: "5000000", signed_payload: signature, tx_hash: hash });
      assert.equal(directEvidence.status, "CONFIRMED", JSON.stringify(directEvidence));
      const recoveredFromPay = await pay();
      const attemptState = (await db.query("SELECT status,chain_check_after,receipt FROM payment_attempts WHERE order_id=$1", [order.id])).rows[0];
      assert.equal(recoveredFromPay.status, 200, JSON.stringify({ response: await recoveredFromPay.clone().text(), attemptState }));
      assert.equal((await recoveredFromPay.json()).transaction, hash);
      assert.ok(pendingSettlements >= 1);
      assert.equal((await db.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0].status, "PAID");
      assert.equal((await db.query("SELECT count(*)::int AS count FROM order_events WHERE order_id=$1 AND kind='CHAIN_SETTLEMENT'", [order.id])).rows[0].count, 3);

      await db.query(
        "UPDATE shop_settings SET gateway_last_seen=now(),printer_ready=true,printer_state='standby',available_batch_sizes=ARRAY[1,4] WHERE id=1",
      );
      const batch = (
        await (
          await req("/api/admin/print/start-next", {
            plateEmpty: true,
            expectedBatchId: null,
          })
        ).json()
      ).batch;
      assert.ok(batch.id);
      assert.equal(
        (
          await req(`/api/admin/print/start-next`, {
            plateEmpty: false,
            expectedBatchId: batch.id,
          })
        ).status,
        400,
      );
      for (const status of ["DISPATCHING", "PRINTING", "PRINTED"])
        assert.equal(
          (
            await req(
              `/api/gateway/batches/${batch.id}/status`,
              { status },
              env.GATEWAY_TOKEN,
            )
          ).status,
          200,
        );
      const shipping = await (await req("/api/admin/shipping")).json();
      assert.equal(shipping.orders[0].country, "DE");
      assert.equal(shipping.orders[0].email, "recover@example.com");
      assert.equal(
        (
          await req(`/api/admin/orders/${order.id}/status`, {
            status: "SHIPPED",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await req(`/api/admin/orders/${order.id}/status`, {
            status: "NEEDS_REVIEW",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await req(`/api/admin/orders/${order.id}/requeue`, {
            confirmedPhysicalReview: true,
          })
        ).status,
        200,
      );
      const confirmed = await req(`/api/admin/print/start-next`, {
        plateEmpty: true,
        expectedBatchId: batch.id,
      });
      assert.equal(confirmed.status, 200);
      const next = (await confirmed.json()).batch;
      assert.notEqual(next.id, batch.id);
      const found = await (
        await req("/api/admin/orders?search=recover%40example.com")
      ).json();
      assert.equal(found.orders[0].id, order.id);
      assert.equal(found.totals.BATCHED, 1);
      assert.equal(
        (
          await req(
            `/api/gateway/batches/${batch.id}/status`,
            { status: "PRINTING" },
            env.GATEWAY_TOKEN,
          )
        ).status,
        409,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await closeLocalPool();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  },
);
