import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import app from "../src/index.ts";
import { closeLocalPool } from "../src/db.ts";

test(
  "admin sessions, CSRF, revocation, login throttling and dynamic supervised starts",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `admin_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}",public`);
      for (const file of (
        await readdir(new URL("../../../db/", import.meta.url))
      )
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await db.query(
          await readFile(
            new URL(`../../../db/${file}`, import.meta.url),
            "utf8",
          ),
        );
      const url = new URL(process.env.TEST_DATABASE_URL);
      url.searchParams.set("options", `-csearch_path=${schema},public`);
      const env = {
        LOCAL_DATABASE_URL: url.toString(),
        ADMIN_TOKEN: "a".repeat(64),
        GATEWAY_TOKEN: "b".repeat(64),
        FRONTEND_ORIGIN: "https://shop.test",
      };
      let cookie = "",
        csrf = "";
      const req = (path, body, headers = {}) =>
        app.request(
          `https://shop.test${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: env.FRONTEND_ORIGIN,
              "content-type": "application/json",
              cookie,
              "x-csrf-token": csrf,
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          env,
        );
      for (const path of [
        "/api/admin/orders",
        "/api/admin/shipping",
        "/api/admin/auth/session",
      ])
        assert.equal((await req(path)).status, 401);
      assert.equal(
        (
          await req(
            "/api/admin/print/start-next",
            { plateEmpty: true, expectedBatchId: null },
            { authorization: `Bearer ${env.ADMIN_TOKEN}` },
          )
        ).status,
        401,
        "long-lived bearer access disabled",
      );
      assert.equal(
        (
          await req(
            "/api/admin/auth/login",
            { token: env.ADMIN_TOKEN },
            { origin: "https://evil.test" },
          )
        ).status,
        403,
      );
      assert.equal(
        (await req("/api/admin/auth/login", { token: "wrong" })).status,
        401,
      );
      async function login() {
        const r = await req("/api/admin/auth/login", {
          token: env.ADMIN_TOKEN,
        });
        assert.equal(r.status, 200, await r.clone().text());
        const set = r.headers.get("set-cookie");
        assert.match(set, /HttpOnly/i);
        assert.match(set, /Secure/i);
        assert.match(set, /SameSite=Strict/i);
        assert.match(set, /__Host-print-admin=/);
        cookie = set.split(";")[0];
        csrf = (await r.json()).csrf;
      }
      await login();
      assert.equal((await req("/api/admin/orders")).status, 200);
      assert.equal(
        (
          await req(
            "/api/admin/pause",
            { paused: true },
            { "x-csrf-token": "" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await req(
            "/api/admin/pause",
            { paused: true },
            { origin: "https://evil.test" },
          )
        ).status,
        403,
      );
      assert.equal(
        (await req("/api/admin/pause", { paused: true })).status,
        200,
      );
      assert.equal((await req("/api/admin/batches", {})).status, 410);
      const start = (expected = null, plateEmpty = true) =>
        req("/api/admin/print/start-next", {
          plateEmpty,
          expectedBatchId: expected,
        });
      assert.equal((await start(null, false)).status, 400);
      assert.equal((await start()).status, 409, "offline start rejected");
      for (let i = 0; i < 11; i++)
        await db.query(
          `INSERT INTO orders(id,access_hash,customer_name,email,address_line1,postal_code,city,price_lovelace,network,status,tx_hash,paid_at) VALUES($1,'hash','Customer','test@example.com','Street','10115','Berlin',5000000,'cardano:preprod','PAID',$2,now())`,
          [randomUUID(), i.toString(16).padStart(64, "0")],
        );
      const heartbeat = () =>
        db.query(
          "UPDATE shop_settings SET gateway_last_seen=now(),printer_ready=true,printer_state='standby',available_batch_sizes=ARRAY[1,3,6],gateway_active=false WHERE id=1",
        );
      await heartbeat();
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => start()),
      );
      assert.equal(responses.filter((r) => r.status === 200).length, 1);
      assert.ok(responses.every((r) => [200, 409].includes(r.status)));
      const first = (await responses.find((r) => r.status === 200).json())
        .batch;
      assert.equal(first.size, 6, "dynamic batch greater than four");
      const gateway = (path, body) =>
        req(path, body, { authorization: `Bearer ${env.GATEWAY_TOKEN}` });
      await db.query(
        "UPDATE print_batches SET start_authorized_until=now()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      assert.equal(
        (await (await gateway("/api/gateway/next")).json()).batch,
        null,
        "expired authorization is not dispatched",
      );
      assert.equal(
        (
          await gateway(`/api/gateway/batches/${first.id}/status`, {
            status: "DISPATCHING",
          })
        ).status,
        409,
      );
      assert.equal(
        (await start(first.id)).status,
        200,
        "explicit retry reauthorizes same queued batch",
      );
      assert.equal(
        (
          await gateway(`/api/gateway/batches/${first.id}/status`, {
            status: "DISPATCHING",
          })
        ).status,
        200,
      );
      assert.equal(
        (await start(first.id)).status,
        409,
        "running plate cannot be bypassed even if heartbeat is stale-idle",
      );
      assert.equal(
        (
          await gateway(`/api/gateway/batches/${first.id}/status`, {
            status: "PRINTING",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await gateway(`/api/gateway/batches/${first.id}/status`, {
            status: "PRINTED",
          })
        ).status,
        200,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM print_batches")).rows[0].n,
        1,
        "completion alone never advances queue",
      );
      await heartbeat();
      const second = (await (await start(first.id)).json()).batch;
      assert.equal(
        second.size,
        3,
        "largest available file fitting remaining five",
      );
      assert.equal(
        (await start(first.id)).status,
        409,
        "stale browser cannot advance a different plate",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM orders WHERE status='PAID'",
          )
        ).rows[0].n,
        2,
      );
      const audits = (await db.query("SELECT * FROM admin_audit")).rows;
      assert.ok(
        audits.some(
          (x) =>
            x.action === "/api/admin/print/start-next" &&
            x.response_status === 200,
        ),
      );
      assert.ok(!JSON.stringify(audits).includes(env.ADMIN_TOKEN));
      const oldCookie = cookie;
      assert.equal((await req("/api/admin/auth/logout", {})).status, 200);
      assert.equal(
        (await req("/api/admin/orders", undefined, { cookie: oldCookie }))
          .status,
        401,
      );
      await login();
      const secondCookie = cookie;
      await login();
      assert.equal((await req("/api/admin/auth/revoke-all", {})).status, 200);
      assert.equal(
        (await req("/api/admin/orders", undefined, { cookie: secondCookie }))
          .status,
        401,
      );
      await login();
      env.ADMIN_TOKEN = "c".repeat(64);
      assert.equal(
        (await req("/api/admin/orders")).status,
        401,
        "key rotation invalidates old sessions",
      );
      await login();
      await db.query(
        "UPDATE admin_sessions SET expires_at=now()-interval '1 second'",
      );
      assert.equal(
        (await req("/api/admin/orders")).status,
        401,
        "expired sessions rejected",
      );
      for (let i = 0; i < 21; i++)
        await req("/api/admin/auth/login", { token: "wrong" });
      assert.equal(
        (await req("/api/admin/auth/login", { token: env.ADMIN_TOKEN })).status,
        429,
      );
    } finally {
      await closeLocalPool();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  },
);
