import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

// Template texts for an EU (GDPR) / German (§ 5 DDG) operator. They are not
// legal advice: the operator must review them for their own deployment.
type LegalInfo = {
  operator: {
    name: string;
    address: string;
    email: string;
    phone: string;
    vatId: string;
    representative: string;
    register: string;
  };
  supervisoryAuthority: string;
  retentionDays: number;
  network: string | null;
  configured: boolean;
};
export type LegalPage = "privacy" | "imprint";
export const legalPageFor = (path: string): LegalPage | null =>
  path === "/privacy" ? "privacy" : path === "/imprint" ? "imprint" : null;

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const LAST_UPDATED = "2026-10-02";

function Operator({ info }: { info: LegalInfo }) {
  const o = info.operator;
  return (
    <address className="legal-operator">
      {o.name && <strong>{o.name}</strong>}
      {o.address.split("\n").map((line, i) => <span key={i}>{line}</span>)}
      {o.representative && <span>Represented by: {o.representative}</span>}
      {o.email && <span>Email: <a href={`mailto:${o.email}`}>{o.email}</a></span>}
      {o.phone && <span>Phone: {o.phone}</span>}
    </address>
  );
}

function Privacy({ info }: { info: LegalInfo }) {
  const days = info.retentionDays;
  return (
    <>
      <h1>Privacy notice</h1>
      <p className="legal-lead">
        This notice explains which personal data this demo shop processes, why, and
        what rights you have under the EU General Data Protection Regulation (GDPR).
      </p>

      <h2>1. Controller</h2>
      <Operator info={info} />

      <h2>2. About this demo</h2>
      <p>
        This website demonstrates internet-native payments (HTTP 402 / x402) on
        Cardano. The 3D-printed token is free. The ADA payment covers shipping
        and handling only. We collect only the data needed to send you the token.
      </p>

      <h2>3. Visiting the website</h2>
      <p>
        When you open this website, the hosting provider processes your IP address, the
        time of the request, the requested address and your browser's user agent in
        server logs. This is necessary to deliver the website and to protect it
        against abuse and attacks. Legal basis: Art. 6(1)(f) GDPR. Our legitimate
        interest is the secure and stable operation of the service.
      </p>
      <p>
        We use <strong>no cookies, no tracking, no analytics and no advertising</strong>.
        Fonts are served from our own server. To recover an interrupted payment, your
        browser keeps the order number, its access code and the signed payment in
        <em> session storage</em> of the current tab. These stay on your device and are
        deleted when you close the tab. This storage is strictly necessary for the
        service you request (§ 25(2) no. 2 TDDDG).
      </p>

      <h2>4. Placing an order</h2>
      <p>
        For an order we process your name, email address and delivery address
        (street, optional address addition, postal code, city and country), plus the
        order status. We use them to ship the free token and to contact you about
        your order. We send no marketing.
      </p>
      <p>
        Legal basis: Art. 6(1)(b) GDPR (performance of the shipping service you order).
        Providing this data is required to place an order. Without it we cannot
        ship anything, so no order is possible. The checkbox at checkout only
        confirms that you have read this notice and the demo terms. It is not consent
        under Art. 6(1)(a) GDPR.
      </p>

      <h2>5. Payment on the Cardano blockchain</h2>
      <p>
        You pay with your own Cardano wallet extension (CIP-30), which runs in your
        browser. We receive the signed transaction. It contains your wallet addresses
        and the amounts. We forward it to an x402 payment facilitator, which verifies it
        and submits it to the Cardano network. Legal basis: Art. 6(1)(b) GDPR.
      </p>
      <p className="legal-callout">
        <strong>Blockchain transactions are public and permanent.</strong> Once
        submitted, your transaction, wallet addresses and amounts can be viewed
        by anyone and cannot be changed or deleted by us or anyone else. Rights to
        erasure or rectification therefore cannot be exercised for on-chain data.
        We never write your name, email or address to the blockchain.
      </p>
      <p>
        To show payment and confirmation status, your browser and our server query
        a blockchain data provider (Blockfrost) for public chain data. That provider
        sees the IP address of the request.
      </p>

      <h2>6. Recipients</h2>
      <ul>
        <li>Hosting and database providers that run this instance on our behalf (for the hosted version: Cloudflare, Inc. and Neon, Inc., USA), as processors under Art. 28 GDPR.</li>
        <li>The x402 payment facilitator and the blockchain data provider, for the signed transaction and public chain data.</li>
        <li>The postal or parcel carrier, for your name and delivery address.</li>
      </ul>
      <p>
        The printer and its home gateway never receive your name, email or address.
        Where a provider is located outside the EU/EEA (in particular the USA),
        transfers are based on the EU–US Data Privacy Framework or the EU Standard
        Contractual Clauses (Art. 45, 46 GDPR).
      </p>

      <h2>7. Retention</h2>
      <p>
        Your name, email and delivery address are erased automatically{" "}
        <strong>{days} days</strong> after your order was shipped or refunded.
        Unpaid orders accept payment for {days} days minus 12 hours; if no payment was
        submitted, they are erased {days} days after creation. If a payment was
        submitted but never confirmed, its delivery data is not erased automatically,
        because that payment may still arrive on-chain. Once the payment is resolved,
        contact us and we will erase it. The order
        number, country, amount, status and transaction hash are kept as payment
        evidence (Art. 6(1)(c) and (f) GDPR: proof of payment, statutory accounting
        duties and fraud prevention). Where statutory retention duties (for
        example under tax law) require it, we keep only the data that duty
        requires, for as long as it requires. Server logs are kept according to the
        hosting provider's log retention.
      </p>

      <h2>8. Your rights</h2>
      <p>
        You have the right to access (Art. 15), rectification (Art. 16), erasure
        (Art. 17), restriction of processing (Art. 18) and data portability (Art.
        20). Contact us using the details in section 1. You also have the right to
        lodge a complaint with a supervisory authority (Art. 77 GDPR)
        {info.supervisoryAuthority ? `, for example ${info.supervisoryAuthority}` : ""}.
      </p>
      <div className="legal-callout">
        <h2>9. Right to object (Art. 21 GDPR)</h2>
        <p>
          <strong>
            Where we process your data on the basis of legitimate interests (Art.
            6(1)(f) GDPR), you have the right to object at any time, on grounds
            relating to your particular situation. We will then stop processing,
            unless we can demonstrate compelling legitimate grounds that override your
            interests, rights and freedoms, or the processing serves the
            establishment, exercise or defence of legal claims.
          </strong>
        </p>
      </div>

      <h2>10. No automated decisions</h2>
      <p>We do not use automated decision-making or profiling (Art. 22 GDPR).</p>

      <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
    </>
  );
}

