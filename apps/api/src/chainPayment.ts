import { decodePaymentSignatureHeader } from "@x402/core/http";
import { decodeCardanoTransaction, normalizeConfirmationPolicy } from "@x402/cardano";
import type { Env } from "./domain";

export type ChainOrder = { id: string; network: string; price_lovelace: string; signed_payload: string; tx_hash: string };
export type ChainEvidence = { status: "CONFIRMED" | "CONFIRMING" | "NOT_FOUND" | "MISMATCH" | "UNAVAILABLE" | "NOT_CONFIGURED"; confirmations?: number; requiredConfirmations?: number };

// Check trusted structured chain data, never HTML/explorer availability.
export async function verifyOnChain(env: Env, order: ChainOrder): Promise<ChainEvidence> {
  const preprod = order.network === "cardano:preprod";
  if (!preprod && order.network !== "cardano:mainnet") return { status: "MISMATCH" };
  const key = preprod ? env.BLOCKFROST_PREPROD_PROJECT_ID : env.BLOCKFROST_MAINNET_PROJECT_ID;
  if (!key) return { status: "NOT_CONFIGURED" };
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
    const get = async (path: string) => {
      const response = await fetch(base + path, { headers: { project_id: key }, signal, redirect: "error" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Chain provider unavailable");
      return response.json();
    };
    const tx = await get(`/txs/${order.tx_hash}`);
    if (!tx) return { status: "NOT_FOUND" };
    if (tx.hash !== order.tx_hash || tx.valid_contract !== true || !Number.isSafeInteger(tx.block_height) || tx.block_height < 0)
      return { status: "MISMATCH" };
    const [utxos, block, tip] = await Promise.all([
      get(`/txs/${order.tx_hash}/utxos`), get(`/blocks/${tx.block_height}`), get('/blocks/latest'),
    ]);
    if (!utxos || !block || !tip) return { status: "UNAVAILABLE" };
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
  } catch { return { status: "UNAVAILABLE" }; }
}
