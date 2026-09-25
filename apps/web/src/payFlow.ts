/**
 * The browser payment loop: request, receive 402, build and sign, retry
 * with the payment header, settle. x402 owns the payloads and headers.
 *
 * Adapted from the x402-cardano-demo frontend (cardano-foundation/x402-cardano-demo,
 * frontend/src/x402/flow.ts), generalized to one URL. The safety rules
 * survive intact: after signing, a transport failure never authorizes a
 * second payment (the same signed payment is checked again), and a receipt
 * is only trusted when it matches the transaction that was signed.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { decodeCardanoTransaction, type ClientCardanoSigner } from "@x402/cardano";

export type FlowStep =
  | { id: "request"; title: string }
  | { id: "offer"; title: string; detail: unknown }
  | { id: "signed"; title: string; detail: { nonce: string } }
  | { id: "pay"; title: string }
  | { id: "settled"; title: string; detail: unknown };

export interface PreparedPayment {
  url: string;
  headers: Record<string, string>;
  payload: PaymentPayload;
}

export type FlowOutcome =
  | { status: "settled"; body: unknown; receipt: unknown }
  | { status: "failed"; message: string }
  | { status: "pending"; message: string; transaction: string }
  | { status: "unknown"; message: string; transaction?: string };

export interface FlowOptions {
  network: "cardano:mainnet" | "cardano:preprod";
  payTo: string;
  asset?: string;
  maxAmount?: string;
  automaticChecks?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
  onPrepared?: (payment: PreparedPayment) => void;
}

export async function runPaymentFlow(
  url: string,
  signer: ClientCardanoSigner,
  onStep: (step: FlowStep) => void,
  options: FlowOptions,
): Promise<FlowOutcome> {
  const asset = options.asset ?? "lovelace";
  const first = await fetch(url, { method: "POST", headers: options.headers, signal: AbortSignal.timeout(15_000) });
  onStep({ id: "request", title: `Requested the resource (HTTP ${first.status})` });
  if (first.status !== 402) throw new Error(`Expected a payment offer, received HTTP ${first.status}.`);

  const http = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: options.network, client: new ExactCardanoScheme(signer) }],
      spendControls: {
        allowedAssets: [
          {
            network: options.network,
            asset,
            maxAmountPerPayment: options.maxAmount ?? "5000000",
          },
        ],
      },
    }),
  );

  const required = http.getPaymentRequiredResponse(name => first.headers.get(name));
  onStep({ id: "offer", title: "Read the payment offer", detail: required });
  if (required.accepts.length !== 1 || !required.accepts.some(offer => offer.network === options.network && offer.amount === (options.maxAmount ?? "5000000") && offer.payTo === options.payTo && offer.asset === asset)) {
    throw new Error("Payment offer differs from the order price, network or receiving address. Nothing was signed.");
  }
  const payload = await http.createPaymentPayload(required);
  if (payload.accepted.network !== options.network || payload.accepted.amount !== (options.maxAmount ?? "5000000") || payload.accepted.payTo !== options.payTo || payload.accepted.asset !== asset) {
    throw new Error("Signed payment differs from the checked offer. It was not submitted.");
  }
  onStep({ id: "signed", title: "Wallet signed the transaction", detail: { nonce: String(payload.payload.nonce) } });

  const payment: PreparedPayment = {
    url,
    payload,
    headers: { ...options.headers, ...http.encodePaymentSignatureHeader(payload) },
  };

  options.onPrepared?.(payment);
  const limit = Math.min(5, Math.max(0, Math.trunc(options.automaticChecks ?? 3)));
  let outcome = await sendPayment(payment, onStep, false);
  let checks = 0;
  while ((outcome.status === "pending" || outcome.status === "unknown") && checks < limit) {
    await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 5_000));
    checks++;
    outcome = await sendPayment(payment, onStep, true);
  }
  return outcome;
}

export async function resumePaymentFlow(payment: PreparedPayment, onStep: (step: FlowStep) => void): Promise<FlowOutcome> {
  return sendPayment(payment, onStep, true);
}

async function sendPayment(
  payment: PreparedPayment,
  onStep: (step: FlowStep) => void,
  resuming: boolean,
): Promise<FlowOutcome> {
  onStep({ id: "pay", title: resuming ? "Checking the same payment" : "Sending the signed payment" });
  const transaction = decodeCardanoTransaction(String(payment.payload.payload.transaction)).txHash;
  const unknown = (message: string): FlowOutcome => ({ status: "unknown", transaction, message });

  let response: Response;
  try {
    response = await fetch(payment.url, { method: "POST", headers: payment.headers, signal: AbortSignal.timeout(240_000) });
  } catch {
    return unknown("The connection was interrupted. The payment may have been submitted; it will be checked again rather than paid twice.");
  }

  const receiptHeader = response.headers.get("PAYMENT-RESPONSE");
  let receipt;
  try {
    receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : undefined;
  } catch {
    return unknown("The server returned an unreadable receipt.");
  }
  // A receipt is only meaningful if it is well formed and describes the
  // transaction this browser signed. Anything else is kept as unknown.
  if (receiptHeader && typeof receipt?.success !== "boolean") {
    return unknown("The server returned an invalid receipt.");
  }
  if (receipt && (receipt.transaction !== transaction || receipt.network !== payment.payload.accepted.network)) {
    return unknown("The receipt does not match this payment.");
  }

  if (response.ok && !receiptHeader) {
    try {
      const body = await response.json();
      if (body?.status === "PAID" && body.transaction === transaction) {
        onStep({ id: "settled", title: "Previously settled payment recovered", detail: body });
        return { status: "settled", body, receipt: { transaction, network: payment.payload.accepted.network, recovered: true } };
      }
    } catch { /* keep payment outcome unknown */ }
  }
  if (receipt?.errorReason === "settlement_pending") {
    return {
      status: "pending",
      transaction,
      message: "The transaction is waiting for its on-chain confirmation.",
    };
  }
  if (receipt?.success) {
    if (!response.ok) return unknown(`Payment settled but the resource returned HTTP ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unknown("Payment settled but the resource response was interrupted.");
    }
    onStep({ id: "settled", title: "Payment accepted", detail: receipt });
    return { status: "settled", body, receipt };
  }
  if (
    receipt?.errorReason === "exact_cardano_settlement_definitively_rejected" ||
    (receipt?.errorReason === "exact_cardano_settlement_failed" && receipt.extra?.status === "expired")
  ) {
    return { status: "failed", message: `Payment did not settle (${receipt.errorReason}). Contact the operator to reconcile this order before attempting another payment.` };
  }
  if (response.status === 402 && !resuming) {
    const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
    let reason = "Payment was rejected before submission.";
    if (requiredHeader) {
      try {
        reason = decodePaymentRequiredHeader(requiredHeader).error || reason;
      } catch {
        /* keep the readable fallback */
      }
    }
    return { status: "failed", message: `Payment rejected: ${reason}` };
  }
  return unknown(`Payment status is not confirmed yet (HTTP ${response.status}).`);
}
