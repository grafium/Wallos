/*
  Number and date formatting for the web interface, matching the PHP helpers:
  CurrencyFormatter (locale from Accept-Language), index.php's formatPrice()
  and formatDate().
*/

export interface CurrencyInfo {
  id: number;
  code: string;
  symbol: string;
  name?: string;
  rate?: number;
}

/** First locale of an Accept-Language header that Intl understands, else en-US. */
export function localeFromHeader(header: string | null | undefined): string {
  for (const part of (header ?? "").split(",")) {
    const tag = part.split(";")[0]!.trim();
    if (!tag || tag === "*") continue;
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? "en-US";
    } catch {
      continue;
    }
  }
  return "en-US";
}

/**
 * A price in its currency. When Intl does not know the code (custom currencies
 * are allowed), the code in the output is replaced by the currency's symbol.
 */
export function formatPrice(price: number, code: string, currencies: Iterable<CurrencyInfo>, locale = "en-US"): string {
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(price);
  } catch {
    formatted = `${code} ${price.toFixed(2)}`;
  }
  if (formatted.includes(code)) {
    for (const currency of currencies) {
      if (currency.code === code) {
        if (currency.symbol) formatted = formatted.replace(code, currency.symbol);
        break;
      }
    }
  }
  return formatted;
}

/** "Mar 5" within the current year, "Mar 2027" otherwise, in the interface language. */
export function formatDate(date: string, language: string, today = new Date()): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  const sameYear = value.getUTCFullYear() === today.getUTCFullYear();
  const locale = language.replace("_", "-");
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", year: "numeric", timeZone: "UTC" };
  try {
    return new Intl.DateTimeFormat(locale, options).format(value);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(value);
  }
}

export function hexToRgb(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
}
