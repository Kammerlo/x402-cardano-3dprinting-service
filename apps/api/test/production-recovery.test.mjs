import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { decodeCardanoTransaction } from "@x402/cardano";
import app from "../src/index.ts";
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
        if (path.endsWith("/verify"))
          return Response.json({ isValid: true, payer: env.SELLER_ADDRESS });
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
      const batch = (await (await req("/api/admin/batches", {})).json()).batch;
      assert.ok(batch.id);
      assert.equal(
        (
          await req(`/api/admin/batches/${batch.id}/confirm`, {
            inspected: true,
          })
        ).status,
        409,
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
      const confirmed = await req(`/api/admin/batches/${batch.id}/confirm`, {
        inspected: true,
      });
      assert.equal(confirmed.status, 200);
      const next = (await confirmed.json()).nextBatch;
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
