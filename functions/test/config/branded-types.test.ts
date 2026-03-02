import { describe, it, expect } from "vitest";
import {
  PriceCZK,
  AmountBTC,
  AmountCZK,
  CoinmateOrderId,
} from "../../src/config";

describe("branded type constructors", () => {
  it("PriceCZK preserves the numeric value", () => {
    const price = PriceCZK(2_200_000);
    expect(price).toBe(2_200_000);
    // Can be used in arithmetic (structurally a number)
    expect(price + 100).toBe(2_200_100);
  });

  it("AmountBTC preserves the numeric value", () => {
    const amount = AmountBTC(0.00123456);
    expect(amount).toBe(0.00123456);
  });

  it("AmountCZK preserves the numeric value", () => {
    const amount = AmountCZK(50_000);
    expect(amount).toBe(50_000);
  });

  it("CoinmateOrderId preserves the numeric value", () => {
    const id = CoinmateOrderId(12345);
    expect(id).toBe(12345);
  });
});
