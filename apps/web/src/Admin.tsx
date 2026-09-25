import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Package, ShieldCheck } from "lucide-react";

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
  network: "cardano:preprod" | "cardano:mainnet";
  tx_hash: string | null;
  batch_id: string | null;
  batch_status: string | null;
  created_at: string;
};
type Batch = {
  id: string;
  size: number;
  status: string;
  printer_filename: string | null;
  confirmed_at: string | null;
};
type Attempt = {
  order_id: string;
  tx_hash: string;
  status: string;
  created_at: string;
};
type Dashboard = {
  totals: Record<string, number>;
  orders: Order[];
  batches: Batch[];
  attempts: Attempt[];
  paused: boolean;
  currentBatchId: string | null;
  currentBatch: Batch | null;
  gateway: { armed: boolean; active: boolean; lastSeen: string | null };
};
type ShippingPage = { orders: Order[]; nextCursor: string | null };
const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

async function adminRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(240_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

function address(order: Order) {
  return (
    <address className="delivery-address">
      <strong>{order.customer_name}</strong>
      <span>
        {order.address_line1}
        {order.address_line2 && `, ${order.address_line2}`}
      </span>
      <span>
        {order.postal_code} {order.city}
      </span>
      <span>
        Country: {order.country === "DE" ? "Germany (DE)" : order.country}
      </span>
      <a href={`mailto:${order.email}`}>{order.email}</a>
    </address>
  );
}

const transactionUrl = (order: Order) =>
  `https://${order.network === "cardano:preprod" ? "preprod." : ""}cardanoscan.io/transaction/${order.tx_hash}`;

export function Admin({ onClose }: { onClose: () => void }) {
  const [tokenInput, setTokenInput] = useState(
    sessionStorage.getItem("print-admin") || "",
  );
  const [token, setToken] = useState(
    sessionStorage.getItem("print-admin") || "",
  );
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [shipping, setShipping] = useState<ShippingPage>({
    orders: [],
    nextCursor: null,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const refresh = useCallback(
    async (refreshShipping = false) => {
      if (!token) return;
      try {
        const data = await adminRequest<Dashboard>(
          `/api/admin/orders?search=${encodeURIComponent(search)}&offset=${offset}`,
          token,
        );
        setDashboard(data);
        if (refreshShipping)
          setShipping(
            await adminRequest<ShippingPage>("/api/admin/shipping", token),
          );
        setError("");
      } catch (cause) {
        setError(String(cause));
      }
    },
    [token, search, offset],
  );

  useEffect(() => {
    void refresh(true);
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const action = async (path: string, body: object = {}) => {
    setBusy(true);
    try {
      await adminRequest(path, token, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const confirmBatch = (batch: Batch) => {
    if (
      !window.confirm(
        `Inspect the U1 and all ${batch.size} object(s) on plate ${batch.id.slice(0, 8)}. Confirm this batch is finished and queue up to four more paid orders?`,
      )
    )
      return;
    void action(`/api/admin/batches/${batch.id}/confirm`, { inspected: true });
  };
  const requeue = (order: Order) => {
    if (
      !window.confirm(
        `Inspect the U1 and the previous plate for ${order.customer_name}. Confirm this order needs a new print and no old job is running?`,
      )
    )
      return;
    void action(`/api/admin/orders/${order.id}/requeue`, {
      confirmedPhysicalReview: true,
    });
  };
  const reviewStoppedBatch = (batch: Batch) => {
    if (
      !window.confirm(
        "Physically verify that the U1 is stopped and inspect its plate and gateway journal. Mark this unfinished batch for review? This does not start another print.",
      )
    )
      return;
    void action(`/api/admin/batches/${batch.id}/review`, {
      confirmedStopped: true,
    });
  };
  const rearmGateway = () => {
    if (
      !window.confirm(
        "Physically verify that the U1 is idle, no old job is running and all previous failures were reviewed. Arm the gateway to resume queued work?",
      )
    )
      return;
    void action("/api/admin/gateway/rearm", { confirmedIdle: true });
  };
  const loadMoreShipping = async () => {
    if (!shipping.nextCursor || busy) return;
    setBusy(true);
    try {
      const page = await adminRequest<ShippingPage>(
        `/api/admin/shipping?after=${encodeURIComponent(shipping.nextCursor)}`,
        token,
      );
      setShipping((current) => ({
        orders: [...current.orders, ...page.orders],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const currentBatch = dashboard?.currentBatch;
  const unresolved = dashboard?.orders.some(
    (order) =>
      order.batch_id === currentBatch?.id &&
      ["NEEDS_REVIEW", "BATCHED", "PRINTING"].includes(order.status),
  );
  const gatewayOnline =
    !!dashboard?.gateway.lastSeen &&
    Date.now() - new Date(dashboard.gateway.lastSeen).getTime() < 45_000;

  return (
    <main className="admin shell">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">OPERATOR SPACE / PRIVATE</span>
          <h1>
            Print desk<span className="period">.</span>
          </h1>
        </div>
        <button className="text-link" onClick={onClose}>
          Back to storefront <ArrowRight size={18} />
        </button>
      </div>
      <form
        className="admin-login"
        onSubmit={(event) => {
          event.preventDefault();
          sessionStorage.setItem("print-admin", tokenInput);
          setToken(tokenInput);
          if (token === tokenInput) void refresh(true);
        }}
      >
        <label>
          Operator token
          <input
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Enter admin token"
          />
        </label>
        <button className="primary">
          UNLOCK DASHBOARD <ArrowRight size={18} />
        </button>
        {token && (
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem("print-admin");
              setToken("");
              setTokenInput("");
              setDashboard(undefined);
              setShipping({ orders: [], nextCursor: null });
            }}
          >
            Lock dashboard
          </button>
        )}
      </form>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {dashboard && (
        <>
          <div className="admin-stats">
            <div>
              <span>TOTAL ORDERS</span>
              <strong>
                {Object.values(dashboard.totals).reduce((a, b) => a + b, 0)}
              </strong>
            </div>
            <div>
              <span>PAID / WAITING</span>
              <strong>{dashboard.totals.PAID || 0}</strong>
            </div>
            <div>
              <span>ON THE PRINTER</span>
              <strong>{dashboard.totals.PRINTING || 0}</strong>
            </div>
            <div>
              <span>READY TO SHIP</span>
              <strong>{dashboard.totals.PRINTED || 0}</strong>
            </div>
          </div>
          <div className="admin-actions">
            <button
              disabled={busy || !!dashboard.currentBatchId}
              onClick={() => void action("/api/admin/batches")}
            >
              Create batch (up to 4) ↗
            </button>
            <button disabled={busy} onClick={rearmGateway}>
              Arm / resume gateway
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action("/api/admin/pause", { paused: !dashboard.paused })
              }
            >
              {dashboard.paused ? "Resume orders" : "Pause new orders"}
            </button>
            <button onClick={() => void refresh(true)}>Refresh</button>
          </div>
          <p className="fineprint">
            Gateway:{" "}
            {gatewayOnline
              ? dashboard.gateway.active
                ? "printing"
                : dashboard.gateway.armed
                  ? "connected and armed"
                  : "connected, needs arming"
              : "offline"}
            . Customers can place paid orders while the printer is offline; they
            remain queued until you restore it.
          </p>
          {currentBatch && (
            <div className="admin-current-batch">
              <strong>
                Current plate {currentBatch.id.slice(0, 8)} ·{" "}
                {currentBatch.status} · {currentBatch.size} objects
              </strong>
              <p>
                {currentBatch.status === "QUEUED"
                  ? "Waiting for the gateway and an idle U1. Use Arm / resume gateway after physical inspection if it is disarmed."
                  : "The next batch waits until you inspect and confirm this plate."}
              </p>
              {["PRINTED", "NEEDS_REVIEW"].includes(currentBatch.status) && (
                <button
                  disabled={busy || unresolved}
                  onClick={() => confirmBatch(currentBatch)}
                >
                  Confirm plate & queue next four
                </button>
              )}
              {["DISPATCHING", "PRINTING"].includes(currentBatch.status) &&
                (!gatewayOnline || !dashboard.gateway.active) && (
                  <button
                    disabled={busy}
                    onClick={() => reviewStoppedBatch(currentBatch)}
                  >
                    Review stopped / uncertain job
                  </button>
                )}
              {unresolved && (
                <small>
                  Resolve each Needs review order before confirming this plate.
                </small>
              )}
            </div>
          )}

          <h2>Ready to ship</h2>
          <p className="fineprint">
            These printed orders still need packaging and dispatch. Country and
            contact details stay in the private dashboard.
          </p>
          <div className="shipping-grid">
            {shipping.orders.map((order) => (
              <article key={order.id} className="shipping-card">
                <small>
                  ORDER {order.id.slice(0, 8)} · PLATE{" "}
                  {order.batch_id?.slice(0, 8) || "—"}
                </small>
                {address(order)}
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(`/api/admin/orders/${order.id}/status`, {
                      status: "SHIPPED",
                    })
                  }
                >
                  Mark sent ↗
                </button>
              </article>
            ))}
            {!shipping.orders.length && <p>No prints waiting for dispatch.</p>}
          </div>
          {shipping.nextCursor && (
            <button
              className="subtle"
              disabled={busy}
              onClick={() => void loadMoreShipping()}
            >
              Load more shipping addresses
            </button>
          )}

          <h2>Orders</h2>
          <label>
            Find order by full ID, name or email
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
          </label>
          <div className="admin-actions">
            <button
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              Previous 100
            </button>
            <span>Page {offset / 100 + 1} · current plate always included</span>
            <button disabled={busy} onClick={() => setOffset(offset + 100)}>
              Next 100
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ORDER</th>
                  <th>CUSTOMER & DELIVERY</th>
                  <th>STATUS</th>
                  <th>BATCH</th>
                  <th>TX</th>
                  <th>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <code>{order.id.slice(0, 8)}</code>
                      <small>
                        {new Date(order.created_at).toLocaleString()}
                      </small>
                    </td>
                    <td>{address(order)}</td>
                    <td>
                      <span
                        className={`status status-${order.status.toLowerCase()}`}
                      >
                        {order.status}
                      </span>
                    </td>
                    <td>
                      <code>{order.batch_id?.slice(0, 8) || "—"}</code>
                      <small>{order.batch_status || ""}</small>
                    </td>
                    <td>
                      {order.tx_hash ? (
                        <a
                          href={transactionUrl(order)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Explorer ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {["PRINTED", "SHIPPED"].includes(order.status) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(
                              `/api/admin/orders/${order.id}/status`,
                              { status: "NEEDS_REVIEW" },
                            )
                          }
                        >
                          Needs reprint
                        </button>
                      )}
                      {order.status === "AWAITING_PAYMENT" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(
                              `/api/admin/orders/${order.id}/reconcile`,
                            )
                          }
                        >
                          Reconcile stored payment
                        </button>
                      )}
                      {order.status === "NEEDS_REVIEW" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Physically inspected this object and confirmed it is usable?",
                              )
                            )
                              void action(
                                `/api/admin/orders/${order.id}/status`,
                                { status: "PRINTED" },
                              );
                          }}
                        >
                          Inspected: print OK
                        </button>
                      )}
                      {order.status === "NEEDS_REVIEW" && (
                        <button disabled={busy} onClick={() => requeue(order)}>
                          Return to print queue
                        </button>
                      )}
                      {["PRINTED", "NEEDS_REVIEW"].includes(order.status) && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(
                                `/api/admin/orders/${order.id}/status`,
                                { status: "SHIPPED" },
                              )
                            }
                          >
                            Mark sent
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(
                                `/api/admin/orders/${order.id}/status`,
                                { status: "REFUNDED" },
                              )
                            }
                          >
                            Mark refunded*
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fineprint">
            *Refund status records your action; send ADA separately. A reviewed
            reprint enters a new batch and is never charged again.
          </p>

          <h2>Print batches</h2>
          <div className="batch-list">
            {dashboard.batches.map((batch) => (
              <div key={batch.id}>
                <Package size={21} />
                <strong>{batch.id.slice(0, 8)}</strong>
                <span>{batch.size} objects</span>
                <span>
                  {batch.status}
                  {batch.confirmed_at
                    ? " · confirmed"
                    : batch.id === dashboard.currentBatchId
                      ? " · awaiting operator"
                      : ""}
                </span>
                <small>{batch.printer_filename || "Awaiting gateway"}</small>
              </div>
            ))}
          </div>
          <h2>Payment attempts</h2>
          <div className="batch-list">
            {dashboard.attempts.map((attempt) => (
              <div key={`${attempt.order_id}-${attempt.tx_hash}`}>
                <ShieldCheck size={18} />
                <strong>{attempt.order_id.slice(0, 8)}</strong>
                <span>{attempt.status}</span>
                <small>
                  {attempt.tx_hash.slice(0, 20)}… ·{" "}
                  {new Date(attempt.created_at).toLocaleString()}
                </small>
              </div>
            ))}
          </div>
          <p className="fineprint">
            A signature is not proof of settlement. Reconcile with the
            facilitator and chain before requesting another payment.
          </p>
        </>
      )}
    </main>
  );
}