function Imprint({ info }: { info: LegalInfo }) {
  const o = info.operator;
  return (
    <>
      <h1>Imprint</h1>
      <p className="legal-lead">Information according to § 5 DDG.</p>
      <Operator info={info} />
      {o.register && <p>Register entry: {o.register}</p>}
      {o.vatId && <p>VAT identification number (§ 27a UStG): {o.vatId}</p>}
      <h2>About this website</h2>
      <p>
        This website is a technology demonstration of x402 payments on Cardano.
        The 3D-printed token is free. The ADA payment covers shipping and
        handling only. The source code is public. Customer data is never part of it.
      </p>
    </>
  );
}

export function Legal({ page, onClose }: { page: LegalPage; onClose: () => void }) {
  const [info, setInfo] = useState<LegalInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
    fetch(`${API}/api/legal`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setInfo)
      .catch(() => setFailed(true));
  }, []);
  return (
    <main className="legal shell">
      <button className="text-link legal-back" type="button" onClick={onClose}>
        <ArrowLeft size={16} /> Back to the shop
      </button>
      {failed && (
        <div className="availability-note" role="alert">
          The legal details could not be loaded. Please try again shortly.
        </div>
      )}
      {info && !info.configured && (
        <div className="testnet-warning" role="alert">
          <strong>Operator details are not configured.</strong>
          <p>The operator must set OPERATOR_NAME, OPERATOR_ADDRESS and OPERATOR_EMAIL before this shop is used publicly.</p>
        </div>
      )}
      {info && (page === "privacy" ? <Privacy info={info} /> : <Imprint info={info} />)}
    </main>
  );
}
