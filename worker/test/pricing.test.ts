import { describe, expect, it } from "vitest";
import { Cycle } from "../src/lib/dates";
import { convertPrice, formatMoney, pricePerMonth } from "../src/lib/pricing";

describe("pricePerMonth", () => {
  it("uses the same factors as PHP Wallos", () => {
    expect(pricePerMonth(Cycle.Daily, 1, 1)).toBe(30);
    expect(pricePerMonth(Cycle.Weekly, 1, 10)).toBeCloseTo(43.5);
    expect(pricePerMonth(Cycle.Monthly, 3, 30)).toBe(10);
    expect(pricePerMonth(Cycle.Yearly, 1, 120)).toBe(10);
    expect(pricePerMonth(Cycle.OneTime, 1, 500)).toBe(0);
  });
});

describe("convertPrice", () => {
  it("divides by the currency's rate against the main currency", () => {
    expect(convertPrice(400, 400)).toBe(1);
    expect(convertPrice(11, 1.1)).toBeCloseTo(10);
  });

  it("leaves the price unchanged without a usable rate", () => {
    expect(convertPrice(10, 0)).toBe(10);
    expect(convertPrice(10, null)).toBe(10);
  });
});

describe("formatMoney", () => {
  it("formats known currencies and falls back for unknown codes", () => {
    expect(formatMoney(1234.5, "EUR")).toBe("€1,234.50");
    expect(formatMoney(3, "XYZ1")).toBe("3.00 XYZ1");
  });
});
