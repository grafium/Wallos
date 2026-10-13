import { Cycle, type CycleId } from "./dates";

/**
 * Average monthly cost of one subscription, using the same factors as the
 * PHP getPricePerMonth(): 30 days and 4.35 weeks per month.
 */
export function pricePerMonth(cycle: CycleId, frequency: number, price: number): number {
  switch (cycle) {
    case Cycle.Daily:
      return price * (30 / frequency);
    case Cycle.Weekly:
      return price * (4.35 / frequency);
    case Cycle.Monthly:
      return price * (1 / frequency);
    case Cycle.Yearly:
      return price / (12 * frequency);
    case Cycle.OneTime:
      return 0;
  }
}

/**
 * Converts a price into the user's main currency.
 *
 * Wallos stores each currency's rate as "units of this currency per one unit
 * of the main currency", so the main currency itself has rate 1. A missing or
 * zero rate leaves the price unchanged, matching wallos_convert_price().
 */
export function convertPrice(price: number, rate: number | null | undefined): number {
  if (!rate) return price;
  return price / rate;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatMoney(value: number, currencyCode: string, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode }).format(value);
  } catch {
    // Unknown ISO code (custom currencies are allowed in Wallos).
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}
