import type { FlowOutcome } from "./payFlow";

/** Only a confirmed outcome releases the browser's original signed payment. */
export function releaseResolvedPayment(
  storage: Pick<Storage, "removeItem">,
  outcome: FlowOutcome,
) {
  if (outcome.status === "failed" || outcome.status === "settled") {
    storage.removeItem("print-prepared");
  }
}
