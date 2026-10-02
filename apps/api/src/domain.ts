export type Env = Record<string, string>;
export type Network = "cardano:mainnet" | "cardano:preprod";
export type Order = {
  id: string;
  access_hash: string;
  status: string;
  network: Network;
  price_lovelace: string;
  tx_hash: string | null;
  signed_tx_hash?: string | null;
  batch_id: string | null;
  created_at: string;
  personal_data_erased_at?: string | null;
};
export const networkFor = (env: Env): Network | null =>
  env.CARDANO_NETWORK === "cardano:mainnet" ||
  env.CARDANO_NETWORK === "cardano:preprod"
    ? env.CARDANO_NETWORK
    : null;
export const sellerIsValid = (env: Env, network: Network) =>
  network === "cardano:mainnet"
    ? /^addr1[0-9a-z]{40,}$/.test(env.SELLER_ADDRESS || "")
    : /^addr_test1[0-9a-z]{40,}$/.test(env.SELLER_ADDRESS || "");
export const error = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
