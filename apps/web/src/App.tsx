import { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Menu,
  ShieldCheck,
  X,
} from "lucide-react";
import { Admin } from "./Admin";
import { ProtocolTrace } from "./ProtocolTrace";
import { releaseResolvedPayment } from "./paymentRecovery";
const ModelScene = lazy(() =>
  import("./ModelScene").then((m) => ({ default: m.ModelScene })),
);
import type { FlowStep, PreparedPayment } from "./payFlow";
import type { ClientCardanoSigner } from "@x402/cardano";
import type { CardanoNetwork } from "./cip30";

type Order = {
  id: string;
  access: string;
  status: string;
  priceLovelace: string;
  transaction?: string | null;
  signedTransaction?: string | null;
  network: CardanoNetwork;
  paymentFailed?: boolean;
};
type Catalog = {
  product: { priceLovelace: string; maxBatch: number };
  paused: boolean;
  network: CardanoNetwork;
  payTo: string;
  pending: number;
};
const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const request = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${API}${path}`, init);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const ada = (v?: string) => (Number(v || 0) / 1_000_000).toFixed(2);
const txUrl = (hash: string, network: CardanoNetwork = "cardano:mainnet") =>
  `https://${network === "cardano:preprod" ? "preprod." : ""}cardanoscan.io/transaction/${hash}`;
const stored = (): Order | null => {
  try {
    return JSON.parse(sessionStorage.getItem("print-order") || "null");
  } catch {
    return null;
  }
};

type SavedPayment = { order: Order; prepared: string };
const savedPayments = (): SavedPayment[] => {
  try { return JSON.parse(sessionStorage.getItem("print-saved-payments") || "[]"); }
  catch { return []; }
};

