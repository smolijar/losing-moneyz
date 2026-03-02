import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { createSignature, generateNonce } from "../../src/coinmate/auth";

describe("createSignature", () => {
  const credentials = {
    clientId: "123",
    publicKey: "myPublicKey",
    privateKey: "mySecretKey",
  };

  it("should produce correct HMAC-SHA256 signature", () => {
    const nonce = "1234567890";
    const result = createSignature(credentials, nonce);

    // Manually compute expected signature
    const message = nonce + credentials.clientId + credentials.publicKey;
    const expected = crypto
      .createHmac("sha256", credentials.privateKey)
      .update(message)
      .digest("hex")
      .toUpperCase();

    expect(result.signature).toBe(expected);
    expect(result.nonce).toBe(nonce);
    expect(result.clientId).toBe(credentials.clientId);
    expect(result.publicKey).toBe(credentials.publicKey);
  });

  it("should produce uppercase hex signature", () => {
    const result = createSignature(credentials, "999");
    expect(result.signature).toMatch(/^[A-F0-9]+$/);
  });

  it("should produce different signatures for different nonces", () => {
    const r1 = createSignature(credentials, "1");
    const r2 = createSignature(credentials, "2");
    expect(r1.signature).not.toBe(r2.signature);
  });

  it("should produce different signatures for different keys", () => {
    const creds2 = { ...credentials, privateKey: "differentKey" };
    const nonce = "123";
    const r1 = createSignature(credentials, nonce);
    const r2 = createSignature(creds2, nonce);
    expect(r1.signature).not.toBe(r2.signature);
  });
});

describe("generateNonce", () => {
  it("should return a numeric string", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^\d+$/);
  });

  it("should be monotonically increasing", () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    const n3 = generateNonce();
    expect(Number(n2)).toBeGreaterThan(Number(n1));
    expect(Number(n3)).toBeGreaterThan(Number(n2));
  });

  it("should remain monotonic even when called rapidly in the same millisecond", () => {
    // Force multiple calls that likely land in same Date.now() ms
    const nonces: string[] = [];
    for (let i = 0; i < 10; i++) {
      nonces.push(generateNonce());
    }
    for (let i = 1; i < nonces.length; i++) {
      expect(Number(nonces[i])).toBeGreaterThan(Number(nonces[i - 1]));
    }
  });
});
