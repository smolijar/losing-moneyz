import crypto from "crypto";

export interface CoinmateCredentials {
  clientId: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Generate Coinmate HMAC-SHA256 signature for authenticated API calls.
 *
 * Signature = HMAC_SHA256(privateKey, nonce + clientId + publicKey)
 * The signature is uppercased hex.
 */
export function createSignature(
  credentials: CoinmateCredentials,
  nonce: string,
): { signature: string; nonce: string; clientId: string; publicKey: string } {
  const message = nonce + credentials.clientId + credentials.publicKey;
  const hmac = crypto.createHmac("sha256", credentials.privateKey);
  hmac.update(message);
  const signature = hmac.digest("hex").toUpperCase();

  return {
    signature,
    nonce,
    clientId: credentials.clientId,
    publicKey: credentials.publicKey,
  };
}

/**
 * Generate a nonce (monotonically increasing number).
 * Uses current timestamp in milliseconds.
 */
let lastNonce = 0;
export function generateNonce(): string {
  const now = Date.now();
  lastNonce = now <= lastNonce ? lastNonce + 1 : now;
  return lastNonce.toString();
}
