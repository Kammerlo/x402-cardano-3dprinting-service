import type { Context } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { decodeCardanoTransaction } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { query } from "./db";
import { reconcileRecordedPayment } from "./chainPayment";
import {
  SOLD_ORDERS_SQL,
  capGuardParams,
  orderCapFor,
  soldOrders,
} from "./orderCap";
import { paymentWindowHours } from "./privacy";
import {
  type Env,
  type Order,
  networkFor,
  sellerIsValid,
  error,
} from "./domain";

type RecoveryResult = { response: Response | null; chainStatus: string };

async function recoverOnChain(
  env: Env,
  order: Order,
  id: string,
  signedHash: string,
): Promise<RecoveryResult> {
  try {
    const chain = await reconcileRecordedPayment(env, order, signedHash);
    if (chain.status === "CONFIRMED") {
      const [current] = await query<{ status: string; tx_hash: string | null }>(
        env, "SELECT status,tx_hash FROM orders WHERE id=$1", [id],
      );
      if (current?.tx_hash?.toLowerCase() === signedHash.toLowerCase()) {
        // Never carry an earlier 402 error receipt into a successful recovery.
        return {
          chainStatus: chain.status,
          response: new Response(
            JSON.stringify({ id, status: current.status, transaction: signedHash }),
            { headers: { "content-type": "application/json", "cache-control": "no-store" } },
          ),
        };
      }
    }
    return { response: null, chainStatus: chain.status };
  } catch (cause) {
    console.error("on-chain payment reconciliation failed", id, cause);
    return { response: null, chainStatus: "UNAVAILABLE" };
  }
}

type Refusal = "SOLD_OUT" | "ORDER_CLOSED";

// Only for outcomes proven to precede any broadcast: the browser treats this
// header as final and releases the signed payment it kept for recovery.
function refused(reason: Refusal, signed: boolean) {
  const response = error(
    (reason === "SOLD_OUT"
      ? "All demo prints are claimed."
      : "This order is closed and can no longer be paid.") +
      (signed
        ? " Your signed transaction was not submitted. No payment was taken."
        : " No payment was requested."),
    409,
  );
  response.headers.set("X-Payment-Refused", reason);
  return response;
}

function withChainStatus(response: Response, status: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Payment-Chain-Status", status);
  return new Response(response.body, { status: response.status, headers });
}

