import { useEffect, useRef } from "react";
import type { FlowStep } from "./payFlow";

const stages: Record<
  FlowStep["id"],
  { label: string; tone: string; description: string }
> = {
  request: {
    label: "CLIENT → API",
    tone: "blue",
    description: "Ask the server how to pay for this order.",
  },
  offer: {
    label: "HTTP 402",
    tone: "orange",
    description:
      "The server supplies the price, network and receiving address.",
  },
  checked: {
    label: "CHECKS PASSED",
    tone: "cyan",
    description:
      "The offer matches the order before your wallet is asked to sign.",
  },
  signing: {
    label: "YOUR WALLET",
    tone: "purple",
    description:
      "Your wallet prepares and signs the transaction. Your keys stay in your wallet.",
  },
  signed: {
    label: "SIGNED LOCALLY",
    tone: "purple",
    description:
      "A signature is ready. This alone does not mean the payment has settled.",
  },
  pay: {
    label: "CLIENT → API",
    tone: "blue",
    description:
      "The API handles verification and settlement. This view waits for its response.",
  },
  response: {
    label: "API → CLIENT",
    tone: "cyan",
    description:
      "An actual HTTP response has arrived from the payment endpoint.",
  },
  pending: {
    label: "WAITING / RETRY",
    tone: "amber",
    description:
      "The same signed transaction will be checked again; no new payment is requested.",
  },
  unknown: {
    label: "NOT CONFIRMED",
    tone: "amber",
    description:
      "The outcome is uncertain. Keep this order and recheck the original payment.",
  },
  failed: {
    label: "ACTION NEEDED",
    tone: "red",
    description: "Read the reason below before trying again.",
  },
  settled: {
    label: "PAYMENT ACCEPTED",
    tone: "green",
    description:
      "The matching payment is accepted. Fulfillment follows separately.",
  },
};

export function ProtocolTrace({
  steps,
  network,
  busy,
}: {
  steps: FlowStep[];
  network?: string;
  busy: boolean;
}) {
  const terminal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (terminal.current)
      terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [steps.length]);
  return (
    <div className="terminal protocol-terminal" ref={terminal}>
      <div className="terminal-title">
        <span className="terminal-dots">● ● ●</span> payment.session
        <span>{network?.split(":")[1].toUpperCase() || "NETWORK"}</span>
      </div>
      <div className="trace-legend">
        <span className="trace-blue">HTTP</span>
        <span className="trace-purple">WALLET</span>
        <span className="trace-amber">WAITING</span>
        <span className="trace-green">SETTLED</span>
      </div>
      <div
        role="log"
        aria-label="Live payment protocol events"
        aria-live="polite"
        aria-relevant="additions"
      >
        {steps.map((step, index) => {
          const stage = stages[step.id];
          return (
            <article
              className={`trace-step trace-${stage.tone}`}
              key={`${step.id}-${index}`}
            >
              <span className="trace-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="trace-content">
                <div className="trace-meta">
                  <span className="trace-badge">{stage.label}</span>
                  {step.at && (
                    <time dateTime={new Date(step.at).toISOString()}>
                      {new Date(step.at).toLocaleTimeString()}
                    </time>
                  )}
                </div>
                <strong>{step.title}</strong>
                <p>{stage.description}</p>
                {step.detail !== undefined && (
                  <details
                    open={
                      index === steps.length - 1 ||
                      ["offer", "signed", "settled"].includes(step.id)
                    }
                  >
                    <summary>Protocol details</summary>
                    <pre>{JSON.stringify(step.detail, null, 2)}</pre>
                  </details>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!steps.length && (
        <div className="terminal-empty">
          <span className="cursor">↔</span>
          <strong>Your payment, step by step.</strong>
          <p>
            Request → 402 offer → wallet signature → submission → settlement
            receipt.
          </p>
          <small>Real events appear when you pay.</small>
        </div>
      )}
      {!!steps.length && (
        <div className="trace-session-state">
          {busy
            ? "● PAYMENT FLOW IN PROGRESS"
            : `${steps.length} EVENTS RECORDED`}
        </div>
      )}
    </div>
  );
}
