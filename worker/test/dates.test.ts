import { describe, expect, it } from "vitest";
import { Cycle, isValidDate, paymentDatesInMonth, renewDate, rollForward, shiftDate } from "../src/lib/dates";

describe("isValidDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2023-02-29")).toBe(false);
    expect(isValidDate("2024-13-01")).toBe(false);
    expect(isValidDate("2024-1-01")).toBe(false);
  });
});

describe("shiftDate", () => {
  it("adds days and weeks", () => {
    expect(shiftDate("2024-01-30", Cycle.Daily, 3, 1)).toBe("2024-02-02");
    expect(shiftDate("2024-01-01", Cycle.Weekly, 2, 1)).toBe("2024-01-15");
    expect(shiftDate("2024-01-15", Cycle.Weekly, 1, -2)).toBe("2024-01-01");
  });

  it("keeps month-end billing on the last day instead of overflowing", () => {
    expect(shiftDate("2024-01-31", Cycle.Monthly, 1, 1)).toBe("2024-02-29");
    expect(shiftDate("2024-01-31", Cycle.Monthly, 1, 2)).toBe("2024-03-31");
    expect(shiftDate("2023-01-31", Cycle.Monthly, 1, 1)).toBe("2023-02-28");
    expect(shiftDate("2024-03-31", Cycle.Monthly, 1, -1)).toBe("2024-02-29");
  });

  it("handles multi-month and yearly frequencies", () => {
    expect(shiftDate("2024-11-15", Cycle.Monthly, 3, 1)).toBe("2025-02-15");
    expect(shiftDate("2024-02-29", Cycle.Yearly, 1, 1)).toBe("2025-02-28");
    expect(shiftDate("2024-02-29", Cycle.Yearly, 1, 4)).toBe("2028-02-29");
  });

  it("never moves one-time payments", () => {
    expect(shiftDate("2024-05-05", Cycle.OneTime, 1, 10)).toBe("2024-05-05");
  });
});

describe("rollForward (daily auto-renew job)", () => {
  it("moves an overdue date to the first billing date on or after today", () => {
    expect(rollForward("2024-01-10", Cycle.Monthly, 1, "2024-03-05")).toBe("2024-03-10");
    expect(rollForward("2024-01-10", Cycle.Monthly, 1, "2024-03-10")).toBe("2024-03-10");
    expect(rollForward("2024-01-10", Cycle.Monthly, 1, "2024-03-11")).toBe("2024-04-10");
  });

  it("is a no-op for dates that are not overdue", () => {
    expect(rollForward("2024-06-01", Cycle.Yearly, 1, "2024-03-01")).toBe("2024-06-01");
  });

  it("jumps across years of daily billing without drifting", () => {
    expect(rollForward("2020-01-01", Cycle.Daily, 7, "2024-01-01")).toBe("2024-01-03");
    expect(rollForward("2020-01-01", Cycle.Weekly, 1, "2024-01-01")).toBe("2024-01-03");
  });

  it("keeps the anchor day of month across many months", () => {
    expect(rollForward("2023-01-31", Cycle.Monthly, 1, "2024-04-01")).toBe("2024-04-30");
    expect(rollForward("2023-01-31", Cycle.Monthly, 1, "2024-05-01")).toBe("2024-05-31");
  });
});

describe("renewDate (manual renewal)", () => {
  it("always advances at least one interval", () => {
    expect(renewDate("2024-07-01", Cycle.Monthly, 1, "2024-06-01")).toBe("2024-08-01");
  });

  it("lands strictly after today", () => {
    expect(renewDate("2024-01-01", Cycle.Monthly, 1, "2024-03-01")).toBe("2024-04-01");
    expect(renewDate("2024-01-01", Cycle.Monthly, 1, "2024-02-15")).toBe("2024-03-01");
  });
});

describe("paymentDatesInMonth", () => {
  it("projects monthly billing backwards and forwards", () => {
    expect(paymentDatesInMonth("2024-06-15", Cycle.Monthly, 1, 2024, 3)).toEqual(["2024-03-15"]);
    expect(paymentDatesInMonth("2024-06-15", Cycle.Monthly, 1, 2024, 9)).toEqual(["2024-09-15"]);
  });

  it("returns every weekly payment in the month", () => {
    expect(paymentDatesInMonth("2024-05-01", Cycle.Weekly, 1, 2024, 5)).toEqual([
      "2024-05-01",
      "2024-05-08",
      "2024-05-15",
      "2024-05-22",
      "2024-05-29",
    ]);
  });

  it("skips months without a payment", () => {
    expect(paymentDatesInMonth("2024-01-10", Cycle.Monthly, 3, 2024, 2)).toEqual([]);
    expect(paymentDatesInMonth("2024-01-10", Cycle.Monthly, 3, 2024, 4)).toEqual(["2024-04-10"]);
    expect(paymentDatesInMonth("2024-08-20", Cycle.Yearly, 1, 2025, 8)).toEqual(["2025-08-20"]);
  });

  it("counts one-time payments only in their own month", () => {
    expect(paymentDatesInMonth("2024-08-20", Cycle.OneTime, 1, 2024, 8)).toEqual(["2024-08-20"]);
    expect(paymentDatesInMonth("2024-08-20", Cycle.OneTime, 1, 2024, 9)).toEqual([]);
  });

  it("handles daily billing with a far-future anchor efficiently", () => {
    expect(paymentDatesInMonth("2030-01-01", Cycle.Daily, 10, 2024, 2)).toEqual(["2024-02-02", "2024-02-12", "2024-02-22"]);
  });
});