export async function processPayment(
  c: Context<{ Bindings: Env }>,
  env: Env,
  id: string,
  o: Order,
  signature?: string,
) {
  const network = networkFor(env);
  if (
    !network ||
    network !== o.network ||
    !env.FACILITATOR_URL ||
    !sellerIsValid(env, network)
  )
    return error("Payment configuration changed; contact the operator", 503);
  const cap = orderCapFor(env),
    windowHours = paymentWindowHours(env);
  // Refuse new offers before the wallet is asked to sign anything. An order
  // that already holds a signed transaction keeps today's behaviour, so its
  // customer is never told "no payment" while that transaction may be on-chain.
  if (!signature && !o.signed_tx_hash) {
    if (cap.kind === "invalid")
      return error("The order limit is misconfigured. No payment was requested; contact the operator.", 503);
    if (
      o.personal_data_erased_at ||
      Date.now() - new Date(o.created_at).getTime() > windowHours * 3_600_000
    )
      return refused("ORDER_CLOSED", false);
    if (cap.kind === "cap" && (await soldOrders(env)) >= cap.n)
      return refused("SOLD_OUT", false);
  }
  let signedHash: string | undefined;
  if (signature) {
    if (signature.length > 64_000)
      return error("Payment payload too large", 413);
    try {
      const payload = decodePaymentSignatureHeader(signature);
      if (
        payload.accepted.network !== network ||
        payload.accepted.payTo !== env.SELLER_ADDRESS ||
        payload.accepted.amount !== o.price_lovelace ||
        payload.accepted.asset !== "lovelace"
      )
        return error("Signed payment does not match the order", 400);
      signedHash = decodeCardanoTransaction(
        String(payload.payload.transaction),
      ).txHash;
      if (!/^[0-9a-f]{64}$/i.test(signedHash))
        return error("Invalid signed transaction", 400);
    } catch {
      return error("Invalid payment signature", 400);
    }
    // Reserve exactly one signed transaction for this order before the facilitator can broadcast.
    // The order cap and erasure only block *new* reservations; an existing
    // reservation always proceeds because it may already be on-chain.
    // The order row is locked unconditionally, so a concurrent reservation of
    // the same order commits before the checks below run and is seen by them.
    // The lock does NOT protect against erasure: payments close windowHours
    // after creation, 12 hours before an unpaid order becomes eligible for
    // erasure, and that time gap alone keeps the two from overlapping.
    const guard = capGuardParams(cap);
    await query(
      env,
      `WITH locked AS (
        SELECT id,personal_data_erased_at,created_at FROM orders WHERE id=$2 FOR UPDATE
      )
      INSERT INTO payment_attempts(id,order_id,tx_hash,signed_payload)
      SELECT $1,locked.id,$3,$4 FROM locked
      -- One CASE over the locked row: plain AND-ed parameter checks would be
      -- hoisted into a one-time filter and skip the lock when they are false.
      WHERE CASE WHEN locked.personal_data_erased_at IS NOT NULL
          OR locked.created_at <= now()-make_interval(hours => $7::int) THEN false
        ELSE NOT $6::boolean AND ($5::int = 0 OR ${SOLD_ORDERS_SQL} < $5::int) END
      ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), id, signedHash, signature, guard.limit, guard.closed, windowHours],
    );
    const attempts = await query<{ tx_hash: string }>(
      env,
      "SELECT tx_hash FROM payment_attempts WHERE order_id=$1",
      [id],
    );
    if (!attempts.length) {
      const reason = await refusalFor(env, id, signedHash, guard, windowHours);
      if (reason) {
        await query(
          env,
          "INSERT INTO order_events(order_id,kind,details) VALUES($1,$2,jsonb_build_object('transaction',$3::text))",
          [id, reason === "SOLD_OUT" ? "SOLD_OUT_REFUSED" : "CLOSED_ORDER_REFUSED", signedHash],
        ).catch((e) => console.error("refusal event failed", id, e));
        return refused(reason, true);
      }
    }
    if (attempts.length !== 1 || attempts[0].tx_hash !== signedHash)
      return error(
        "Another signed payment is already attached to this order; reconcile it first",
        409,
      );
  }
  const lease = crypto.randomUUID();
  let cachedReceipt: string | null = null;
  if (signedHash) {
    const claimed = await query<{ receipt: string | null }>(
      env,
      `UPDATE payment_attempts
      SET lease_token=$2,lease_until=now()+interval '15 minutes'
      WHERE order_id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING receipt`,
      [id, lease],
    );
    if (!claimed.length) {
      // Another request may be waiting on the facilitator after broadcast.
      // Reconcile independently if the signed transaction is already final.
      const recovery = await recoverOnChain(env, o, id, signedHash);
      if (recovery.response) { c.res = recovery.response; return c.res; }
      return withChainStatus(
        error("Payment reconciliation is already running; retry the same payment shortly", 409),
        recovery.chainStatus,
      );
    }
    cachedReceipt = claimed[0].receipt;
  }
  try {
    if (!cachedReceipt) {
      const server = new x402ResourceServer(
        new HTTPFacilitatorClient({ url: env.FACILITATOR_URL }),
      ).register(network, new ExactCardanoScheme());
      const middleware = paymentMiddleware(
        {
          [`POST ${c.req.path}`]: {
            accepts: {
              scheme: "exact",
              network,
              price: { asset: "lovelace", amount: o.price_lovelace },
              payTo: env.SELLER_ADDRESS,
            },
            description: `One Proof of Print, order ${id}`,
          },
        },
        server,
      );
      // The handler prepares a response; x402 buffers it and settles before exposing it.
      try {
        const immediate = await middleware(c, async () => {
          c.res = c.json({ id, status: "PAID" });
        });
        if (immediate instanceof Response) c.res = immediate;
      } catch (cause) {
        // Do not echo facilitator responses or URLs, which may contain credentials.
        console.error("x402 middleware failed", {
          orderId: id, network, stage: signedHash ? "confirmation" : "offer",
          errorType: cause instanceof Error ? cause.name : typeof cause,
        });
        c.res = error(
          signedHash
            ? "Payment confirmation is temporarily unavailable. Keep this order and check the same transaction again."
            : "The payment service cannot issue an offer right now. No payment was requested. Keep this order and retry later.",
          503,
        );
        return c.res;
      }
      if (!signedHash && c.res.status >= 500) {
        console.error("x402 offer returned an error", { orderId: id, network, status: c.res.status });
        c.res = error("The payment service cannot issue an offer right now. No payment was requested. Keep this order and retry later.", 503);
        return c.res;
      }
      cachedReceipt = c.res.headers.get("PAYMENT-RESPONSE");
      if (!c.res.ok || !cachedReceipt) {
        // A 402 after signing can mean that the facilitator broadcast the
        // transaction but has not observed enough confirmations yet. Check the
        // stored transaction against the chain before asking the browser to wait.
        if (signedHash) {
          const recovery = await recoverOnChain(env, o, id, signedHash);
          if (recovery.response) { c.res = recovery.response; return c.res; }
          c.res = withChainStatus(c.res, recovery.chainStatus);
        }
        return c.res;
      }
    }
    const receiptHeader = cachedReceipt;

    const receipt = decodePaymentResponseHeader(receiptHeader);
    if (
      !receipt.success ||
      receipt.network !== network ||
      !/^[0-9a-f]{64}$/i.test(receipt.transaction) ||
      !signedHash ||
      receipt.transaction.toLowerCase() !== signedHash.toLowerCase()
    )
      return error("Invalid settlement receipt", 502);
    // Persist the verified receipt separately so a failed order update is recoverable
    // without relying on the facilitator accepting an already-spent transaction.
    await query(
      env,
      "UPDATE payment_attempts SET receipt=$2 WHERE order_id=$1 AND lease_token=$3",
      [id, receiptHeader, lease],
    );
    try {
      const rows = await query<{ id: string }>(
        env,
        `WITH paid AS (
      UPDATE orders SET status='PAID', tx_hash=$2, paid_at=now(), updated_at=now()
      WHERE id=$1 AND status='AWAITING_PAYMENT' RETURNING id
    ), attempt AS (UPDATE payment_attempts SET status='SETTLED' WHERE order_id=$1 AND tx_hash=$2 RETURNING id), event AS (INSERT INTO order_events(order_id,kind,details) SELECT id,'PAID',jsonb_build_object('transaction',$2::text) FROM paid RETURNING id)
    SELECT id FROM paid`,
        [id, receipt.transaction],
      );
      if (!rows.length) {
        const current = (
          await query<Order>(env, "SELECT * FROM orders WHERE id=$1", [id])
        )[0];
        if (current?.tx_hash !== receipt.transaction)
          return error("Order already settled with another payment", 409);
      }
      c.header("PAYMENT-RESPONSE", receiptHeader);
      return c.json({ id, status: "PAID", transaction: receipt.transaction });
    } catch (e) {
      console.error("settled order persistence failed", id, e);
      c.header("PAYMENT-RESPONSE", receiptHeader);
      return c.json(
        {
          error:
            "Payment settled; retry the same signed transaction to reconcile",
        },
        503,
      );
    }
  } finally {
    if (signedHash)
      await query(
        env,
        "UPDATE payment_attempts SET lease_until=NULL,lease_token=NULL WHERE order_id=$1 AND lease_token=$2",
        [id, lease],
      );
  }
}

// A missing reservation is a refusal only when this transaction is reserved
// nowhere: a hash held by another order may already be broadcast.
async function refusalFor(
  env: Env,
  id: string,
  signedHash: string,
  guard: { limit: number; closed: boolean },
  windowHours: number,
): Promise<Refusal | null> {
  const [state] = await query<{ elsewhere: boolean; erased: boolean; sold_out: boolean }>(
    env,
    `SELECT EXISTS (SELECT 1 FROM payment_attempts WHERE tx_hash=$2) AS elsewhere,
      EXISTS (SELECT 1 FROM orders WHERE id=$1 AND (personal_data_erased_at IS NOT NULL
        OR created_at <= now()-make_interval(hours => $5::int))) AS erased,
      ($4::boolean OR ($3::int <> 0 AND ${SOLD_ORDERS_SQL} >= $3::int)) AS sold_out`,
    [id, signedHash, guard.limit, guard.closed, windowHours],
  );
  if (!state || state.elsewhere) return null;
  if (state.erased) return "ORDER_CLOSED";
  return state.sold_out ? "SOLD_OUT" : null;
}
