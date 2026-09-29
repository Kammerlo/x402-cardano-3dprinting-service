import { decodePaymentSignatureHeader } from "@x402/core/http";
import { decodeCardanoTransaction, normalizeConfirmationPolicy } from "@x402/cardano";
import type { Env } from "./domain";
import { query } from "./db";

export type ChainOrder = { id: string; network: string; price_lovelace: string; signed_payload: string; tx_hash: string };
type ChainDiagnostic = { stage: string; reason: string; httpStatus?: number };
export type ChainEvidence = { status: "CONFIRMED" | "CONFIRMING" | "NOT_FOUND" | "MISMATCH" | "UNAVAILABLE" | "NOT_CONFIGURED"; confirmations?: number; requiredConfirmations?: number; checkedAt?: string; diagnostic?: ChainDiagnostic };

class ChainCheckError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: "http_error" | "invalid_json" | "request_failed",
    readonly httpStatus?: number,
  ) { super(reason); }
}

// Check trusted structured chain data, never HTML/explorer availability.
export async function verifyOnChain(env: Env, order: ChainOrder): Promise<ChainEvidence> {
  const preprod = order.network === "cardano:preprod";
  if (!preprod && order.network !== "cardano:mainnet") return { status: "MISMATCH" };
  const key = preprod ? env.BLOCKFROST_PREPROD_PROJECT_ID : env.BLOCKFROST_MAINNET_PROJECT_ID;
  if (!key) return { status: "NOT_CONFIGURED" };
  let stage = "signed_payment";
  try {
    const payment = decodePaymentSignatureHeader(order.signed_payload);
    const accepted = payment.accepted;
    const policy = normalizeConfirmationPolicy(accepted.extra?.confirmationPolicy);
    if (!policy || accepted.scheme !== "exact" || accepted.network !== order.network ||
      accepted.asset !== "lovelace" || accepted.amount !== order.price_lovelace ||
      accepted.payTo !== env.SELLER_ADDRESS ||
      (accepted.extra?.assetTransferMethod && accepted.extra.assetTransferMethod !== "default") ||
      decodeCardanoTransaction(String(payment.payload.transaction)).txHash !== order.tx_hash)
      return { status: "MISMATCH" };
    const base = `https://cardano-${preprod ? "preprod" : "mainnet"}.blockfrost.io/api/v0`;
    const signal = AbortSignal.timeout(12_000);
    const get = async (path: string, requestStage: string) => {
      let response: Response;
      try {
        // workerd rejects redirect: "error" before sending the request. Manual
        // mode keeps the project ID from being forwarded to a redirect target.
        response = await fetch(base + path, { headers: { project_id: key }, signal, redirect: "manual" });
      } catch {
        throw new ChainCheckError(requestStage, "request_failed");
      }
      if (response.status === 404) return null;
      // Do not follow redirects carrying the Blockfrost project ID.
      if (response.status >= 300 && response.status < 400)
        throw new ChainCheckError(requestStage, "http_error", response.status);
      if (!response.ok) throw new ChainCheckError(requestStage, "http_error", response.status);
      try {
        return await response.json();
      } catch {
        throw new ChainCheckError(requestStage, "invalid_json", response.status);
      }
    };
    const tx = await get(`/txs/${order.tx_hash}`, "transaction");
    if (!tx) return { status: "NOT_FOUND" };
    if (tx.hash !== order.tx_hash || tx.valid_contract !== true || !Number.isSafeInteger(tx.block_height) || tx.block_height < 0)
      return { status: "MISMATCH" };
    stage = "chain_data";
    const [utxos, block, tip] = await Promise.all([
      get(`/txs/${order.tx_hash}/utxos`, "transaction_utxos"),
      get(`/blocks/${tx.block_height}`, "transaction_block"),
      get('/blocks/latest', "chain_tip"),
    ]);
    if (!utxos || !block || !tip) {
      const diagnostic = {
        stage: !utxos ? "transaction_utxos" : !block ? "transaction_block" : "chain_tip",
        reason: "not_found",
      };
      console.error("chain check unavailable", {
        orderId: order.id, network: order.network,
        ...diagnostic,
      });
      return { status: "UNAVAILABLE", diagnostic };
    }
    stage = "chain_data_validation";
    if (utxos.hash !== order.tx_hash || block.hash !== tx.block || block.height !== tx.block_height || !Number.isSafeInteger(tip.height) || tip.height < block.height)
      return { status: "MISMATCH" };
    if (!Array.isArray(utxos.outputs)) return { status: "MISMATCH" };
    const received = utxos.outputs.filter((output: any) => output.address === accepted.payTo && !output.collateral)
      .reduce((sum: bigint, output: any) => sum + output.amount.filter((amount: any) => amount.unit === 'lovelace')
        .reduce((value: bigint, amount: any) => value + BigInt(amount.quantity), 0n), 0n);
    if (received < BigInt(order.price_lovelace)) return { status: "MISMATCH" };
    // x402 counts newer canonical blocks, with inclusion itself at depth zero.
    const confirmations = tip.height - block.height;
    const requiredConfirmations = Math.max(1, policy.l1Confirmations);
    return { status: confirmations >= requiredConfirmations ? "CONFIRMED" : "CONFIRMING", confirmations, requiredConfirmations };
  } catch (cause) {
    // Never log the provider key, signed payload, raw upstream body or error message.
    const diagnostic = {
      stage: cause instanceof ChainCheckError ? cause.stage : stage,
      reason: cause instanceof ChainCheckError ? cause.reason : "unexpected_error",
      ...(cause instanceof ChainCheckError && cause.httpStatus !== undefined
        ? { httpStatus: cause.httpStatus } : {}),
    };
    console.error("chain check unavailable", {
      orderId: order.id, network: order.network,
      ...diagnostic,
    });
    return { status: "UNAVAILABLE", diagnostic };
  }
}

