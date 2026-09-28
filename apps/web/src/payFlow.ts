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
import {
  decodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import {
  decodeCardanoTransaction,
  type ClientCardanoSigner,
} from "@x402/cardano";

export type FlowStep = {
  id:
    | "request"
    | "offer"
    | "checked"
    | "signing"
    | "signed"
    | "pay"
    | "response"
    | "pending"
    | "unknown"
    | "failed"
    | "settled";
  title: string;
  detail?: unknown;
  at?: number;
};

export interface PreparedPayment {
  transaction?: string;
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
  confirmationTimeoutMs?: number;
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
  onStep({
    id: "request",
    title: "Request payment requirements",
    detail: {
      method: "POST",
      path: new URL(url, "http://local").pathname,
      paymentAttached: false,
    },
  });
  const first = await fetch(url, {
    method: "POST",
    headers: options.headers,
    signal: AbortSignal.timeout(15_000),
  });
  onStep({
    id: "response",
    title: `Server replied HTTP ${first.status}`,
    detail: {
      status: first.status,
      paymentRequiredHeader: first.headers.has("PAYMENT-REQUIRED"),
    },
  });
  if (first.status !== 402) {
    // Before signing, the API may report configuration or facilitator outages.
    // Display only our own short JSON error, never arbitrary HTML or remote URLs.
    const contentType = first.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await first.json().catch(() => null)
      : null;
    const message = typeof body?.error === "string" && body.error.length <= 240
      ? body.error
      : `Payment offer unavailable (HTTP ${first.status}). Keep this order and try again later.`;
    throw new Error(message);
  }

  const http = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [
        { network: options.network, client: new ExactCardanoScheme(signer) },
      ],
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

  const required = http.getPaymentRequiredResponse((name) =>
    first.headers.get(name),
  );
  onStep({
    id: "offer",
    title: "402 · Payment offer received",
    detail: {
      protocolVersion: required.x402Version,
      accepts: required.accepts.map((offer) => ({
        scheme: offer.scheme,
        network: offer.network,
        asset: offer.asset,
        amount: offer.amount,
        payTo: offer.payTo,
        maxTimeoutSeconds: offer.maxTimeoutSeconds,
      })),
    },
  });
  if (
    required.accepts.length !== 1 ||
    !required.accepts.some(
      (offer) =>
        offer.network === options.network &&
        offer.amount === (options.maxAmount ?? "5000000") &&
        offer.payTo === options.payTo &&
        offer.asset === asset,
    )
  ) {
    throw new Error(
      "Payment offer differs from the order price, network or receiving address. Nothing was signed.",
    );
  }
  onStep({
    id: "checked",
    title: "Offer matches your order",
    detail: {
      checks: ["Network", "Receiving address", "Asset", "Exact amount"],
      network: options.network,
      amountLovelace: options.maxAmount ?? "5000000",
    },
  });
  onStep({
    id: "signing",
    title: "Build transaction and request wallet signature",
    detail: {
      action: "Approve the transaction in your wallet",
      submitted: false,
    },
  });
  const payload = await http.createPaymentPayload(required);
  if (
    payload.accepted.network !== options.network ||
    payload.accepted.amount !== (options.maxAmount ?? "5000000") ||
    payload.accepted.payTo !== options.payTo ||
    payload.accepted.asset !== asset
  ) {
    throw new Error(
      "Signed payment differs from the checked offer. It was not submitted.",
    );
  }
  onStep({
    id: "signed",
    title: "Wallet signed the transaction",
    detail: {
      transaction: decodeCardanoTransaction(String(payload.payload.transaction))
        .txHash,
      network: payload.accepted.network,
      amount: payload.accepted.amount,
      submitted: false,
    },
  });

  const payment: PreparedPayment = {
    transaction: decodeCardanoTransaction(String(payload.payload.transaction)).txHash,
    url,
    payload,
    headers: {
      ...options.headers,
      ...http.encodePaymentSignatureHeader(payload),
    },
  };

  options.onPrepared?.(payment);
  return pollPayment(payment, onStep, false, options);
}

type PollOptions = Pick<FlowOptions, "automaticChecks" | "retryDelayMs" | "confirmationTimeoutMs">;
export const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;
export const CONFIRMATION_RETRY_DELAY_MS = 15_000;

export async function resumePaymentFlow(
  payment: PreparedPayment,
  onStep: (step: FlowStep) => void,
  options: PollOptions = {},
): Promise<FlowOutcome> {
  return pollPayment(payment, onStep, true, options);
}

async function pollPayment(
  payment: PreparedPayment,
  onStep: (step: FlowStep) => void,
  resuming: boolean,
  options: PollOptions,
): Promise<FlowOutcome> {
  const limit = Math.min(120, Math.max(0, Math.trunc(options.automaticChecks ?? 40)));
  const duration = Math.min(CONFIRMATION_TIMEOUT_MS, Math.max(1, options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS));
  const delay = Math.max(0, options.retryDelayMs ?? CONFIRMATION_RETRY_DELAY_MS);
  const deadline = Date.now() + duration;
  let outcome = await sendPayment(payment, onStep, resuming, Math.min(240_000, duration));
  let checks = 0;
  while ((outcome.status === "pending" || outcome.status === "unknown") && checks < limit) {
    const remaining = deadline - Date.now();
    if (remaining <= delay) break;
    onStep({
      id: "pending",
      title: `Waiting for confirmation · check ${checks + 1} of ${limit}`,
      detail: {
        delayMs: delay,
        remainingSeconds: Math.ceil(remaining / 1000),
        action: "Your payment may already be on-chain. Rechecking the original transaction; do not pay again.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    // Background tabs may wake much later than requested.
    const requestBudget = deadline - Date.now();
    if (requestBudget <= 0) break;
    checks++;
    outcome = await sendPayment(payment, onStep, true, Math.min(240_000, requestBudget));
  }
  if (outcome.status === "pending" || outcome.status === "unknown") {
    return {
      ...outcome,
      message: "Confirmation is taking longer than expected. Your transaction may already be on-chain, but the payment service has not confirmed it yet. Your signed payment is saved in this tab. Use Check payment status to keep checking without making another payment.",
    };
  }
  return outcome;
}

export async function sendPayment(
  payment: PreparedPayment,
  onStep: (step: FlowStep) => void,
  resuming: boolean,
  requestTimeoutMs = 240_000,
): Promise<FlowOutcome> {
  onStep({
    id: "pay",
    title: resuming
      ? "Checking the same payment"
      : "Sending the signed payment",
    detail: {
      method: "POST",
      header: "PAYMENT-SIGNATURE",
      network: payment.payload.accepted.network,
      sameTransactionRetry: resuming,
      serverAction:
        "Verify and settle through the facilitator; awaiting response",
    },
  });
  const transaction = decodeCardanoTransaction(
    String(payment.payload.payload.transaction),
  ).txHash;
  const unknown = (message: string): FlowOutcome => {
    onStep({
      id: "unknown",
      title: "Payment outcome needs another check",
      detail: { message, transaction },
    });
    return { status: "unknown", transaction, message };
  };

  let response: Response;
  try {
    response = await fetch(payment.url, {
      method: "POST",
      headers: payment.headers,
      signal: AbortSignal.timeout(Math.max(1, Math.floor(requestTimeoutMs))),
    });
  } catch {
    return unknown(
      "The connection was interrupted. The payment may have been submitted; it will be checked again rather than paid twice.",
    );
  }

  onStep({
    id: "response",
    title: `Payment endpoint replied HTTP ${response.status}`,
    detail: {
      status: response.status,
      receiptPresent: response.headers.has("PAYMENT-RESPONSE"),
    },
  });
  const receiptHeader = response.headers.get("PAYMENT-RESPONSE");
  let receipt;
  try {
    receipt = receiptHeader
      ? decodePaymentResponseHeader(receiptHeader)
      : undefined;
  } catch {
    return unknown("The server returned an unreadable receipt.");
  }
  // A receipt is only meaningful if it is well formed and describes the
  // transaction this browser signed. Anything else is kept as unknown.
  if (receiptHeader && typeof receipt?.success !== "boolean") {
    return unknown("The server returned an invalid receipt.");
  }
  if (
    receipt &&
    (receipt.transaction !== transaction ||
      receipt.network !== payment.payload.accepted.network)
  ) {
    return unknown("The receipt does not match this payment.");
  }

  if (response.ok && !receiptHeader) {
    try {
      const body = await response.json();
      if (
        [
          "PAID",
          "BATCHED",
          "PRINTING",
          "PRINTED",
          "SHIPPED",
          "NEEDS_REVIEW",
          "REFUNDED",
        ].includes(body?.status) &&
        body.transaction === transaction
      ) {
        onStep({
          id: "settled",
          title: "Previously settled payment recovered",
          detail: {
            transaction,
            network: payment.payload.accepted.network,
            recovered: true,
          },
        });
        return {
          status: "settled",
          body,
          receipt: {
            transaction,
            network: payment.payload.accepted.network,
            recovered: true,
          },
        };
      }
    } catch {
      /* keep payment outcome unknown */
    }
  }
  if (receipt?.errorReason === "settlement_pending") {
    onStep({
      id: "pending",
      title: "Waiting for on-chain confirmation",
      detail: { transaction, network: payment.payload.accepted.network },
    });
    return {
      status: "pending",
      transaction,
      message: "The transaction is waiting for its on-chain confirmation.",
    };
  }
  if (receipt?.success) {
    if (!response.ok)
      return unknown(
        `Payment settled but the resource returned HTTP ${response.status}.`,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unknown(
        "Payment settled but the resource response was interrupted.",
      );
    }
    onStep({
      id: "settled",
      title: "Settlement receipt verified · payment accepted",
      detail: {
        success: true,
        transaction: receipt.transaction,
        network: receipt.network,
        checks: [
          "Receipt transaction matches signed transaction",
          "Receipt network matches order",
        ],
      },
    });
    return { status: "settled", body, receipt };
  }
  if (
    receipt?.errorReason === "exact_cardano_settlement_definitively_rejected" ||
    (receipt?.errorReason === "exact_cardano_settlement_failed" &&
      receipt.extra?.status === "expired")
  ) {
    onStep({
      id: "failed",
      title: "Payment did not settle",
      detail: { reason: receipt.errorReason, transaction },
    });
    return {
      status: "failed",
      message: `Payment did not settle (${receipt.errorReason}). You can start a new order and try again.`,
    };
  }
  // Once a transaction has been signed and sent, a bare 402 cannot prove
  // rejection: the facilitator might have broadcast it before timing out.
  // Keep the original payment available for the next check.
  return unknown(
    `The payment service has not confirmed the transaction yet (HTTP ${response.status}). It may already be on-chain; keep checking the same payment.`,
  );
}