export default function App() {
  const [saved, setSaved] = useState<SavedPayment[]>(savedPayments);
  const [lookupHash, setLookupHash] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMessage, setLookupMessage] = useState("");
  const [lookupResult, setLookupResult] = useState<{ transaction: string; network: CardanoNetwork; paymentStatus: string; orderStatus: string; chain?: { status: string; confirmations?: number; requiredConfirmations?: number } } | null>(null);
  const lookupTransaction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLookupBusy(true);
    setLookupMessage("");
    setLookupResult(null);
    try {
      setLookupResult(await request(`/api/transactions/${encodeURIComponent(lookupHash.trim())}`, { signal: AbortSignal.timeout(15_000) }));
    } catch (error) {
      setLookupMessage(error instanceof Error ? error.message : "Could not check this transaction. Try again shortly.");
    } finally { setLookupBusy(false); }
  };
  const [catalog, setCatalog] = useState<Catalog>();
  const [order, setOrder] = useState<Order | null>(stored);
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showAdmin, setShowAdmin] = useState(location.pathname === "/admin");
  const [menu, setMenu] = useState(false);
  const [walletName, setWalletName] = useState("");
  const [wallets, setWallets] = useState<string[]>([]);
  const [selectedWallet, setSelectedWallet] = useState("");
  const [signer, setSigner] = useState<ClientCardanoSigner | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const refreshWallets = () => {
    const names = Object.keys((window as any).cardano || {}).filter(
      (k) => typeof (window as any).cardano[k]?.enable === "function",
    );
    setWallets(names);
    setSelectedWallet((current) =>
      names.includes(current) ? current : names[0] || "",
    );
  };
  useEffect(() => {
    refreshWallets();
  }, [order?.id]);
  useEffect(() => {
    setSigner(null);
    setWalletAddress("");
  }, [catalog?.network]);
  useEffect(() => {
    const refresh = () =>
      request("/api/catalog")
        .then(setCatalog)
        .catch((e) => {
          setCatalog(undefined);
          setMessage(e.message);
        });
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!order?.id || !order.access) return;
    let active = true;
    const tick = () =>
      request(`/api/orders/${order.id}`, {
        headers: { "x-order-secret": order.access },
      })
        .then((o: Order) => {
          if (!active) return;
          if (o.status !== "AWAITING_PAYMENT")
            sessionStorage.removeItem("print-prepared");
          setOrder((prev) => (prev?.id === o.id ? { ...prev, ...o, signedTransaction: o.signedTransaction || prev.signedTransaction } : prev));
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 12000);
    return () => { active = false; clearInterval(id); };
  }, [order?.id, order?.access]);
  useEffect(() => {
    if (order) sessionStorage.setItem("print-order", JSON.stringify(order));
  }, [order]);
  const saveOrder = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const f = new FormData(e.currentTarget);
      const body = Object.fromEntries(f.entries());
      if (!catalog) throw new Error("The shop is still loading. Please try again shortly.");
      await prepareWallet(true);
      const created = await request("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, productId: "proof-token", expectedNetwork: catalog.network }),
      });
      setOrder(created);
      document
        .getElementById("checkout")
        ?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  const prepareWallet = async (preflight = false) => {
      if (!catalog || !selectedWallet) throw new Error("Select a CIP-30 wallet before continuing. No order has been saved.");
      const wallet = (window as any).cardano?.[selectedWallet];
      if (typeof wallet?.enable !== "function")
        throw new Error(
          "Wallet is no longer available. Refresh the wallet list.",
        );
      const api = await wallet.enable();
      const { createCip30Signer } = await import("./cip30");
      const preprod = catalog.network === "cardano:preprod";
      const connected = await createCip30Signer(api, {
        network: catalog.network,
        baseUrl: preprod
          ? "https://cardano-preprod.blockfrost.io/api/v0"
          : "https://cardano-mainnet.blockfrost.io/api/v0",
        projectId: preprod
          ? import.meta.env.VITE_BLOCKFROST_PREPROD_PROJECT_ID || ""
          : import.meta.env.VITE_BLOCKFROST_MAINNET_PROJECT_ID || "",
      }, preflight);
      setSigner(connected);
      setWalletAddress(connected.getAddress());
      setWalletName(selectedWallet);
  };
  const connectWallet = async () => {
    setBusy(true);
    setMessage("");
    try {
      await prepareWallet();
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  const pay = async () => {
    if (!order || !catalog || !signer) return;
    setBusy(true);
    setMessage("");
    setSteps([]);
    try {
      if (order.network !== catalog.network)
        throw new Error(
          "The shop network changed since this order was created. Contact the operator.",
        );
      const { runPaymentFlow } = await import("./payFlow");
      const outcome = await runPaymentFlow(
        `${API}/api/orders/${order.id}/pay`,
        signer,
        (step) => setSteps((s) => [...s, { ...step, at: Date.now() }]),
        {
          network: catalog.network,
          payTo: catalog.payTo,
          maxAmount: order.priceLovelace,
          headers: { "x-order-secret": order.access },
          onPrepared: (prepared) => {
            sessionStorage.setItem("print-prepared", JSON.stringify(prepared));
            setOrder((prev) => prev ? { ...prev, signedTransaction: prepared.transaction } : prev);
          },
        },
      );
      releaseResolvedPayment(sessionStorage, outcome);
      if (outcome.status === "settled") {
        setOrder((prev) =>
          prev
            ? {
                ...prev,
                status: "PAID",
                transaction: (outcome.receipt as any)?.transaction,
              }
            : prev,
        );
      } else {
        if (outcome.status === "failed") {
          setOrder((prev) => prev ? { ...prev, paymentFailed: true } : prev);
        }
        setMessage(
          `${outcome.message}${"transaction" in outcome && outcome.transaction ? ` Transaction: ${outcome.transaction}` : ""}`,
        );
      }
    } catch (err) {
      setSteps((previous) => [
        ...previous,
        {
          id: sessionStorage.getItem("print-prepared") ? "unknown" : "failed",
          title: "Payment flow interrupted",
          at: Date.now(),
          detail: {
            action:
              "Check the message shown with your order before continuing.",
          },
        },
      ]);
      setMessage(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  const retryPayment = async () => {
    setBusy(true);
    setMessage("");
    try {
      const prepared = JSON.parse(
        sessionStorage.getItem("print-prepared") || "null",
      ) as PreparedPayment | null;
      if (
        !prepared ||
        !order ||
        prepared.url !== `${API}/api/orders/${order.id}/pay` ||
        prepared.headers["x-order-secret"] !== order.access
      )
        throw new Error(
          "No signed payment for this order. Contact the operator before attempting another payment.",
        );
      const { resumePaymentFlow } = await import("./payFlow");
      const outcome = await resumePaymentFlow(prepared, (step) =>
        setSteps((s) => [...s, { ...step, at: Date.now() }]),
      );
      releaseResolvedPayment(sessionStorage, outcome);
      if (outcome.status === "settled") {
        setOrder((prev) =>
          prev
            ? {
                ...prev,
                status: "PAID",
                transaction: (outcome.receipt as any)?.transaction,
              }
            : prev,
        );
      } else {
        if (outcome.status === "failed") {
          setOrder((prev) => prev ? { ...prev, paymentFailed: true } : prev);
        }
        setMessage(outcome.message);
      }
    } catch (e) {
      setSteps((previous) => [
        ...previous,
        {
          id: "unknown",
          title: "Payment recheck interrupted",
          at: Date.now(),
          detail: {
            action: "Keep the original payment and check the order message.",
          },
        },
      ]);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const preserveCurrentPayment = () => {
    const prepared = sessionStorage.getItem("print-prepared");
    if (!prepared || !order) return;
    const next = [...saved.filter((item) => item.order.id !== order.id), { order, prepared }];
    // Write before clearing anything: if storage is full, the current payment stays intact.
    sessionStorage.setItem("print-saved-payments", JSON.stringify(next));
    setSaved(next);
  };
  const reset = () => {
    if (busy) return;
    if (sessionStorage.getItem("print-prepared")) {
      if (!window.confirm(
        "This payment is not confirmed yet and may still complete. A new order is a separate purchase and could charge you again. Keep this order for rechecking and start a separate order?"
      )) return;
      try { preserveCurrentPayment(); }
      catch { setMessage("Could not save your payment for recovery. Recheck it before continuing."); return; }
    }
    sessionStorage.removeItem("print-order");
    sessionStorage.removeItem("print-prepared");
    setOrder(null);
    setSteps([]);
    setMessage("");
  };
  const checkoutNetwork = order?.network ?? catalog?.network;
  const isTestNetwork = !!checkoutNetwork && checkoutNetwork !== "cardano:mainnet";
  return (
    <div className="app">
      <header className="nav shell">
        <a href="/" className="brand">
          <span className="brand-mark">
            4<span>0</span>2
          </span>
          <span className="brand-divider" />
          PRINT
          <br />
          PROTOCOL
        </a>
        <nav className={menu ? "open" : ""}>
          <a href="#object" onClick={() => setMenu(false)}>
            The object
          </a>
          <a href="#protocol" onClick={() => setMenu(false)}>
            How it works
          </a>
          <a href="#checkout" onClick={() => setMenu(false)}>
            Get yours
          </a>
          <a href="#transaction-status" onClick={() => setMenu(false)}>Check payment</a>
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              history.pushState({}, "", "/admin");
              setShowAdmin(true);
              setMenu(false);
            }}
          >
            Operator ↗
          </a>
        </nav>
        <button
          className="mobile-menu"
          onClick={() => setMenu((v) => !v)}
          aria-label="Open navigation"
        >
          {menu ? <X /> : <Menu />}
        </button>
        <a href="#checkout" className="nav-cta">
          ORDER A PRINT <ArrowRight size={15} />
        </a>
      </header>
      {showAdmin ? (
        <Admin
          onClose={() => {
            history.pushState({}, "", "/");
            setShowAdmin(false);
          }}
        />
      ) : (
        <>
          <main>
            <section className="hero shell">
              <div className="hero-top">
                <span className="eyebrow">
                  <span className="pulse" />{" "}
                  {catalog?.network
                    ? `LIVE EXPERIMENT · CARDANO ${catalog.network.split(":")[1].toUpperCase()}`
                    : "CONNECTING TO CARDANO"}
                </span>
                <span className="serial">
                  EDITION 001 / THE INTERNET OF THINGS
                </span>
              </div>
              <div className="hero-grid">
                <div className="hero-copy">
                  <div className="orange-spark">✳</div>
                  <h1>
                    A payment.
                    <br />A print.
                    <br />
                    <em>A little magic.</em>
                  </h1>
                  <p>
                    Send ADA over the internet. Watch an actual 3D printer turn
                    a digital handshake into something you can hold.
                  </p>
                  <a href="#checkout" className="primary">
                    MAKE IT REAL <ArrowDownRight size={22} />
                  </a>
                  <div className="hero-foot">
                    <span>01 / ONE PHYSICAL OBJECT</span>
                    <span>02 / ONE ON-CHAIN PAYMENT</span>
                  </div>
                </div>
                <Suspense
                  fallback={
                    <div className="scene-wrap scene-loading">
                      Preparing the 3D study…
                    </div>
                  }
                >
                  <ModelScene />
                </Suspense>
              </div>
              <div className="hero-bottom">
                <span>
                  THE EXPERIMENT <span className="small-arrow">↘</span>
                </span>
                <span>SCROLL TO DISCOVER</span>
              </div>
            </section>
            <section id="object" className="object-section">
              <div className="shell object-grid">
                <div className="section-index">
                  <span>01 — THE OBJECT</span>
                  <span className="index-line" />
                </div>
                <div>
                  <h2>
                    Meet the <em>Proof of Print.</em>
                  </h2>
                  <p className="lead">
                    A pocket sized physical receipt for an internet native
                    transaction. Designed for this experiment, made layer by
                    layer on a Snapmaker U1.
                  </p>
                  <div className="spec-grid">
                    <div>
                      <span>01 / FORMAT</span>
                      <strong>Ø 54 mm</strong>
                      <small>Desk friendly token</small>
                    </div>
                    <div>
                      <span>02 / MATERIAL</span>
                      <strong>PLA</strong>
                      <small>Color varies by run</small>
                    </div>
                    <div>
                      <span>03 / PROCESS</span>
                      <strong>FDM</strong>
                      <small>Made on demand</small>
                    </div>
                  </div>
                  <a href="#checkout" className="text-link">
                    Own the experiment <ArrowRight size={18} />
                  </a>
                </div>
              </div>
            </section>
            <section id="protocol" className="protocol-section shell">
              <div className="section-index">
                <span>02 — THE PROTOCOL</span>
                <span className="index-line" />
              </div>
              <div className="protocol-intro">
                <h2>
                  The internet says <span>pay me.</span>
                  <br />
                  Your printer says <em>okay.</em>
                </h2>
                <p>
                  HTTP 402 is the web’s “payment required” status. x402 gives it
                  a working payment conversation. Here, the payment is a real
                  Cardano transaction.
                </p>
              </div>
              <div className="protocol-steps">
                <div>
                  <span className="step-num">01</span>
                  <span className="http-pill">POST /pay</span>
                  <h3>Ask for the print</h3>
                  <p>Your browser requests the protected print order.</p>
                </div>
                <div>
                  <span className="step-num">02</span>
                  <span className="http-pill hot">HTTP 402</span>
                  <h3>Get the price</h3>
                  <p>
                    The API returns the exact ADA amount, address and mainnet
                    payment rules.
                  </p>
                </div>
                <div>
                  <span className="step-num">03</span>
                  <span className="http-pill">PAYMENT-SIGNATURE</span>
                  <h3>Sign in your wallet</h3>
                  <p>
                    Your wallet signs a transaction. The hosted facilitator
                    verifies and settles it.
                  </p>
                </div>
                <div>
                  <span className="step-num">04</span>
                  <span className="http-pill green">HTTP 200</span>
                  <h3>Make it tangible</h3>
                  <p>
                    Paid orders queue for a supervised print batch and delivery.
                  </p>
                </div>
              </div>
              <div className="protocol-note">
                <span>↗</span>
                <p>
                  The live checkout below exposes each HTTP step and its payment
                  receipt so you can see the protocol in action.
                </p>
              </div>
            </section>
            <section id="checkout" className="checkout-section">
              <div className="shell">
                <div className="checkout-head">
                  <div>
                    <span className="eyebrow">
                      03 — FROM DIGITAL TO PHYSICAL
                    </span>
                    <h2>
                      Your move<span className="period">.</span>
                    </h2>
                  </div>
                  <p>
                    {isTestNetwork
                      ? "Try the Cardano payment flow with test ADA. Test orders are not shipped."
                      : "One small object. One real Cardano transaction. A story you can put on your desk."}
                  </p>
                </div>
                <div className="checkout-grid">
                  <div className="order-panel">
                    <div className="panel-top">
                      <span>YOUR ORDER / 001</span>
                      <span>
                        {catalog
                          ? catalog.paused
                            ? "● ORDERS PAUSED"
                            : "● ORDERS OPEN"
                          : "CHECKING SHOP"}
                      </span>
                    </div>
                    {isTestNetwork && (
                      <div className="testnet-warning" role="alert">
                        <span>TEST NETWORK · {checkoutNetwork?.split(":")[1]?.toUpperCase()}</span>
                        <strong>This is a test environment. No shipment will be provided.</strong>
                        <p>Payments here use test ADA with no monetary value. This checkout is for testing the payment flow; do not expect physical delivery.</p>
                      </div>
                    )}
                    {catalog?.paused && (
                      <div className="availability-note" role="status">
                        New orders are temporarily paused.
                      </div>
                    )}
                    <div className="product-row">
                      <div className="product-symbol">✳</div>
                      <div>
                        <strong>Proof of Print</strong>
                        <small>3D printed token · quantity 1</small>
                      </div>
                      <b>₳ {ada(catalog?.product.priceLovelace)}</b>
                    </div>
                    <div className="divider" />
                    <div className="price-row">
                      <span>Print + handling</span>
                      <strong>₳ {ada(catalog?.product.priceLovelace)}</strong>
                    </div>
                    <p className="fineprint">
                      {isTestNetwork
                        ? "Delivery details are collected to test checkout only. No shipment is provided for test-network orders."
                        : "Enter your complete delivery address, including country. Shipping is included in the displayed price; international delivery times may vary."}
                    </p>
                    {saved.length > 0 && (
                      <div className="availability-note" role="status">
                        <strong>Payments to check</strong>
                        <p>These earlier orders may still be paid. Open them to check before paying again. Recovery is saved in this browser tab.</p>
                        {saved.map((item) => (
                          <button className="checkout-secondary" key={item.order.id} type="button" disabled={busy} onClick={() => {
                            try {
                              preserveCurrentPayment();
                              sessionStorage.setItem("print-prepared", item.prepared);
                              const next = savedPayments().filter((entry) => entry.order.id !== item.order.id);
                              sessionStorage.setItem("print-saved-payments", JSON.stringify(next));
                              setSaved(next);
                              setOrder(item.order);
                              setSteps([]);
                              setMessage("Check this payment using the original transaction. No new wallet signature is needed.");
                            } catch { setMessage("Could not restore this payment. Please keep this tab open and contact the operator."); }
                          }}>
                            Open order {item.order.id.slice(0, 8)}
                          </button>
                        ))}
                      </div>
                    )}
                    {!order ? (
                      <form onSubmit={saveOrder} className="order-form">
                        <label>
                          Payment wallet
                          <select value={selectedWallet} disabled={busy} onChange={(event) => {
                            setSelectedWallet(event.target.value);
                            setSigner(null);
                            setWalletAddress("");
                          }} required>
                            {!wallets.length && <option value="">No wallet detected</option>}
                            {wallets.map((name) => <option key={name} value={name}>{name}</option>)}
                          </select>
                        </label>
                        <button className="checkout-secondary" type="button" disabled={busy} onClick={refreshWallets}>Refresh wallets</button>
                        <p className="fineprint">We check your wallet and the shop’s network before saving your order. No payment is signed during this check.</p>
                        <label>
                          Your name
                          <input
                            name="name"
                            required
                            maxLength={100}
                            placeholder="Ada Lovelace"
                          />
                        </label>
                        <label>
                          Email for order questions
                          <input
                            type="email"
                            name="email"
                            required
                            maxLength={160}
                            placeholder="ada@example.com"
                          />
                        </label>
                        <label>
                          Street and house number
                          <input
                            name="addressLine1"
                            required
                            maxLength={180}
                            placeholder="Example Street 42"
                          />
                        </label>
                        <label>
                          Address addition <small>optional</small>
                          <input
                            name="addressLine2"
                            maxLength={180}
                            placeholder="Apartment, c/o"
                          />
                        </label>
                        <div className="form-pair">
                          <label>
                            Postal or ZIP code <small>if applicable</small>
                            <input
                              name="postalCode"
                              maxLength={32}
                              placeholder="Postal or ZIP code"
                            />
                          </label>
                          <label>
                            City
                            <input
                              name="city"
                              required
                              maxLength={100}
                              placeholder="Berlin"
                            />
                          </label>
                        </div>
                        <label>
                          Country
                          <input
                            name="country"
                            required
                            minLength={2}
                            maxLength={80}
                            autoComplete="country-name"
                            placeholder="e.g. Germany"
                          />
                        </label>
                        <button
                          className="primary form-submit"
                          disabled={busy || !catalog || catalog.paused || !selectedWallet}
                        >
                          {busy ? "PREPARING…" : "CONTINUE TO PAYMENT"}{" "}
                          <ArrowRight size={18} />
                        </button>
                        <p className="form-disclaimer">
                          Continuing checks your wallet and network. You approve the payment separately. Please review the delivery and refund notes below.
                        </p>
                      </form>
                    ) : (
                      <div className="order-state">
                        <div className="state-header">
                          <Check size={18} /> ORDER{" "}
                          {order.id.slice(0, 8).toUpperCase()}
                        </div>
                        <div className="payment-status-card">
                          <span>Payment and print status</span>
                          <strong>{order.status.replaceAll("_", " ").toLowerCase()}</strong>
                          <small>Order reference: {order.id}</small>
                        </div>
                        {order.signedTransaction && !order.transaction && (
                          <div className="payment-hash-card">
                            <strong>Signed transaction</strong>
                            <code>{order.signedTransaction}</code>
                            <p>This hash identifies your signed payment. Settlement has not been confirmed yet.</p>
                            <div className="checkout-action-row">
                              <button className="checkout-secondary" type="button" onClick={async () => {
                                try { await navigator.clipboard.writeText(order.signedTransaction!); setMessage("Transaction hash copied. Keep it to check your order later."); }
                                catch { setMessage("Select and copy the hash manually to check later."); }
                              }}>Copy hash</button>
                              <a className="checkout-link" href="#transaction-status" onClick={() => setLookupHash(order.signedTransaction!)}>Check transaction <ArrowRight size={15} /></a>
                            </div>
                          </div>
                        )}
                        {order.transaction && (
                          <a
                            className="checkout-link payment-explorer-link"
                            target="_blank"
                            rel="noreferrer"
                            href={txUrl(order.transaction, order.network)}
                          >
                            View transaction <ExternalLink size={15} />
                          </a>
                        )}
                        {order.status === "AWAITING_PAYMENT" && !order.paymentFailed && (
                          <div className="wallet-connect">
                            <label>
                              Choose your CIP-30 wallet
                              <select
                                value={selectedWallet}
                                onChange={(e) => {
                                  setSelectedWallet(e.target.value);
                                  setSigner(null);
                                  setWalletAddress("");
                                }}
                              >
                                {wallets.map((name) => (
                                  <option key={name} value={name}>
                                    {name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button className="checkout-secondary" type="button" onClick={refreshWallets}>
                              Refresh wallets
                            </button>
                            <button
                              className="checkout-secondary"
                              type="button"
                              disabled={busy || !selectedWallet}
                              onClick={connectWallet}
                            >
                              Connect wallet
                            </button>
                            {walletAddress && (
                              <small>
                                Connected: {walletName} ·{" "}
                                {walletAddress.slice(0, 16)}…
                              </small>
                            )}
                          </div>
                        )}
                        {order.status === "AWAITING_PAYMENT" && !order.paymentFailed && (
                          <button
                            className="primary form-submit"
                            onClick={
                              sessionStorage.getItem("print-prepared")
                                ? retryPayment
                                : pay
                            }
                            disabled={
                              busy ||
                              (!signer &&
                                !sessionStorage.getItem("print-prepared"))
                            }
                          >
                            {busy
                              ? "PROCESSING…"
                              : sessionStorage.getItem("print-prepared")
                                ? "CHECK PAYMENT STATUS"
                                : "SIGN & PAY ON CARDANO"}{" "}
                            <ArrowRight size={18} />
                          </button>
                        )}
                        {order.paymentFailed && (
                          <div className="availability-note" role="status">
                            Payment was rejected. You can start a new order and try again.
                          </div>
                        )}
                        {sessionStorage.getItem("print-prepared") && (
                          <div className="payment-recovery-note" role="status">
                            <strong>Confirmation is still pending</strong>
                            <p>Your order and any signed payment received by our server remain saved. Use the hash above to check again later. Please do not sign or pay again while this payment is unresolved.</p>
                          </div>
                        )}
                        <button className="checkout-secondary checkout-new-order" type="button" onClick={reset} disabled={busy}>
                          {order.paymentFailed ? "Try again with a new order" : "Start another order"}
                        </button>
                      </div>
                    )}
                    {message && (
                      <div className="checkout-message" role="alert">
                        {message}
                      </div>
                    )}
                  </div>
                  <div className="trace-panel">
                    <div className="panel-top">
                      <span>LIVE PROTOCOL TRACE</span>
                      <span className="live-indicator">● LIVE</span>
                    </div>
                    <ProtocolTrace
                      steps={steps}
                      network={catalog?.network}
                      busy={busy}
                    />
                    <div className="trace-foot">
                      <ShieldCheck size={18} /> The server never sees your
                      wallet keys. Your delivery address is visible only to the
                      operator.
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <section className="shell transaction-lookup" id="transaction-status">
              <div className="lookup-panel">
                <div className="lookup-heading">
                  <span className="eyebrow">PAYMENT RECOVERY</span>
                  <h2>Check your transaction<span className="period">.</span></h2>
                  <p>Enter a transaction hash to see its payment and print status. You do not need to reconnect your wallet.</p>
                </div>
                <form onSubmit={lookupTransaction} className="order-form lookup-form">
                  <label htmlFor="transaction-hash">Transaction hash
                    <input id="transaction-hash" value={lookupHash} onChange={(event) => { setLookupHash(event.target.value); setLookupResult(null); setLookupMessage(""); }} required pattern="[a-fA-F0-9]{64}" maxLength={64} placeholder="64-character transaction hash" disabled={lookupBusy} />
                  </label>
                  <button className="primary" type="submit" disabled={lookupBusy}>{lookupBusy ? "CHECKING…" : "CHECK TRANSACTION STATUS"} <ArrowRight size={16} /></button>
                </form>
                {lookupMessage && <div className="checkout-message" role="alert">{lookupMessage}</div>}
                {lookupResult && <div className="lookup-result" role="status">
                  <span className="eyebrow">TRANSACTION STATUS</span>
                  <dl className="lookup-facts">
                    <div><dt>Payment</dt><dd>{lookupResult.paymentStatus === "SETTLED" ? "Recorded as settled" : "Awaiting confirmation"}</dd></div>
                    <div><dt>Order</dt><dd>{lookupResult.orderStatus.replaceAll("_", " ").toLowerCase()}</dd></div>
                    <div><dt>Blockchain check</dt><dd>{({ CONFIRMED: "Verified on-chain", CONFIRMING: "On-chain, awaiting more confirmations", NOT_FOUND: "Not visible to the provider yet", MISMATCH: "Needs operator review", UNAVAILABLE: "Provider temporarily unavailable", NOT_CONFIGURED: "Automatic checks are not configured yet", CHECK_AGAIN: "Recently checked. Try again in 15 seconds", RECORDED: "Payment already recorded" } as Record<string, string>)[lookupResult.chain?.status || ""] || "Pending"}</dd></div>
                    {lookupResult.chain?.confirmations !== undefined && <div><dt>Confirmations</dt><dd>{lookupResult.chain.confirmations} / {lookupResult.chain.requiredConfirmations}</dd></div>}
                  </dl>
                  <a className="checkout-link" href={txUrl(lookupResult.transaction, lookupResult.network)} target="_blank" rel="noreferrer">View on explorer <ExternalLink size={15} /></a>
                  <p className="lookup-guidance">You can check this hash again later. If confirmation is pending, keep the original payment and do not pay again.</p>
                </div>}
              </div>
            </section>
            <section className="faq shell">
              <div>
                <span className="eyebrow">A FEW GOOD QUESTIONS</span>
                <h2>
                  Small print.
                  <br />
                  <em>Big idea.</em>
                </h2>
              </div>
              <div className="faq-list">
                <details>
                  <summary>
                    Is this a real purchase? <ChevronDown size={18} />
                  </summary>
                  <p>
                    {isTestNetwork
                      ? `No. This checkout runs on Cardano ${checkoutNetwork?.split(":")[1] || "testnet"}. Test ADA has no monetary value, and no shipment is provided. Confirm the test amount in your wallet before signing.`
                      : "On mainnet, yes. Confirm the ADA amount in your wallet before signing. This creates a real purchase."}
                  </p>
                </details>
                <details>
                  <summary>
                    When will my print ship? <ChevronDown size={18} />
                  </summary>
                  <p>
                    {isTestNetwork
                      ? "Test-network orders are for payment testing. No shipment will be provided."
                      : "Prints are grouped into supervised batches. Timing can vary; we will contact you by email if there is a problem."}
                  </p>
                </details>
                <details>
                  <summary>
                    What if printing fails? <ChevronDown size={18} />
                  </summary>
                  <p>
                    The operator reviews failed jobs and can arrange a reprint
                    or a manual refund. On-chain payments are not automatically
                    reversible. Contact the operator using the address published
                    in the repository.
                  </p>
                </details>
                <details>
                  <summary>
                    What happens to my address? <ChevronDown size={18} />
                  </summary>
                  <p>
                    Your delivery details are stored in the order database for
                    fulfillment. They are never placed on chain or sent to the
                    printer. The public source code contains no customer data.
                  </p>
                </details>
              </div>
            </section>
          </main>
          <footer>
            <div className="shell footer-grid">
              <div className="footer-brand">
                402<span>✳</span>
              </div>
              <div>
                <span>AN OPEN EXPERIMENT</span>
                <p>
                  Making internet native payments tangible, one layer at a time.
                </p>
              </div>
              <div>
                <span>FOLLOW THE BUILD</span>
                <a
                  href="https://github.com/Kammerlo/x402-cardano-3dprinting-service"
                  target="_blank"
                  rel="noreferrer"
                >
                  SOURCE ON GITHUB ↗
                </a>
              </div>
              <div className="footer-end">CARDANO MAINNET · 2026</div>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