export type RecordedPaymentOrder = { id: string; network: string; price_lovelace: string };

/**
 * Reconcile one stored, signed payment from structured chain evidence.
 * The timestamp claim bounds Blockfrost calls across Worker instances.
 */
export async function reconcileRecordedPayment(
  env: Env,
  order: RecordedPaymentOrder,
  hash: string,
): Promise<ChainEvidence | { status: "CHECK_AGAIN" }> {
  const [attempt] = await query<{ signed_payload: string }>(
    env,
    `UPDATE payment_attempts SET chain_check_after=now()+interval '15 seconds'
     WHERE order_id=$1 AND tx_hash=$2 AND signed_payload IS NOT NULL
       AND (chain_check_after IS NULL OR chain_check_after<now())
     RETURNING signed_payload`,
    [order.id, hash],
  );
  if (!attempt) {
    const [cached] = await query<{
      chain_status: ChainEvidence["status"] | null;
      chain_confirmations: number | null;
      chain_required_confirmations: number | null;
      chain_checked_at: string | null;
    }>(
      env,
      "SELECT chain_status,chain_confirmations,chain_required_confirmations,chain_checked_at FROM payment_attempts WHERE order_id=$1 AND tx_hash=$2",
      [order.id, hash],
    );
    if (cached?.chain_status && cached.chain_checked_at) {
      return {
        status: cached.chain_status,
        checkedAt: cached.chain_checked_at,
        ...(cached.chain_confirmations !== null ? { confirmations: cached.chain_confirmations } : {}),
        ...(cached.chain_required_confirmations !== null ? { requiredConfirmations: cached.chain_required_confirmations } : {}),
      };
    }
    return { status: "CHECK_AGAIN" };
  }
  const chain = await verifyOnChain(env, { ...order, tx_hash: hash, signed_payload: attempt.signed_payload });
  const [recorded] = await query<{ chain_checked_at: string }>(
    env,
    `UPDATE payment_attempts
     SET chain_status=$3,chain_confirmations=$4,chain_required_confirmations=$5,chain_checked_at=now()
     WHERE order_id=$1 AND tx_hash=$2 RETURNING chain_checked_at`,
    [order.id, hash, chain.status, chain.confirmations ?? null, chain.requiredConfirmations ?? null],
  );
  chain.checkedAt = recorded?.chain_checked_at;
  if (chain.status === "CONFIRMED") {
    await query(
      env,
      `WITH paid AS (
        UPDATE orders SET status='PAID',tx_hash=$2,paid_at=now(),updated_at=now()
        WHERE id=$1 AND status='AWAITING_PAYMENT' AND tx_hash IS NULL RETURNING id
      ), attempt AS (
        UPDATE payment_attempts SET status='SETTLED'
        WHERE order_id IN (SELECT id FROM paid) AND tx_hash=$2 RETURNING id
      ), event AS (
        INSERT INTO order_events(order_id,kind,details)
        SELECT id,'CHAIN_SETTLEMENT',jsonb_build_object('transaction',$2::text,'source','blockfrost','confirmations',$3::int)
        FROM paid RETURNING id
      ) SELECT id FROM paid`,
      [order.id, hash, chain.confirmations],
    );
  }
  return chain;
}
