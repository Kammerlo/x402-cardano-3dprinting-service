import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  LockKeyhole,
  Package,
  Printer,
  RefreshCw,
} from "lucide-react";

type Order = {
  id: string;
  customer_name: string;
  email: string;
  address_line1: string;
  address_line2: string;
  postal_code: string;
  city: string;
  country: string;
  status: string;
  batch_id: string | null;
  created_at: string;
  tx_hash: string | null;
  signed_tx_hash?: string | null;
  network: string;
};
type Batch = {
  id: string;
  size: number;
  status: string;
  confirmed_at: string | null;
};
type Dashboard = {
  orders: Order[];
  batches: Batch[];
  totals: Record<string, number>;
  paused: boolean;
  currentBatch: Batch | null;
  currentBatchId: string | null;
  gateway: {
    active: boolean;
    ready: boolean;
    state: string;
    lastSeen: string | null;
    batchSizes: number[];
  };
};
const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const labels: Record<string, string> = {
  PAID: "Waiting to print",
  BATCHED: "Starting",
  PRINTING: "Printing",
  PRINTED: "Ready to send",
  SHIPPED: "Sent",
  NEEDS_REVIEW: "Needs attention",
  AWAITING_PAYMENT: "Awaiting payment",
  REFUNDED: "Refund recorded",
};
class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, csrf = "", body?: object): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    credentials: "include",
    signal: AbortSignal.timeout(240_000),
    headers: {
      "content-type": "application/json",
      ...(body && csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new AdminError(
      data.error || `HTTP ${response.status}`,
      response.status,
    );
  return data;
}
function Delivery({ order }: { order: Order }) {
  return (
    <address className="delivery-address">
      <strong>{order.customer_name}</strong>
      <span>{order.address_line1}</span>
      {order.address_line2 && <span>{order.address_line2}</span>}
      <span>
        {order.postal_code} {order.city}
      </span>
      <span>{order.country === "DE" ? "Germany" : order.country}</span>
      <a href={`mailto:${order.email}`}>{order.email}</a>
    </address>
  );
}
export function Admin({ onClose }: { onClose: () => void }) {
  const [credential, setCredential] = useState("");
  const [csrf, setCsrf] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [plateEmpty, setPlateEmpty] = useState(false);
  const [tab, setTab] = useState("PAID");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const revision = useRef(0);
  const clear = useCallback(() => {
    revision.current++;
    setCsrf("");
    setDashboard(undefined);
    setCredential("");
    setPlateEmpty(false);
  }, []);
  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof AdminError && cause.status === 401) clear();
      setError(
        cause instanceof Error
          ? cause.message
          : "Request failed. Refresh and try again.",
      );
    },
    [clear],
  );
  useEffect(() => {
    sessionStorage.removeItem("print-admin");
    let mounted = true;
    void request<{ csrf: string }>("/api/admin/auth/session")
      .then((data) => {
        if (mounted) setCsrf(data.csrf);
      })
      .catch((cause) => {
        if (mounted && (!(cause instanceof AdminError) || cause.status !== 401))
          handleError(cause);
      });
    return () => {
      mounted = false;
    };
  }, [handleError]);
  const refresh = useCallback(async () => {
    if (!csrf) return;
    const version = ++revision.current;
    try {
      const data = await request<Dashboard>(
        `/api/admin/orders?search=${encodeURIComponent(search)}&offset=${offset}&status=${tab}`,
      );
      if (version === revision.current) setDashboard(data);
    } catch (cause) {
      if (version === revision.current) handleError(cause);
    }
  }, [csrf, search, offset, tab, handleError]);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 200);
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      revision.current++;
    };
  }, [refresh]);
  useEffect(() => {
    setPlateEmpty(false);
  }, [dashboard?.currentBatchId]);
  const action = async (path: string, body: object = {}) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{
        batch?: { id: string; size: number } | null;
      }>(path, csrf, body);
      if (path.endsWith("start-next")) {
        setPlateEmpty(false);
        setNotice(
          result.batch
            ? `Starting a plate of ${result.batch.size}. The gateway checks the printer again before launch.`
            : "Plate marked empty. No paid orders fit the available batch files yet.",
        );
      }
      await refresh();
    } catch (cause) {
      handleError(cause);
    } finally {
      setBusy(false);
    }
  };
  const logout = async (all = false) => {
    try {
      await request(
        `/api/admin/auth/${all ? "revoke-all" : "logout"}`,
        csrf,
        {},
      );
      clear();
      setNotice("Signed out.");
    } catch (cause) {
      handleError(cause);
    }
  };
  // Local inactivity lock also revokes the server session. Background refreshes do not reset it.
  useEffect(() => {
    if (!csrf) return;
    let lastInteraction = Date.now();
    const touch = () => {
      lastInteraction = Date.now();
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    const timer = setInterval(() => {
      if (Date.now() - lastInteraction > 15 * 60_000) {
        void request("/api/admin/auth/logout", csrf, {}).catch(() => {});
        clear();
      }
    }, 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [csrf, clear]);
  const current = dashboard?.currentBatch;
  const onPlate =
    dashboard?.orders.filter((order) => order.batch_id === current?.id) || [];
  const online =
    !!dashboard?.gateway.lastSeen &&
    Date.now() - new Date(dashboard.gateway.lastSeen).getTime() < 30_000;
  const ready =
    online && dashboard?.gateway.ready && !dashboard?.gateway.active;
  const running =
    current && ["DISPATCHING", "PRINTING"].includes(current.status);
  const unresolved = onPlate.some((order) =>
    ["NEEDS_REVIEW", "PRINTING"].includes(order.status),
  );
  const nextSize =
    current?.status === "QUEUED"
      ? current.size
      : Math.max(
          0,
          ...(dashboard?.gateway.batchSizes || []).filter(
            (size) => size <= (dashboard?.totals.PAID || 0),
          ),
        );
  const visible =
    dashboard?.orders.filter(
      (order) =>
        (!tab || order.status === tab) &&
        (!search ||
          `${order.id} ${order.customer_name} ${order.email} ${order.tx_hash || ""} ${order.signed_tx_hash || ""}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    ) || [];
  const setFilter = (value: string) => {
    setTab(value);
    setOffset(0);
  };
  const mark = (order: Order, status: string) =>
    void action(`/api/admin/orders/${order.id}/status`, { status });
  const recovery = (order: Order) => (
    <details className="order-recovery">
      <summary>More actions</summary>
      <code>{order.id}</code>
      {order.status === "AWAITING_PAYMENT" && (
        <button
          disabled={busy}
          onClick={() => void action(`/api/admin/orders/${order.id}/reconcile`)}
        >
          Check stored payment
        </button>
      )}
      {["PRINTED", "SHIPPED"].includes(order.status) && (
        <button
          disabled={busy}
          onClick={() => {
            if (window.confirm("Mark this order for a replacement print?"))
              mark(order, "NEEDS_REVIEW");
          }}
        >
          Needs a reprint
        </button>
      )}
      {order.status === "NEEDS_REVIEW" && (
        <>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Have you inspected this object and confirmed it is usable?",
                )
              )
                mark(order, "PRINTED");
            }}
          >
            Inspected: print is good
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Confirm the old print has stopped and this order needs a replacement.",
                )
              )
                void action(`/api/admin/orders/${order.id}/requeue`, {
                  confirmedPhysicalReview: true,
                });
            }}
          >
            Queue replacement
          </button>
        </>
      )}
      {["PAID", "PRINTED", "NEEDS_REVIEW"].includes(order.status) && (
        <button
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Have you already refunded this customer? This only records the refund; it does not send funds.",
              )
            )
              mark(order, "REFUNDED");
          }}
        >
          Record completed refund
        </button>
      )}
      {order.tx_hash && (
        <a
          target="_blank"
          rel="noreferrer"
          href={`https://${order.network === "cardano:preprod" ? "preprod." : ""}cardanoscan.io/transaction/${order.tx_hash}`}
        >
          View payment ↗
        </a>
      )}
    </details>
  );
  return (
    <main className="admin admin-simple shell">
      <header className="admin-heading">
        <div>
          <span className="eyebrow">PRIVATE OPERATOR DASHBOARD</span>
          <h1>
            Print desk<span className="period">.</span>
          </h1>
        </div>
        <div className="desk-toolbar">
          <button onClick={onClose}>
            Storefront <ArrowRight size={16} />
          </button>
          {csrf && (
            <button onClick={() => void logout()}>
              <LockKeyhole size={16} /> Sign out
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="desk-notice" role="status">
          {notice}
        </p>
      )}
      {!csrf ? (
        <form
          className="desk-login"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            const value = credential;
            setCredential("");
            try {
              const result = await request<{ csrf: string }>(
                "/api/admin/auth/login",
                "",
                { token: value },
              );
              setCsrf(result.csrf);
            } catch (cause) {
              handleError(cause);
            } finally {
              setBusy(false);
            }
          }}
        >
          <LockKeyhole />
          <h2>Sign in securely</h2>
          <label>
            Admin access key
            <input
              required
              type="password"
              autoComplete="current-password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Open print desk"}
          </button>
          <p>Your access key is not saved in this browser.</p>
        </form>
      ) : dashboard ? (
        <>
          <section className="desk-plate" aria-labelledby="plate-heading">
            <div className="desk-plate-title">
              <Printer />
              <div>
                <span className="eyebrow">CURRENT PLATE</span>
                <h2 id="plate-heading">
                  {current
                    ? `${current.size} prints · ${labels[current.status] || current.status}`
                    : "Ready for your next plate"}
                </h2>
              </div>
              <span className={`desk-chip ${ready ? "is-ready" : ""}`}>
                {!online
                  ? "Gateway offline"
                  : dashboard.gateway.active
                    ? "Printing"
                    : ready
                      ? "Printer ready"
                      : `Printer: ${dashboard.gateway.state}`}
              </span>
            </div>
            {onPlate.length > 0 && (
              <ul className="plate-orders">
                {onPlate.map((order) => (
                  <li key={order.id}>
                    <span>
                      <strong>{order.customer_name}</strong>
                      <small>
                        #{order.id.slice(0, 8)} · {labels[order.status]}
                      </small>
                    </span>
                    {order.status === "NEEDS_REVIEW" && recovery(order)}
                  </li>
                ))}
              </ul>
            )}
            {running ? (
              <p>
                The plate is in progress. When it finishes, remove the prints
                before starting the next batch.
              </p>
            ) : (
              <div className="plate-next">
                <p>
                  {nextSize
                    ? `Next plate: ${nextSize} orders. ${dashboard.totals.PAID || 0} paid orders waiting.`
                    : "No matching paid batch yet. A single-print G-code file lets you handle small queues."}
                </p>
                <label className="plate-confirm">
                  <input
                    type="checkbox"
                    checked={plateEmpty}
                    onChange={(event) => setPlateEmpty(event.target.checked)}
                  />{" "}
                  I removed all prints and the plate is empty and safe to use.
                </label>
                <button
                  className="primary"
                  disabled={busy || !plateEmpty || !ready || unresolved}
                  onClick={() =>
                    void action("/api/admin/print/start-next", {
                      plateEmpty: true,
                      expectedBatchId: current?.id || null,
                    })
                  }
                >
                  {busy ? "Checking…" : "Start the next batch"}{" "}
                  <ArrowRight size={18} />
                </button>
                {!ready && (
                  <p className="desk-hint">
                    Restore the printer connection and wait for its ready
                    status. No new print is scheduled while it is offline.
                  </p>
                )}
                {unresolved && (
                  <p className="desk-hint">
                    Resolve the orders needing attention before starting another
                    plate.
                  </p>
                )}
              </div>
            )}
            {running && (!online || !dashboard.gateway.active) && (
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Physically stop the old job and inspect the plate before continuing. Mark this plate for review?",
                    )
                  )
                    void action(`/api/admin/batches/${current.id}/review`, {
                      confirmedStopped: true,
                    });
                }}
              >
                Review stopped / uncertain print
              </button>
            )}
            <small>
              Available G-code batches:{" "}
              {dashboard.gateway.batchSizes.join(", ") || "none found"} · The
              gateway checks the printer again immediately before starting.
            </small>
          </section>
          <section className="desk-orders">
            <div className="desk-section-title">
              <h2>
                <Package size={25} /> Orders
              </h2>
              <button onClick={() => void refresh()} disabled={busy}>
                <RefreshCw size={16} /> Refresh
              </button>
            </div>
            <div className="desk-tabs" role="group" aria-label="Filter orders">
              {[
                ["PAID", "Waiting"],
                ["PRINTED", "Ready to send"],
                ["SHIPPED", "Sent"],
                ["NEEDS_REVIEW", "Needs attention"],
                ["", "All orders"],
              ].map(([value, label]) => (
                <button
                  className={tab === value ? "selected" : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {label}{" "}
                  <b>
                    {value
                      ? dashboard.totals[value] || 0
                      : Object.values(dashboard.totals).reduce(
                          (a, b) => a + b,
                          0,
                        )}
                  </b>
                </button>
              ))}
            </div>
            <label className="desk-search">
              Search orders
              <input
                type="search"
                placeholder="Name, email, order ID or transaction hash"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (event.target.value) setTab("");
                  setOffset(0);
                }}
              />
            </label>
            <div className="desk-order-grid">
              {visible.map((order) => (
                <article className="desk-order" key={order.id}>
                  <header>
                    <span>#{order.id.slice(0, 8)}</span>
                    <span
                      className={`status status-${order.status.toLowerCase()}`}
                    >
                      {labels[order.status]}
                    </span>
                  </header>
                  <strong>{order.customer_name}</strong>
                  <small>{new Date(order.created_at).toLocaleString()}</small>
                  <details open={tab === "PRINTED"}>
                    <summary>Delivery & contact</summary>
                    <Delivery order={order} />
                  </details>
                  {order.status === "PRINTED" && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => mark(order, "SHIPPED")}
                    >
                      Mark as sent ✓
                    </button>
                  )}
                  {(order.tx_hash || order.signed_tx_hash) && (
                    <div className="order-payment">
                      <small>{order.tx_hash ? "Payment settled" : "Signed · settlement unconfirmed"}</small>
                      <code style={{ display: "block", overflowWrap: "anywhere" }}>{order.tx_hash || order.signed_tx_hash}</code>
                      <button type="button" onClick={async () => {
                        try {
                          await navigator.clipboard.writeText((order.tx_hash || order.signed_tx_hash)!);
                          setNotice("Transaction hash copied.");
                        } catch { setError("Could not copy automatically. Select the transaction hash and copy it manually."); }
                      }}>Copy transaction hash</button>
                      <a target="_blank" rel="noreferrer" href={`https://${order.network === "cardano:preprod" ? "preprod." : ""}cardanoscan.io/transaction/${order.tx_hash || order.signed_tx_hash}`}>Check on explorer ↗</a>
                      {!order.tx_hash && <small>A signed hash does not prove submission or payment. It may not appear on the explorer yet.</small>}
                    </div>
                  )}
                  {recovery(order)}
                </article>
              ))}
            </div>
            {!visible.length && (
              <p className="desk-empty">No orders in this view.</p>
            )}
            <div className="desk-pagination">
              <button
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                Previous
              </button>
              <span>Page {offset / 100 + 1}</span>
              <button
                disabled={busy || visible.length < 100}
                onClick={() => setOffset(offset + 100)}
              >
                Next
              </button>
            </div>
          </section>
          <details className="desk-settings">
            <summary>Shop settings & history</summary>
            <button
              disabled={busy}
              onClick={() =>
                void action("/api/admin/pause", { paused: !dashboard.paused })
              }
            >
              {dashboard.paused ? "Resume new orders" : "Pause new orders"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Sign out every admin session, including this one?",
                  )
                )
                  void logout(true);
              }}
            >
              Sign out all admin sessions
            </button>
            <h3>Recent plates</h3>
            {dashboard.batches.map((batch) => (
              <p key={batch.id}>
                #{batch.id.slice(0, 8)} · {batch.size} prints ·{" "}
                {labels[batch.status] || batch.status}
                {batch.confirmed_at ? " · plate cleared" : ""}
              </p>
            ))}
          </details>
        </>
      ) : (
        <p role="status">Loading print desk…</p>
      )}
    </main>
  );
}
